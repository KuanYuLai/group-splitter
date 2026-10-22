import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';
test('balances use persisted shares until an expense is edited', async () => {
  const db = openDb(':memory:');
  try {
    const app = createApp(db);
    const alice = request.agent(app);
    await alice.post('/api/auth/register').send({ email: 'alice@example.com', nickname: 'Alice' }).expect(200);
    const group = (await alice.post('/api/groups').send({ name: 'Trip' }).expect(201)).body;
    const base = '/api/groups/' + group.id;
    const a = (await alice.get(base).expect(200)).body.participants[0].id;
    const ids = [a];
    for (const name of ['Bob', 'Carol']) {
      const email = name.toLowerCase() + '@example.com';
      await request(app).post('/api/auth/register').send({ email, nickname: name }).expect(200);
      ids.push((await alice.post(base + '/participants').send({ email }).expect(201)).body.id);
    }
    const input = { description: 'Dinner', date: '2026-01-01', amount: 10_000, payerId: a, participantIds: ids };
    const expense = (await alice.post(base + '/expenses').send(input).expect(201)).body;
    // Model a historical allocation that gave the extra cent to Carol.
    db.prepare('UPDATE shares SET amount = ? WHERE expenseId = ? AND participantId = ?').run(3333, expense.id, a);
    db.prepare('UPDATE shares SET amount = ? WHERE expenseId = ? AND participantId = ?').run(3334, expense.id, ids[2]);
    const detail = (await alice.get(base).expect(200)).body;
    assert.deepEqual(detail.balances.map((b: { amount: number }) => b.amount), [6667, -3333, -3334]);
    assert.deepEqual(detail.transfers, [
      { fromId: ids[1], toId: a, amount: 3333 },
      { fromId: ids[2], toId: a, amount: 3334 },
    ]);
    for (const transfer of detail.transfers) {
      await alice.post(base + '/repayments').send({ ...transfer, date: '2026-01-02' }).expect(201);
    }
    const settled = (await alice.get(base).expect(200)).body;
    assert.deepEqual(settled.balances.map((b: { amount: number }) => b.amount), [0, 0, 0]);
    assert.deepEqual(settled.transfers, []);
    for (const repayment of settled.repayments) {
      await alice.delete(base + '/repayments/' + repayment.id).expect(204);
    }
    await alice.put(base + '/expenses/' + expense.id).send(input).expect(200);
    assert.deepEqual((await alice.get(base).expect(200)).body.balances.map((b: { amount: number }) => b.amount), [6666, -3333, -3333]);
    await alice.delete(base + '/expenses/' + expense.id).expect(204);
    assert.deepEqual((await alice.get(base).expect(200)).body.balances.map((b: { amount: number }) => b.amount), [0, 0, 0]);
  } finally { db.close(); }
});

