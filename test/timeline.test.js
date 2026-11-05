import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline } from '../src/timeline.js';

const states = (status, events = []) => buildTimeline(status, events).steps.map((s) => s.state);
const ev = (...statuses) => statuses.map((status, i) => ({ status, created_at: `2026-11-05 10:0${i}:00` }));

test('happy path states', () => {
  assert.deepEqual(states('DRAFT'), ['current', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(states('FUNDED'), ['done', 'current', 'todo', 'todo', 'todo']);
  assert.deepEqual(states('SUBMITTED'), ['done', 'done', 'active', 'todo', 'todo']);
  assert.deepEqual(states('VERIFYING'), ['done', 'done', 'active', 'todo', 'todo']);
  assert.deepEqual(states('PASSED'), ['done', 'done', 'done', 'done', 'active']);
  assert.deepEqual(states('PAID'), ['done', 'done', 'done', 'done', 'done']);
});

test('branches: failed, voided, refunded', () => {
  assert.deepEqual(states('FAILED'), ['done', 'done', 'failed', 'todo', 'todo']);
  assert.equal(buildTimeline('FAILED').outcome.kind, 'failed');
  assert.deepEqual(states('VOIDED', ev('DRAFT', 'FUNDED', 'VOIDED')), ['done', 'skipped', 'skipped', 'skipped', 'skipped']);
  assert.equal(buildTimeline('VOIDED', ev('DRAFT', 'FUNDED', 'VOIDED')).outcome.kind, 'voided');
  assert.deepEqual(states('REFUNDED'), ['done', 'done', 'done', 'done', 'done']);
  assert.equal(buildTimeline('REFUNDED').outcome.kind, 'refunded');
});

test('done steps carry the time of their latest event', () => {
  const t = buildTimeline('FAILED', ev('DRAFT', 'FUNDED', 'SUBMITTED', 'VERIFYING', 'FAILED', 'SUBMITTED', 'VERIFYING', 'FAILED'));
  assert.equal(t.steps[0].at, '2026-11-05 10:01:00');
  assert.equal(t.steps[1].at, '2026-11-05 10:05:00', 'latest SUBMITTED');
  assert.equal(t.steps[3].at, null);
});
