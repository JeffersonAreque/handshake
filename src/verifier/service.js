// Runs verifications one at a time (keeps memory low on small instances) and
// moves money according to the result: capture on pass, nothing on fail.
import * as store from '../db.js';
import { STATUS, transition } from '../status.js';

const RUN_TIMEOUT_MS = 3 * 60_000;

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export function createVerifier({ db, paypal, judge, capture, allowPrivate = false, log = console }) {
  let chain = Promise.resolve();

  /** Capture the authorized payment to the freelancer. Safe to retry. */
  async function payout(milestoneId) {
    const m = await store.getMilestone(db, milestoneId);
    if (m.status !== STATUS.PASSED) return m;
    try {
      const result = await paypal.captureAuthorization(m.authorization_id);
      if (result.status !== 'COMPLETED' && result.status !== 'PENDING') throw new Error(`Capture status ${result.status}`);
      await transition(db, m.id, STATUS.PAID, { capture_id: result.id, last_error: null }, `Captured ${m.amount} ${m.currency} to ${m.payee_email}`);
    } catch (err) {
      log.error(`[payout] milestone ${m.id}: ${err.message}`);
      await store.updateMilestone(db, m.id, { last_error: `Payout failed: ${err.message}` });
    }
    return store.getMilestone(db, m.id);
  }

  async function run(milestoneId, submissionId) {
    const m = await store.getMilestone(db, milestoneId);
    const submission = await store.getSubmission(db, submissionId);
    if (m.status === STATUS.SUBMITTED) await transition(db, m.id, STATUS.VERIFYING, {}, `Verifying attempt ${submission.attempt}`);
    else if (m.status !== STATUS.VERIFYING) return;

    let report;
    try {
      report = await withTimeout(
        (async () => {
          const { checks, images } = await capture(submission.url, { allowPrivate });
          const verdicts = await judge.judge({ criteria: m.criteria, checks, images, milestone: m });
          return { checks, images, verdicts, error: null };
        })(),
        RUN_TIMEOUT_MS,
        'Verification timed out after 3 minutes'
      );
    } catch (err) {
      report = {
        checks: { url: submission.url },
        images: [],
        verdicts: m.criteria.map((criterion) => ({ criterion, pass: false, reason: err.message, evidence: [] })),
        error: err.message,
      };
    }
    const passed = report.verdicts.length > 0 && report.verdicts.every((v) => v.pass === true);
    await store.addReport(db, {
      submissionId: submission.id,
      milestoneId: m.id,
      passed,
      model: judge.model,
      checks: report.checks,
      verdicts: report.verdicts,
      error: report.error,
      images: report.images,
      screenshots: report.images.map((img) => ({ label: img.label, file: `${img.label}.jpg` })),
    });

    if (passed) {
      await transition(db, m.id, STATUS.PASSED, { last_error: null }, 'All criteria passed');
      await payout(m.id);
    } else {
      const failed = report.verdicts.filter((v) => !v.pass).length;
      await transition(db, m.id, STATUS.FAILED, {}, report.error ?? `${failed} of ${report.verdicts.length} criteria failed`);
    }
  }

  function enqueue(milestoneId, submissionId) {
    chain = chain
      .then(() => run(milestoneId, submissionId))
      .catch((err) => log.error(`[verify] milestone ${milestoneId}: ${err.message}`));
    return chain;
  }

  /** After a restart, resume interrupted work. */
  async function recover() {
    const pending = [
      ...(await store.listMilestonesByStatus(db, STATUS.SUBMITTED)),
      ...(await store.listMilestonesByStatus(db, STATUS.VERIFYING)),
    ];
    for (const m of pending) {
      const s = await store.latestSubmission(db, m.id);
      if (s) enqueue(m.id, Number(s.id));
    }
    for (const m of await store.listMilestonesByStatus(db, STATUS.PASSED)) {
      chain = chain.then(() => payout(m.id)).catch((err) => log.error(`[payout] ${err.message}`));
    }
  }

  return { enqueue, payout, recover, idle: () => chain };
}
