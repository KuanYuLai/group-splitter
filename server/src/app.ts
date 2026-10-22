import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { User, Group, Participant, Expense, Repayment } from '../../shared/types.js';
import { calculate, split, type ExpenseWithShares } from './money.js';

const name = z.string().trim().min(1).max(80);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(v); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, 'Invalid date');
const amount = z.number().int().positive().max(100_000_000);
const expenseSchema = z.object({ description: name, date, amount, payerId: z.string(), participantIds: z.array(z.string()).min(1).refine(v => new Set(v).size === v.length) });
const repaymentSchema = z.object({ fromId: z.string(), toId: z.string(), amount, date }).refine(v => v.fromId !== v.toId, 'Choose different participants');
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function createApp(db: DatabaseSync) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    const localOrigin = !!origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(origin);
    res.vary('Origin');
    if (localOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin!);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
      if (req.method === 'OPTIONS') return res.status(204).end();
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      let sameOrigin = false;
      try { sameOrigin = !!origin && new URL(origin).origin === `${req.protocol}://${req.headers.host}`; } catch { /* Invalid origins are rejected below. */ }
      if (!localOrigin && (req.headers['sec-fetch-site'] === 'cross-site' || (origin && !sameOrigin))) return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  const token = (req: Request) => req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('kolo_session='))?.slice(13);
  const currentUser = (req: Request): User => {
    const user = db.prepare('SELECT users.* FROM users JOIN sessions ON users.id = sessions.userId WHERE sessions.id = ? AND sessions.expires > ?').get(token(req) ?? '', Date.now()) as unknown as User;
    if (!user) throw new HttpError(401, 'Please sign in');
    return user;
  };
  const groupFor = (req: Request) => {
    const user = currentUser(req);
    const group = db.prepare('SELECT id, name, createdAt, ownerId FROM groups WHERE id = ? AND (ownerId = ? OR EXISTS (SELECT 1 FROM participants WHERE groupId = groups.id AND userId = ?))').get(String(req.params.groupId), user.id, user.id) as unknown as Group;
    if (!group) throw new HttpError(404, 'Group not found');
    return group;
  };
  const ownedGroupFor = (req: Request) => {
    const group = groupFor(req);
    if (group.ownerId !== currentUser(req).id) throw new HttpError(403, 'Only the group creator can manage this group');
    return group;
  };
  const members = (id: string) => db.prepare('SELECT p.id, p.groupId, COALESCE(u.nickname, p.name) AS name, p.userId, u.email FROM participants p LEFT JOIN users u ON u.id = p.userId WHERE p.groupId = ? ORDER BY p.rowid').all(id) as unknown as Participant[];
  const transaction = (fn: () => void) => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };
  // Persist the result atomically with the write, including across server restarts.
  const createOnce = (req: Request, res: Response, input: unknown, create: () => unknown) => {
    const header = req.get('Idempotency-Key');
    const key = header === undefined ? undefined : z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(header);
    const userId = currentUser(req).id;
    const payload = JSON.stringify(input);
    let response: unknown;
    transaction(() => {
      if (key) {
        const saved = db.prepare('SELECT request, response FROM idempotency_keys WHERE userId = ? AND path = ? AND key = ?').get(userId, req.path, key) as { request: string; response: string } | undefined;
        if (saved) {
          if (saved.request !== payload) throw new HttpError(409, 'This save already succeeded with different values. Close the form and edit the saved record.');
          response = JSON.parse(saved.response);
          return;
        }
      }
      response = create();
      if (key) db.prepare('INSERT INTO idempotency_keys VALUES (?, ?, ?, ?, ?)').run(userId, req.path, key, payload, JSON.stringify(response));
    });
    res.status(201).json(response);
  };
  const startSession = (req: Request, res: Response, user: User) => {
    if (token(req)) db.prepare('DELETE FROM sessions WHERE id = ?').run(token(req)!);
    db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    const session = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(session, user.id, Date.now() + 30 * 86400_000);
    res.cookie('kolo_session', session, { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 30 * 86400_000, path: '/' }).json(user);
  };
  const email = z.string().trim().email().max(254).transform(v => v.toLowerCase());
  app.post('/api/auth/login', (req, res) => {
    const input = z.object({ email }).parse(req.body);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(input.email) as unknown as User | undefined;
    if (!user) return res.json({ registrationRequired: true });
    startSession(req, res, user);
  });
  app.post('/api/auth/register', (req, res) => {
    const input = z.object({ email, nickname: name }).parse(req.body);
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(input.email)) throw new HttpError(409, 'This email is already registered. Use Login instead.');
    const user: User = { id: randomUUID(), ...input };
    db.prepare('INSERT INTO users VALUES (?, ?, ?)').run(user.id, user.email, user.nickname);
    startSession(req, res, user);
  });
  app.get('/api/auth/me', (req, res) => res.json(currentUser(req)));
  app.post('/api/auth/logout', (req, res) => { db.prepare('DELETE FROM sessions WHERE id = ?').run(token(req) ?? ''); res.clearCookie('kolo_session', { path: '/' }).status(204).end(); });
  app.get('/api/groups', (req, res) => {
    const user = currentUser(req);
    res.json(db.prepare('SELECT id, name, createdAt, ownerId FROM groups WHERE ownerId = ? OR EXISTS (SELECT 1 FROM participants WHERE groupId = groups.id AND userId = ?) ORDER BY rowid DESC').all(user.id, user.id));
  });
  app.post('/api/groups', (req, res) => {
    const user = currentUser(req); const input = z.object({ name }).parse(req.body);
    const group: Group = { id: randomUUID(), ownerId: user.id, name: input.name, createdAt: new Date().toISOString() };
    transaction(() => { db.prepare('INSERT INTO groups VALUES (?, ?, ?, ?)').run(group.id, user.id, group.name, group.createdAt); db.prepare('INSERT INTO participants (id, groupId, name, userId) VALUES (?, ?, ?, ?)').run(randomUUID(), group.id, user.nickname, user.id); });
    res.status(201).json(group);
  });
  app.patch('/api/groups/:groupId', (req, res) => { const group = ownedGroupFor(req); const input = z.object({ name }).parse(req.body); db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(input.name, group.id); res.json({ ...group, ...input }); });
  app.get('/api/groups/:groupId', (req, res) => {
    const group = groupFor(req); const participants = members(group.id);
    const expenses = (db.prepare('SELECT * FROM expenses WHERE groupId = ? ORDER BY date DESC, rowid DESC').all(group.id) as unknown as Expense[]).map(e => {
      const shares = db.prepare('SELECT participantId, amount FROM shares WHERE expenseId = ?').all(e.id) as unknown as ExpenseWithShares['shares'];
      return { ...e, participantIds: shares.map(s => s.participantId), shares };
    });
    const repayments = db.prepare('SELECT * FROM repayments WHERE groupId = ? ORDER BY date DESC, rowid DESC').all(group.id) as unknown as Repayment[];
    res.json({ group, participants, expenses: expenses.map(({ shares, ...expense }) => expense), repayments, ...calculate(participants, expenses, repayments) });
  });
  app.post('/api/groups/:groupId/participants', (req, res) => {
    const group = ownedGroupFor(req);
    const input = z.object({ email: z.string().trim().email().max(254).transform(v => v.toLowerCase()) }).parse(req.body);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(input.email) as unknown as User | undefined;
    if (!user) throw new HttpError(404, 'No user found with this email. Ask them to sign in to Kolo first.');
    if (members(group.id).some(p => p.userId === user.id)) throw new HttpError(409, 'This user is already in the group');
    const participant: Participant = { id: randomUUID(), groupId: group.id, name: user.nickname, userId: user.id, email: user.email };
    db.prepare('INSERT INTO participants (id, groupId, name, userId) VALUES (?, ?, ?, ?)').run(participant.id, group.id, participant.name, user.id);
    res.status(201).json(participant);
  });
  app.delete('/api/groups/:groupId/participants/:id', (req, res) => {
    const group = ownedGroupFor(req); const id = String(req.params.id);
    if (!members(group.id).some(p => p.id === id)) throw new HttpError(404, 'Participant not found');
    if (members(group.id).find(p => p.id === id)?.userId === group.ownerId) throw new HttpError(400, 'The group creator cannot be removed');
    if (members(group.id).length === 1) throw new HttpError(400, 'Keep at least one participant');
    const used = db.prepare('SELECT 1 FROM expenses WHERE payerId = ? UNION ALL SELECT 1 FROM shares WHERE participantId = ? UNION ALL SELECT 1 FROM repayments WHERE fromId = ? OR toId = ? LIMIT 1').get(id, id, id, id);
    if (used) throw new HttpError(400, 'Participants with financial history cannot be removed');
    db.prepare('DELETE FROM participants WHERE id = ?').run(id); res.status(204).end();
  });
  const saveExpense = (req: Request, res: Response) => {
    const group = groupFor(req); const input = expenseSchema.parse(req.body); const participants = members(group.id);
    const id = req.params.id ? String(req.params.id) : randomUUID();
    if (req.params.id && !db.prepare('SELECT id FROM expenses WHERE id = ? AND groupId = ?').get(id, group.id)) throw new HttpError(404, 'Expense not found');
    const write = () => {
      if (![input.payerId, ...input.participantIds].every(id => participants.some(p => p.id === id))) throw new HttpError(400, 'Choose participants from this group');
      if (req.params.id) db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
      db.prepare('INSERT INTO expenses VALUES (?, ?, ?, ?, ?, ?)').run(id, group.id, input.description, input.date, input.amount, input.payerId);
      for (const share of split(input.amount, participants.filter(p => input.participantIds.includes(p.id)).map(p => p.id))) db.prepare('INSERT INTO shares VALUES (?, ?, ?)').run(id, share.id, share.amount);
      return { id, groupId: group.id, ...input };
    };
    if (!req.params.id) return createOnce(req, res, input, write);
    transaction(write);
    res.status(200).json({ id, groupId: group.id, ...input });
  };
  app.post('/api/groups/:groupId/expenses', saveExpense);
  app.put('/api/groups/:groupId/expenses/:id', saveExpense);
  app.delete('/api/groups/:groupId/expenses/:id', (req, res) => { const group = groupFor(req); const result = db.prepare('DELETE FROM expenses WHERE id = ? AND groupId = ?').run(String(req.params.id), group.id); if (!result.changes) throw new HttpError(404, 'Expense not found'); res.status(204).end(); });
  app.post('/api/groups/:groupId/repayments', (req, res) => {
    const group = groupFor(req); const input = repaymentSchema.parse(req.body);
    createOnce(req, res, input, () => {
      if (![input.fromId, input.toId].every(id => members(group.id).some(p => p.id === id))) throw new HttpError(400, 'Choose participants from this group');
      const id = randomUUID(); db.prepare('INSERT INTO repayments VALUES (?, ?, ?, ?, ?, ?)').run(id, group.id, input.fromId, input.toId, input.amount, input.date);
      return { id, groupId: group.id, ...input };
    });
  });
  app.delete('/api/groups/:groupId/repayments/:id', (req, res) => { const group = groupFor(req); const result = db.prepare('DELETE FROM repayments WHERE id = ? AND groupId = ?').run(String(req.params.id), group.id); if (!result.changes) throw new HttpError(404, 'Repayment not found'); res.status(204).end(); });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found' }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err); res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}
