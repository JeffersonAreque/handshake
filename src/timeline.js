// Builds the milestone timeline shown on every page:
// Funded → Submitted → Verifying → Passed → Paid, plus terminal branches.
const STEPS = [
  { key: 'FUNDED', label: 'Funded', hint: 'Payment held in PayPal' },
  { key: 'SUBMITTED', label: 'Submitted', hint: 'Freelancer delivered a URL' },
  { key: 'VERIFYING', label: 'Verifying', hint: 'AI checks every criterion' },
  { key: 'PASSED', label: 'Passed', hint: 'All criteria met' },
  { key: 'PAID', label: 'Paid', hint: 'Captured to the freelancer' },
];
const ORDER = ['DRAFT', 'FUNDED', 'SUBMITTED', 'VERIFYING', 'PASSED', 'PAID'];

/**
 * @param {string} status   current milestone status
 * @param {{status: string, created_at: string}[]} events
 * @param {{notJudged?: boolean}} [opts] the latest attempt was not judged (AI unavailable)
 * @returns {{steps: {key,label,hint,state,at}[], outcome: null|{kind,label}}}
 *   state: done | current | active | failed | todo | skipped
 */
export function buildTimeline(status, events = [], { notJudged = false } = {}) {
  const lastAt = (key) => [...events].reverse().find((e) => e.status === key)?.created_at ?? null;
  const reached = new Set(events.map((e) => e.status));
  let pos = ORDER.indexOf(status); // index of the current status in the happy path
  let outcome = null;

  if (status === 'FUNDED' && notJudged) outcome = { kind: 'notjudged', label: 'Not judged: the AI verifier was unavailable, so nothing was decided. Please resubmit.' };
  if (status === 'FAILED') { pos = ORDER.indexOf('VERIFYING'); outcome = { kind: 'failed', label: 'Changes needed: the freelancer can fix and resubmit' }; }
  if (status === 'REFUNDED') { pos = ORDER.indexOf('PAID'); outcome = { kind: 'refunded', label: 'Refunded to the client' }; }
  if (status === 'VOIDED') {
    pos = Math.max(...[...reached].map((s) => ORDER.indexOf(s)).filter((i) => i >= 0), 0);
    outcome = { kind: 'voided', label: 'Cancelled: the hold was released, nothing was charged' };
  }

  const steps = STEPS.map((s) => {
    const i = ORDER.indexOf(s.key);
    let state;
    if (status === 'FAILED' && s.key === 'VERIFYING') state = 'failed';
    else if (status === 'VERIFYING' && s.key === 'VERIFYING') state = 'active';
    else if (i <= pos) state = 'done';
    else if (i === pos + 1 && ['DRAFT', 'FUNDED'].includes(status)) state = 'current'; // waiting for a person
    else if (i === pos + 1 && ['SUBMITTED', 'PASSED'].includes(status)) state = 'active'; // the system is working
    else state = status === 'VOIDED' ? 'skipped' : 'todo';
    return { ...s, state, at: state === 'done' || state === 'failed' ? lastAt(s.key) : null };
  });
  return { steps, outcome };
}
