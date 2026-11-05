// Milestone state machine. Every status change goes through transition(),
// which updates the row only if it is still in an allowed source status.
// This is a single atomic UPDATE, so two concurrent requests can't both
// move money from the same state.

export const STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  FUNDED: 'FUNDED',
  SUBMITTED: 'SUBMITTED',
  VERIFYING: 'VERIFYING',
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  PAID: 'PAID',
  VOIDED: 'VOIDED',
  REFUNDED: 'REFUNDED',
});

const S = STATUS;
export const TRANSITIONS = Object.freeze({
  [S.DRAFT]: [S.FUNDED],
  [S.FUNDED]: [S.SUBMITTED, S.VOIDED],
  [S.SUBMITTED]: [S.VERIFYING],
  [S.VERIFYING]: [S.PASSED, S.FAILED],
  [S.PASSED]: [S.PAID],
  [S.FAILED]: [S.SUBMITTED, S.VOIDED],
  [S.PAID]: [S.REFUNDED],
  [S.VOIDED]: [],
  [S.REFUNDED]: [],
});

export class TransitionError extends Error {}

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Statuses from which `to` can be reached. */
export function sourcesFor(to) {
  return Object.keys(TRANSITIONS).filter((from) => TRANSITIONS[from].includes(to));
}

/**
 * Move milestone `id` to status `to`, setting extra columns in `fields`.
 * Throws TransitionError if the milestone is not in a valid source status.
 */
export function transition(db, id, to, fields = {}, note = null) {
  const from = sourcesFor(to);
  if (!from.length) throw new TransitionError(`No transition leads to ${to}`);
  const keys = Object.keys(fields);
  const sets = ['status = ?', ...keys.map((k) => `${k} = ?`), "updated_at = datetime('now')"].join(', ');
  const placeholders = from.map(() => '?').join(', ');
  const result = db
    .prepare(`UPDATE milestones SET ${sets} WHERE id = ? AND status IN (${placeholders})`)
    .run(to, ...keys.map((k) => fields[k]), id, ...from);
  if (result.changes !== 1) {
    const row = db.prepare('SELECT status FROM milestones WHERE id = ?').get(id);
    throw new TransitionError(row ? `Cannot go from ${row.status} to ${to}` : `Milestone ${id} not found`);
  }
  db.prepare('INSERT INTO events (milestone_id, status, note) VALUES (?, ?, ?)').run(id, to, note);
}
