// One-click demo for judges.
// - "Try as client": a real milestone (real PayPal sandbox payment) with the
//   demo bakery criteria, paid to DEMO_PAYEE_EMAIL.
// - "Try as freelancer": a milestone with a SIMULATED hold (labeled as such),
//   so the verifier can be tried without a sandbox buyer login.
// - Showcase: two read-only milestones seeded once, verified for real against
//   the bundled good and broken demo sites.
// 'try' milestones are deleted after 24 hours.
import { randomBytes } from 'node:crypto';
import * as store from './db.js';
import { STATUS, transition } from './status.js';

export const newToken = () => randomBytes(18).toString('base64url');

export const DEMO = {
  title: 'Landing page for “Pan de Casa” bakery',
  description: 'A one-page website for a neighborhood bakery.',
  brief: 'A one-page website for my bakery “Pan de Casa” with a photo of our bread, our opening hours for every day, a short menu with prices and a contact form.',
  amount: '25.00',
  criteria: [
    'The page shows the bakery name “Pan de Casa” and a photo or illustration of bread',
    'The opening hours are listed for every day of the week',
    'A menu lists at least 4 products, each with a price',
    'There is a contact form with name, email and message fields and a send button',
    'The page loads without JavaScript errors or broken images',
    'On mobile the layout fits the screen without horizontal scrolling',
  ],
};

export const SIMULATED_PAYEE = 'demo-freelancer@example.com';

export async function createDemoMilestone(db, money, { kind, payeeEmail, demoKind = 'try', title = DEMO.title }) {
  const simulated = kind === 'freelancer';
  const m = await store.createMilestone(db, {
    ...DEMO,
    title,
    payeeEmail: simulated ? SIMULATED_PAYEE : payeeEmail,
    clientToken: newToken(),
    freelancerToken: newToken(),
    funding: simulated ? 'simulated' : 'paypal',
    demoKind,
  });
  if (simulated) {
    await transition(db, m.id, STATUS.FUNDED, { authorization_id: money.simulatedHoldId() }, `Simulated hold of ${m.amount} ${m.currency} (demo mode, no PayPal call)`);
  }
  return store.getMilestone(db, m.id);
}

export const demoSiteUrl = (baseUrl, which) => `${baseUrl}/demo-sites/${which}/`;

/** Waits until `url` answers 200 (during a deploy the old instance may still serve it). */
async function waitForUrl(url, { timeoutMs = 10 * 60_000, intervalMs = 10_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok && (await res.text()).includes('Pan de Casa')) return true;
    } catch { /* not reachable yet */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Seeds the showcase once (it lives in Turso, so it survives restarts). */
export async function seedShowcase({ db, money, verifier, baseUrl, log = console, wait = waitForUrl }) {
  if ((await store.listShowcase(db)).length) return;
  if (!(await wait(demoSiteUrl(baseUrl, 'good')))) { log.error('[demo] demo site not reachable at the public URL; showcase not seeded'); return; }
  if ((await store.listShowcase(db)).length) return; // seeded meanwhile
  for (const [which, title] of [['good', 'Showcase: delivery that passes'], ['broken', 'Showcase: delivery that needs changes']]) {
    const m = await createDemoMilestone(db, money, { kind: 'freelancer', demoKind: 'showcase', title });
    const url = demoSiteUrl(baseUrl, which);
    await transition(db, m.id, STATUS.SUBMITTED, {}, `Submitted ${url}`);
    const s = await store.addSubmission(db, m.id, url);
    verifier.enqueue(m.id, Number(s.id));
  }
  log.log('[demo] showcase seeded');
}

export function startDemoCleanup(db, log = console) {
  const run = () => store.deleteOldDemos(db, 24).then((n) => n && log.log(`[demo] removed ${n} old demo milestones`)).catch((err) => log.error(`[demo] cleanup: ${err.message}`));
  run();
  return setInterval(run, 60 * 60_000).unref();
}
