import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';

test('creation retries survive restarts, reject changed input, and do not recreate deleted records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kolo-idempotency-'));
  const path = join(dir, 'test.sqlite');
  let db = openDb(path);
  try {
    let app = createApp(db);
    const login = await request(app).post('/api/auth/register').send({ email: 'alice@example.com', nickname: 'Alice' }).expect(200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const bob = await request(app).post('/api/auth/register').send({ email: 'bob@example.com', nickname: 'Bob' }).expect(200);
    const bobCookie = bob.headers['set-cookie'][0].split(';')[0];
    const group = (await request(app).post('/api/groups').set('Cookie', cookie).send({ name: 'Trip' }).expect(201)).body;
    const base = '/api/groups/' + group.id;
    const a = (await request(app).get(base).set('Cookie', cookie)).body.participants[0].id;
    const b = (await request(app).post(base + '/participants').set('Cookie', cookie).send({ email: 'bob@example.com' }).expect(201)).body.id;
    const expense = { description: 'Dinner', amount: 1001, date: '2026-01-01', payerId: a, participantIds: [a, b] };
    const repayment = { fromId: b, toId: a, amount: 100, date: '2026-01-02' };
    const inputs = { expenses: expense, repayments: repayment };
    const saved: Record<string, any> = {};
    for (const [kind, input] of Object.entries(inputs)) {
      // The same key is independent for each endpoint.
      const responses = await Promise.all([0, 1].map(() => request(app).post(base + '/' + kind).set('Cookie', cookie).set('Idempotency-Key', 'save-1').send(input).expect(201)));
      assert.deepEqual(responses[0].body, responses[1].body);
      saved[kind] = responses[0].body;
      await request(app).post(base + '/' + kind).set('Cookie', cookie).set('Idempotency-Key', 'save-1').send({ ...input, amount: 2000 }).expect(409);
    }
    db.close();
    db = openDb(path);
    app = createApp(db);
    for (const [kind, input] of Object.entries(inputs)) {
      const retry = await request(app).post(base + '/' + kind).set('Cookie', cookie).set('Idempotency-Key', 'save-1').send(input).expect(201);
      assert.deepEqual(retry.body, saved[kind]);
    }
    let detail = (await request(app).get(base).set('Cookie', cookie).expect(200)).body;
    assert.equal(detail.expenses.length, 1);
    assert.equal(detail.repayments.length, 1);
    assert.deepEqual(detail.balances.map((b: { amount: number }) => b.amount), [400, -400]);
    // Another member may independently submit an identical real expense.
    const other = await request(app).post(base + '/expenses').set('Cookie', bobCookie).set('Idempotency-Key', 'save-1').send(expense).expect(201);
    assert.notEqual(other.body.id, saved.expenses.id);
    for (const [kind, input] of Object.entries(inputs)) {
      await request(app).delete(base + '/' + kind + '/' + saved[kind].id).set('Cookie', cookie).expect(204);
      const retry = await request(app).post(base + '/' + kind).set('Cookie', cookie).set('Idempotency-Key', 'save-1').send(input).expect(201);
      assert.deepEqual(retry.body, saved[kind]);
    }
    detail = (await request(app).get(base).set('Cookie', cookie)).body;
    assert.equal(detail.expenses.length, 1);
    assert.equal(detail.repayments.length, 0);
    await request(app).post(base + '/expenses').set('Idempotency-Key', 'save-1').send(expense).expect(401);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed writes leave neither partial expenses nor consumed keys', async () => {
  const db = openDb(':memory:');
  try {
    const app = createApp(db);
    const agent = request.agent(app);
    await agent.post('/api/auth/register').send({ email: 'alice@example.com', nickname: 'Alice' });
    const group = (await agent.post('/api/groups').send({ name: 'Trip' })).body;
    const base = '/api/groups/' + group.id;
    const a = (await agent.get(base)).body.participants[0].id;
    const input = { description: 'Dinner', amount: 100, date: '2026-01-01', payerId: a, participantIds: [a] };
    await agent.post(base + '/expenses').set('Idempotency-Key', 'retry').send({ ...input, payerId: 'outsider' }).expect(400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get()?.n, 0);
    await agent.post(base + '/expenses').set('Idempotency-Key', 'retry').send(input).expect(201);
    // Fail after the expense and shares have been inserted, while storing its result.
    db.exec("CREATE TRIGGER fail_key BEFORE INSERT ON idempotency_keys WHEN NEW.key = 'fail' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;");
    await agent.post(base + '/expenses').set('Idempotency-Key', 'fail').send(input).expect(500);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expenses').get()?.n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shares').get()?.n, 1);
    db.exec('DROP TRIGGER fail_key');
    await agent.post(base + '/expenses').set('Idempotency-Key', 'fail').send(input).expect(201);
    await agent.post(base + '/expenses').set('Idempotency-Key', 'bad key').send(input).expect(400);
    const preflight = await agent.options(base + '/expenses').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Headers', 'Content-Type, Idempotency-Key').expect(204);
    assert.match(preflight.headers['access-control-allow-headers'], /Idempotency-Key/);
  } finally { db.close(); }
});
