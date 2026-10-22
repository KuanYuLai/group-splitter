import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate, split } from './money.js';
const participants = ['a', 'b', 'c'].map(id => ({ id, name: id, groupId: 'g', userId: null, email: null }));
test('splits preserve cents and allocate remainders in stable order', () => {
  assert.deepEqual(split(10_000, ['a', 'b', 'c']).map(s => s.amount), [3334, 3333, 3333]);
  assert.deepEqual(split(10_001, ['a', 'b', 'c']).map(s => s.amount), [3334, 3334, 3333]);
  assert.deepEqual(split(10_002, ['a', 'b', 'c']).map(s => s.amount), [3334, 3334, 3334]);
  assert.deepEqual(split(10_000, ['a']).map(s => s.amount), [10_000]);
  assert.deepEqual(split(100, ['a', 'b', 'c']).map(s => s.amount), [34, 33, 33]);
  assert.deepEqual(split(1, ['a', 'b', 'c']).map(s => s.amount), [1, 0, 0]);
  assert.throws(() => split(10, []));
});
test('invalid amounts and duplicate participants are rejected', () => {
  for (const amount of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => split(amount, ['a', 'b']));
  }
  assert.throws(() => split(100, ['a', 'a']));
});
test('splits conserve money and differ by at most one cent across group sizes', () => {
  for (let count = 1; count <= 25; count++) {
    const ids = Array.from({ length: count }, (_, i) => String(i));
    for (const amount of [1, 2, 99, 100, 10_000, 10_001, 100_000_000, Number.MAX_SAFE_INTEGER]) {
      const shares = split(amount, ids).map(s => s.amount);
      assert.equal(shares.reduce((sum, share) => sum + share, 0), amount);
      assert.ok(shares.every(share => Number.isSafeInteger(share) && share >= 0));
      assert.ok(Math.max(...shares) - Math.min(...shares) <= 1);
    }
  }
});
test('$100 split three ways settles exactly regardless of which participant paid', () => {
  for (const payerId of ['a', 'b', 'c']) {
    const expenses = [{ id: 'e', groupId: 'g', description: 'Dinner', date: '2026-01-01', amount: 10_000, payerId, participantIds: ['c', 'b', 'a'], shares: [{ participantId: 'a', amount: 3334 }, { participantId: 'b', amount: 3333 }, { participantId: 'c', amount: 3333 }] }];
    const result = calculate(participants, expenses, []);
    assert.deepEqual(result.balances.map(b => b.amount), participants.map((p, i) => (p.id === payerId ? 10_000 : 0) - [3334, 3333, 3333][i]));
    assert.equal(result.balances.reduce((sum, b) => sum + b.amount, 0), 0);
    const repayments = result.transfers.map((t, i) => ({ ...t, id: String(i), groupId: 'g', date: '2026-01-02' }));
    const settled = calculate(participants, expenses, repayments);
    assert.deepEqual(settled.balances.map(b => b.amount), [0, 0, 0]);
    assert.deepEqual(settled.transfers, []);
  }
});
test('payer can be excluded and repayments settle balances', () => {
  const expenses = [{ id: 'e', groupId: 'g', description: 'Dinner', date: '2026-01-01', amount: 1000, payerId: 'a', participantIds: ['b', 'c'], shares: [{ participantId: 'b', amount: 500 }, { participantId: 'c', amount: 500 }] }];
  const result = calculate(participants, expenses, []);
  assert.deepEqual(result.balances.map(b => b.amount), [1000, -500, -500]);
  assert.equal(result.transfers.length, 2);
  const repayments = result.transfers.map((t, i) => ({ ...t, id: String(i), groupId: 'g', date: '2026-01-01' }));
  assert.deepEqual(calculate(participants, expenses, repayments).balances.map(b => b.amount), [0, 0, 0]);
});
test('payer included in equal split, full expense deletion reverses balances', () => {
  const expenses = [{ id: 'e', groupId: 'g', description: 'Dinner', date: '2026-01-01', amount: 100, payerId: 'a', participantIds: ['c', 'b', 'a'], shares: [{ participantId: 'a', amount: 34 }, { participantId: 'b', amount: 33 }, { participantId: 'c', amount: 33 }] }];
  assert.deepEqual(calculate(participants, expenses, []).balances.map(b => b.amount), [66, -33, -33]);
  assert.deepEqual(calculate(participants, [], []).balances.map(b => b.amount), [0, 0, 0]);
});
