// Runs verifications one at a time (keeps memory low on small instances) and
// moves money according to the result: capture on pass, nothing on fail.
// Progress steps are published for the live timeline.
import * as store from '../db.js';
import { STATUS, transition } from '../status.js';
import { trackMemory, memoryReport } from '../memory.js';
import { publishStep } from '../bus.js';
import { providerLabel } from '../ai/index.js';

const RUN_TIMEOUT_MS = 5 * 60_000;
// When every AI model is busy, ask again after these waits (the screenshots
// are already captured, so no browser is involved) before giving up.
const JUDGE_RETRY_DELAYS_MS = [20_000, 40_000];

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export function createVerifier({ db, money, ai, capture, allowPrivate = false, log = console, judgeRetryDelays = JUDGE_RETRY_DELAYS_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
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
          const who = ai.provider === 'mock' ? 'the verifier' : providerLabel(ai.provider);
          step(`Asking ${who} to check ${m.criteria.length} criteria…`);
          let judged;
          try {
            for (let attempt = 0; ; attempt++) {
              try {
                judged = await ai.judge({ criteria: m.criteria, checks, images });
                break;
              } catch (err) {
                const busy = err?.unavailable && !err?.gone;
                if (!busy || attempt >= judgeRetryDelays.length) throw err;
                const wait = judgeRetryDelays[attempt];
                log.error(`[verify] milestone ${m.id}: ${err.message}; asking again in ${wait / 1000} s`);
                step(`${who} is busy right now; trying again in ${Math.round(wait / 1000)} s (attempt ${attempt + 2} of ${judgeRetryDelays.length + 1})…`);
                await sleep(wait);
                step(`Asking ${who} again…`);
              }
            }
          } catch (err) {
            // The AI provider failed (quota, outage, model gone): nothing was
            // judged. Keep the evidence; don't blame the work.
            log.error(`[verify] milestone ${m.id}: not judged: ${err.message}`);
            return {
              checks,
              images,
              verdicts: m.criteria.map((criterion) => ({ criterion, pass: false, reason: 'Not judged: the AI verifier was unavailable.', evidence: [] })),
              error: `The AI verifier was unavailable (${err.message}), so this attempt was not judged. Please resubmit in a few minutes.`,
              model: ai.model,
              notJudged: true,
            };
          }
          return { checks, images, verdicts: judged.verdicts, model: judged.model, provider: judged.provider, error: null };
        })(),
        RUN_TIMEOUT_MS,
        'Verification timed out after 5 minutes'
      );
    } catch (err) {
      report = {
        checks: { url: submission.url },
        images: [],
        verdicts: m.criteria.map((criterion) => ({ criterion, pass: false, reason: err.message, evidence: [] })),
        error: err.message,
      };
    }
    const notJudged = report.notJudged === true;
    const passed = !notJudged && report.verdicts.length > 0 && report.verdicts.every((v) => v.pass === true);
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
      judged: !notJudged,
      fixes,
      model: report.model ?? ai.model,
      provider: report.provider ?? ai.provider,
      checks: report.checks,
      verdicts: report.verdicts,
      error: report.error,
      images: report.images,
      screenshots: report.images.map((img) => ({ label: img.label, file: `${img.label}.jpg` })),
    });

    if (notJudged) {
      // Back to FUNDED: the hold stays, the freelancer just resubmits.
      await transition(db, m.id, STATUS.FUNDED, {}, `Not judged (AI verifier unavailable); please resubmit`);
    } else if (passed) {
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