test('complete group flow, validation, ownership, logout and persistent data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kolo-')); const path = join(dir, 'test.sqlite');
  let db = openDb(path);
  try {
    const app = createApp(db); const alice = request.agent(app); const bob = request.agent(app);
    await alice.get('/api/groups').expect(401);
    await alice.post('/api/auth/register').send({ email: 'invalid', nickname: 'A' }).expect(400);
    const login = await alice.post('/api/auth/register').send({ email: 'ALICE@example.com', nickname: 'Alice' }).expect(200);
    assert.equal(login.body.email, 'alice@example.com'); assert.match(login.headers['set-cookie'][0], /HttpOnly/);
    const group = (await alice.post('/api/groups').send({ name: 'Trip' }).expect(201)).body;
    const base = '/api/groups/' + group.id;
    let detail = (await alice.get(base).expect(200)).body; const a = detail.participants[0].id;
    await bob.post('/api/auth/register').send({ email: 'bob@example.com', nickname: 'Bob' }).expect(200);
    await bob.get(base).expect(404);
    assert.equal((await bob.get('/api/groups')).body.length, 0);
    await alice.post(base + '/participants').send({ email: 'missing@example.com' }).expect(404);
    await alice.post(base + '/participants').send({ email: 'invalid' }).expect(400);
    const b = (await alice.post(base + '/participants').send({ email: ' BOB@example.com ' }).expect(201)).body.id;
    await alice.post(base + '/participants').send({ email: 'bob@example.com' }).expect(409);
    assert.equal((await bob.get('/api/groups')).body[0].id, group.id);
    await bob.get(base).expect(200);
    await bob.patch(base).send({ name: 'Forbidden' }).expect(403);
    await bob.post(base + '/participants').send({ email: 'alice@example.com' }).expect(403);
    await bob.delete(base + '/participants/' + a).expect(403);
    await alice.delete(base + '/participants/' + a).expect(400);
    const expenseInput = { description: 'Dinner', date: '2026-01-01', amount: 1001, payerId: a, participantIds: [b, a] };
    await alice.post(base + '/expenses').send({ ...expenseInput, date: '2026-02-30' }).expect(400);
    await alice.post(base + '/expenses').send({ ...expenseInput, amount: 1.5 }).expect(400);
    await alice.post(base + '/expenses').send({ ...expenseInput, participantIds: [b, b] }).expect(400);
    await alice.post(base + '/expenses').send({ ...expenseInput, payerId: 'outsider' }).expect(400);
    const expense = (await alice.post(base + '/expenses').send(expenseInput).expect(201)).body;
    await alice.delete(base + '/participants/' + b).expect(400);
    const carol = request.agent(app);
    await carol.post('/api/auth/register').send({ email: 'carol@example.com', nickname: 'Carol' }).expect(200);
    await alice.post(base + '/participants').send({ email: 'carol@example.com' }).expect(201);
    detail = (await alice.get(base)).body;
    assert.deepEqual(detail.balances.map((v: { amount: number }) => v.amount), [500, -500, 0]);
    const repayment = (await alice.post(base + '/repayments').send({ fromId: b, toId: a, amount: 500, date: '2026-01-02' }).expect(201)).body;
    assert.equal((await alice.get(base)).body.transfers.length, 0);
    await alice.delete(base + '/repayments/' + repayment.id).expect(204);
    await alice.put(base + '/expenses/' + expense.id).send({ ...expenseInput, amount: 2000 }).expect(200);
    assert.equal((await alice.get(base)).body.transfers[0].amount, 1000);
    await bob.put(base + '/expenses/' + expense.id).send({ ...expenseInput, amount: 2000 }).expect(200);
    const memberExpense = (await bob.post(base + '/expenses').send(expenseInput).expect(201)).body;
    await bob.delete(base + '/expenses/' + memberExpense.id).expect(204);
    const outsider = request.agent(app);
    await outsider.post('/api/auth/register').send({ email: 'outsider@example.com', nickname: 'Outsider' }).expect(200);
    await outsider.get(base).expect(404);
    await outsider.put(base + '/expenses/' + expense.id).send(expenseInput).expect(404);
    await outsider.delete(base + '/expenses/' + expense.id).expect(404);
    const carolId = detail.participants.find((p: { email: string }) => p.email === 'carol@example.com').id;
    await alice.delete(base + '/participants/' + carolId).expect(204);
    await carol.get(base).expect(404);
    assert.equal((await carol.get('/api/groups')).body.length, 0);
    await alice.patch(base).send({ name: 'Summer trip' }).expect(200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    db.close(); db = openDb(path);
    const reopened = request(createApp(db));
    const persisted = (await reopened.get(base).set('Cookie', cookie).expect(200)).body;
    assert.equal(persisted.group.name, 'Summer trip'); assert.equal(persisted.expenses[0].amount, 2000);
    await reopened.delete(base + '/expenses/' + expense.id).set('Cookie', cookie).expect(204);
    assert.equal((await reopened.get(base).set('Cookie', cookie)).body.transfers.length, 0);
    await reopened.post('/api/auth/logout').set('Cookie', cookie).expect(204);
    await reopened.get('/api/auth/me').set('Cookie', cookie).expect(401);
    await reopened.post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: 'a@example.com', nickname: 'A' }).expect(403);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('localhost CORS supports preflight, credentialed login, and rejects unrelated origins', async () => {
  const db = openDb(':memory:');
  try {
    const app = createApp(db);
    await request(app).post('/api/auth/register').send({ email: 'local@example.com', nickname: 'Local' }).expect(200);
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']) {
      const preflight = await request(app).options('/api/auth/login')
        .set('Origin', origin).set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type').expect(204);
      assert.equal(preflight.headers['access-control-allow-origin'], origin);
      assert.equal(preflight.headers['access-control-allow-credentials'], 'true');
      assert.match(preflight.headers.vary, /Origin/);
      const login = await request(app).post('/api/auth/login').set('Origin', origin)
        .send({ email: 'local@example.com', nickname: 'Local' }).expect(200);
      assert.equal(login.headers['access-control-allow-origin'], origin);
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      await request(app).get('/api/auth/me').set('Origin', origin).set('Cookie', cookie).expect(200);
    }
    for (const origin of ['http://localhost.evil.example:5173', 'https://evil.example', 'null', 'invalid']) {
      const response = await request(app).post('/api/auth/login').set('Origin', origin)
        .send({ email: 'local@example.com', nickname: 'Local' }).expect(403);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
  } finally { db.close(); }
});

