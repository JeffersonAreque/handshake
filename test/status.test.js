import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, createMilestone, getMilestone, listEvents } from '../src/db.js';
import { STATUS, transition, canTransition, TransitionError } from '../src/status.js';

const newMilestone = (db) =>
  createMilestone(db, {
    clientToken: `c${Math.random()}`, freelancerToken: `f${Math.random()}`,
    title: 'Test', amount: '10.00', payeeEmail: 'f@example.com', criteria: ['Works'],
  });

test('allowed and forbidden transitions', () => {
  assert.ok(canTransition('DRAFT', 'FUNDED'));
  assert.ok(canTransition('FAILED', 'SUBMITTED'));
  assert.ok(canTransition('PAID', 'REFUNDED'));
  assert.ok(!canTransition('DRAFT', 'PAID'));
  assert.ok(!canTransition('FUNDED', 'PAID'));
  assert.ok(!canTransition('VERIFYING', 'VOIDED'));
  assert.ok(!canTransition('VOIDED', 'FUNDED'));
});

test('happy path DRAFT → PAID records events', () => {
  const db = openDb(':memory:');
  const m = newMilestone(db);
  for (const s of ['FUNDED', 'SUBMITTED', 'VERIFYING', 'PASSED']) transition(db, m.id, s);
  transition(db, m.id, STATUS.PAID, { capture_id: 'CAP1' }, 'paid');
  const after = getMilestone(db, m.id);
  assert.equal(after.status, 'PAID');
  assert.equal(after.capture_id, 'CAP1');
  assert.deepEqual(listEvents(db, m.id).map((e) => e.status), ['DRAFT', 'FUNDED', 'SUBMITTED', 'VERIFYING', 'PASSED', 'PAID']);
});

test('money cannot move from the wrong status', () => {
  const db = openDb(':memory:');
  const m = newMilestone(db);
  assert.throws(() => transition(db, m.id, STATUS.PAID, { capture_id: 'X' }), TransitionError);
  assert.throws(() => transition(db, m.id, STATUS.VOIDED), TransitionError);
  assert.equal(getMilestone(db, m.id).capture_id, null);
  transition(db, m.id, STATUS.FUNDED);
  assert.throws(() => transition(db, m.id, STATUS.FUNDED), TransitionError, 'cannot fund twice');
});

test('fail → resubmit → void path', () => {
  const db = openDb(':memory:');
  const m = newMilestone(db);
  for (const s of ['FUNDED', 'SUBMITTED', 'VERIFYING', 'FAILED', 'SUBMITTED', 'VERIFYING', 'FAILED', 'VOIDED']) transition(db, m.id, s);
  assert.equal(getMilestone(db, m.id).status, 'VOIDED');
  assert.throws(() => transition(db, m.id, STATUS.SUBMITTED), TransitionError);
});
