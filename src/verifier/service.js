// Runs verifications one at a time (keeps memory low on small instances) and
// moves money according to the result: capture on pass, nothing on fail.
// Progress steps are published for the live timeline.
import * as store from '../db.js';
import { STATUS, transition } from '../status.js';
import { trackMemory, memoryReport } from '../memory.js';
import { publishStep } from '../bus.js';

const RUN_TIMEOUT_MS = 3 * 60_000;

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export function createVerifier({ db, money, ai, capture, allowPrivate = false, log = console }) {
  let chain = Promise.resolve();

  /** Capture the held payment to the freelancer. Safe to retry. */
  async function payout(milestoneId) {
    const m = await store.getMilestone(db, milestoneId);
    if (m.status !== STATUS.PASSED) return m;
    const rail = money.for(m);
    publishStep(m.id, rail.kind === 'simulated' ? 'Releasing the simulated hold…' : 'Capturing the PayPal payment…');
    try {
      const result = await rail.capture(m);
      if (result.status !== 'COMPLETED' && result.status !== 'PENDING') throw new Error(`Capture status ${result.status}`);
      const note = rail.kind === 'simulated'
        ? `Simulated capture of ${m.amount} ${m.currency} (demo, no PayPal call)`
        : `Captured ${m.amount} ${m.currency} to ${m.payee_email}`;
      await transition(db, m.id, STATUS.PAID, { capture_id: result.id, last_error: null }, note);
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
    const step = (s) => publishStep(m.id, s);

    let report;
    try {
      report = await withTimeout(
        (async () => {
          step('Opening the page in a headless browser…');
          const { checks, images } = await trackMemory(`verify ${m.id}/${submission.id}`, () =>
            capture(submission.url, { allowPrivate, onStep: step })
          );
          step(`Asking ${ai.provider === 'gemini' ? 'Gemini' : 'the verifier'} to check ${m.criteria.length} criteria…`);
          const verdicts = await ai.judge({ criteria: m.criteria, checks, images });
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
    let fixes = [];
    if (!passed && !report.error) {
      step('Writing a fix list for the freelancer…');
      try {
        fixes = await ai.fixList({ criteria: m.criteria, verdicts: report.verdicts, checks: report.checks });
      } catch (err) {
        log.error(`[fixes] milestone ${m.id}: ${err.message}`);
      }
    }
    await store.addReport(db, {
      submissionId: submission.id,
      milestoneId: m.id,
      passed,
      fixes,
      model: ai.model,
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

  /** Diagnostic: capture a fixed public URL in the queue and report memory. */
  function probe(url) {
    const run = chain.then(async () => {
      const started = Date.now();
      const { checks, images } = await trackMemory(`probe ${url}`, () => capture(url, { allowPrivate: false }));
      return {
        url,
        ms: Date.now() - started,
        httpStatus: checks.httpStatus,
        screenshotsKb: images.map((i) => `${i.label}:${Math.round(i.data.length / 1024)}`),
        memory: memoryReport(),
      };
    });
    chain = run.catch(() => {});
    return run;
  }

  return { enqueue, payout, recover, probe, idle: () => chain };
}
