import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, createMilestone, getMilestone, listEvents } from '../src/db.js';
import { STATUS, transition, canTransition, TransitionError } from '../src/status.js';

const memDb = () => openDb({ url: ':memory:' });
const newMilestone = (db) =>
  createMilestone(db, {
    clientToken: `c${Math.random()}`, freelancerToken: `f${Math.random()}`,
    title: 'Test', amount: '10.00', payeeEmail: 'f@example.com', criteria: ['Works'],
  });

test('allowed and forbidden transitions', () => {
  assert.ok(canTransition('DRAFT', 'FUNDED'));
  assert.ok(canTransition('FAILED', 'SUBMITTED'));
  assert.ok(canTransition('PAID', 'REFUNDED'));
  assert.ok(canTransition('VERIFYING', 'FUNDED'), 'not judged → back to funded');
  assert.ok(!canTransition('PAID', 'FUNDED'));
  assert.ok(!canTransition('DRAFT', 'PAID'));
  assert.ok(!canTransition('FUNDED', 'PAID'));
  assert.ok(!canTransition('VERIFYING', 'VOIDED'));
  assert.ok(!canTransition('VOIDED', 'FUNDED'));
});

test('happy path DRAFT → PAID records events', async () => {
  const db = await memDb();
  const m = await newMilestone(db);
  for (const s of ['FUNDED', 'SUBMITTED', 'VERIFYING', 'PASSED']) await transition(db, m.id, s);
  await transition(db, m.id, STATUS.PAID, { capture_id: 'CAP1' }, 'paid');
  const after = await getMilestone(db, m.id);
  assert.equal(after.status, 'PAID');
  assert.equal(after.capture_id, 'CAP1');
  assert.deepEqual((await listEvents(db, m.id)).map((e) => e.status), ['DRAFT', 'FUNDED', 'SUBMITTED', 'VERIFYING', 'PASSED', 'PAID']);
});

test('money cannot move from the wrong status, and failed moves leave no event', async () => {
  const db = await memDb();
  const m = await newMilestone(db);
  await assert.rejects(transition(db, m.id, STATUS.PAID, { capture_id: 'X' }), TransitionError);
  await assert.rejects(transition(db, m.id, STATUS.VOIDED), TransitionError);
  assert.equal((await getMilestone(db, m.id)).capture_id, null);
  await transition(db, m.id, STATUS.FUNDED);
  await assert.rejects(transition(db, m.id, STATUS.FUNDED), TransitionError, 'cannot fund twice');
  assert.deepEqual((await listEvents(db, m.id)).map((e) => e.status), ['DRAFT', 'FUNDED']);
});

test('concurrent transitions: only one wins', async () => {
  const db = await memDb();
  const m = await newMilestone(db);
  await transition(db, m.id, STATUS.FUNDED);
  const results = await Promise.allSettled([transition(db, m.id, STATUS.VOIDED), transition(db, m.id, STATUS.VOIDED)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('fail → resubmit → void path', async () => {
  const db = await memDb();
  const m = await newMilestone(db);
  for (const s of ['FUNDED', 'SUBMITTED', 'VERIFYING', 'FAILED', 'SUBMITTED', 'VERIFYING', 'FAILED', 'VOIDED']) await transition(db, m.id, s);
  assert.equal((await getMilestone(db, m.id)).status, 'VOIDED');
  await assert.rejects(transition(db, m.id, STATUS.SUBMITTED), TransitionError);
});