test('migration preserves legacy records without granting access based on a nickname', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kolo-migration-'));
  const path = join(dir, 'legacy.sqlite');
  let db = openDb(path);
  try {
    // Recreate the original participant schema to model a pre-membership database.
    db.exec(`
      DROP INDEX participant_user_per_group;
      DROP TABLE idempotency_keys;
      ALTER TABLE participants DROP COLUMN userId;
      PRAGMA user_version = 1;
      INSERT INTO users VALUES ('owner', 'owner@example.com', 'Alex');
      INSERT INTO users VALUES ('other', 'other@example.com', 'Alex');
      INSERT INTO groups VALUES ('g', 'owner', 'Old group', '2026-01-01');
      INSERT INTO participants VALUES ('legacy', 'g', 'Alex');
      INSERT INTO expenses VALUES ('e', 'g', 'Lunch', '2026-01-01', 100, 'legacy');
      INSERT INTO shares VALUES ('e', 'legacy', 100);
    `);
    db.close(); db = openDb(path);
    assert.equal(db.prepare('SELECT userId FROM participants WHERE id = ?').get('legacy')?.userId, null);
    assert.equal(db.prepare('SELECT userId FROM participants WHERE id = ?').get('owner-g')?.userId, 'owner');
    assert.equal(db.prepare('SELECT amount FROM shares WHERE expenseId = ?').get('e')?.amount, 100);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM participants WHERE userId = ?').get('other')?.count, 0);
    db.close(); db = openDb(path);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM participants').get()?.count, 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('email-first login requires registration for new users and preserves existing nicknames', async () => {
  const db = openDb(':memory:');
  try {
    const agent = request.agent(createApp(db));
    const unknown = await agent.post('/api/auth/login').send({ email: ' NEW@example.com ' }).expect(200);
    assert.deepEqual(unknown.body, { registrationRequired: true });
    assert.equal(unknown.headers['set-cookie'], undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get()?.count, 0);
    await agent.get('/api/auth/me').expect(401);
    await agent.post('/api/auth/login').send({ email: 'invalid' }).expect(400);
    await agent.post('/api/auth/register').send({ email: 'new@example.com', nickname: ' ' }).expect(400);
    const registered = await agent.post('/api/auth/register').send({ email: 'NEW@example.com', nickname: ' New person ' }).expect(200);
    assert.equal(registered.body.nickname, 'New person');
    assert.equal(registered.body.email, 'new@example.com');
    await agent.get('/api/auth/me').expect(200);
    await agent.post('/api/auth/register').send({ email: 'new@example.com', nickname: 'Other' }).expect(409);
    await agent.post('/api/auth/logout').expect(204);
    const login = await agent.post('/api/auth/login').send({ email: 'NEW@example.com' }).expect(200);
    assert.equal(login.body.id, registered.body.id);
    assert.equal(login.body.nickname, 'New person');
    const unchanged = await agent.post('/api/auth/login').send({ email: 'new@example.com', nickname: 'Changed' }).expect(200);
    assert.equal(unchanged.body.nickname, 'New person');
  } finally { db.close(); }
});
