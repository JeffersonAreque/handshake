import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { memoryReport } from './memory.js';
import express from 'express';
import * as store from './db.js';
import { STATUS, transition, TransitionError } from './status.js';
import { assertPublicUrl, UnsafeUrlError } from './urlSafety.js';

const newToken = () => randomBytes(18).toString('base64url');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;

export function validateMilestoneInput(body) {
  const errors = [];
  const title = String(body.title ?? '').trim();
  const description = String(body.description ?? '').trim();
  const brief = String(body.brief ?? '').trim();
  const payeeEmail = String(body.payeeEmail ?? '').trim();
  const amountNum = Number(String(body.amount ?? '').trim());
  const criteria = String(body.criteria ?? '')
    .split(/\r?\n/)
    .map((c) => c.replace(/^\s*[-*\d.)]+\s*/, '').trim())
    .filter(Boolean);
  if (title.length < 3 || title.length > 120) errors.push('Title must be 3–120 characters.');
  if (description.length > 2000) errors.push('Description is too long.');
  if (brief.length > 2000) errors.push('The brief is too long (2,000 characters max).');
  if (!EMAIL_RE.test(payeeEmail)) errors.push('Enter the freelancer’s PayPal email.');
  if (!Number.isFinite(amountNum) || amountNum < 1 || amountNum > 10000) errors.push('Amount must be between 1 and 10,000 USD.');
  if (criteria.length < 1 || criteria.length > 10) errors.push('Add 1–10 acceptance criteria, one per line.');
  if (criteria.some((c) => c.length > 300)) errors.push('Each criterion must be under 300 characters.');
  return { errors, value: { title, description, brief, payeeEmail, amount: amountNum.toFixed(2), criteria } };
}

/** Fixed-window limiter per key (in memory; one instance is enough here). */
export function rateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.reset) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    entry.n += 1;
    if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    return entry.n <= limit;
  };
}

export function createApp({ db, paypal, verifier, ai, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render terminates TLS in front of us
  const draftLimit = rateLimiter({ limit: 8, windowMs: 10 * 60_000 });
  app.set('view engine', 'ejs');
  app.set('views', path.resolve('views'));
  app.use((req, res, next) => {
    // Secret links live in the URL: never leak them through Referer.
    res.set({ 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
    next();
  });
  app.use(express.static(path.resolve('public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(express.json({ limit: '20kb' }));
  app.locals.baseUrl = config.baseUrl;
  app.locals.aiProvider = ai.provider;
  app.locals.aiModel = ai.model;

  const load = async (req, res, role) => {
    const found = await store.getMilestoneByToken(db, req.params.token);
    if (!found || (role && found.role !== role)) {
      res.status(404).render('error', { title: 'Not found', message: 'This milestone link is not valid.' });
      return null;
    }
    return found;
  };

  const renderMilestone = async (res, { milestone, role }, extra = {}) => {
    const view = await store.getMilestoneView(db, milestone.id);
    res.render('milestone', {
      title: milestone.title,
      m: milestone,
      role,
      ...view,
      paypalClientId: config.paypal.clientId,
      error: null,
      ...extra,
    });
  };

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, node: process.version, storage: config.storage, memory: memoryReport() });
  });

  // Diagnostic browser run against a fixed allowlist only (no user URLs),
  // at most once every 2 minutes, so it can't be used to load the server.
  const PROBE_SITES = { example: 'https://example.com', wikipedia: 'https://www.wikipedia.org' };
  let lastProbe = 0;
  app.get('/healthz/browser', async (req, res) => {
    const url = PROBE_SITES[req.query.site];
    if (!url) return res.status(400).json({ error: `site must be one of: ${Object.keys(PROBE_SITES).join(', ')}` });
    const wait = lastProbe + 120_000 - Date.now();
    if (wait > 0) return res.status(429).json({ error: `Try again in ${Math.ceil(wait / 1000)} s` });
    lastProbe = Date.now();
    try {
      res.json(await verifier.probe(url));
    } catch (err) {
      res.status(502).json({ error: err.message.split('\n')[0], memory: memoryReport() });
    }
  });

  app.get('/', (req, res) => res.render('landing', { title: 'Handshake' }));

  app.get('/new', (req, res) =>
    res.render('new', { title: 'New milestone', errors: [], form: { amount: '25.00' } })
  );

  // AI drafts measurable criteria from a plain brief; the client edits them
  // in the form before creating (and then funding) the milestone.
  app.post('/api/draft-criteria', async (req, res) => {
    const brief = String(req.body?.brief ?? '').trim();
    if (brief.length < 15) return res.status(400).json({ error: 'Describe the work in at least a sentence.' });
    if (brief.length > 2000) return res.status(400).json({ error: 'The brief is too long (2,000 characters max).' });
    if (!draftLimit(req.ip)) return res.status(429).json({ error: 'Too many drafts. Please wait a few minutes.' });
    try {
      res.json({ criteria: await ai.draftCriteria(brief), model: ai.model });
    } catch (err) {
      console.error(`[draft] ${err.message}`);
      res.status(502).json({ error: 'The AI could not draft criteria right now. You can write them yourself.' });
    }
  });

  app.post('/milestones', async (req, res) => {
    const { errors, value } = validateMilestoneInput(req.body);
    if (errors.length) return res.status(422).render('new', { title: 'New milestone', errors, form: req.body });
    const m = await store.createMilestone(db, { ...value, clientToken: newToken(), freelancerToken: newToken() });
    res.redirect(303, `/c/${m.client_token}`);
  });

  // ----- Client -----
  app.get('/c/:token', async (req, res) => {
    const found = await load(req, res, 'client');
    if (found) await renderMilestone(res, found);
  });

  app.post('/api/c/:token/order', async (req, res) => {
    const found = await store.getMilestoneByToken(db, req.params.token);
    if (!found || found.role !== 'client') return res.status(404).json({ error: 'Not found' });
    const m = found.milestone;
    if (m.status !== STATUS.DRAFT) return res.status(409).json({ error: `Milestone is ${m.status}` });
    try {
      const order = await paypal.createOrder({
        amount: m.amount,
        currency: m.currency,
        payeeEmail: m.payee_email,
        referenceId: `milestone-${m.id}`,
        description: `Handshake milestone: ${m.title}`,
      });
      await store.updateMilestone(db, m.id, { order_id: order.id, last_error: null });
      res.json({ id: order.id });
    } catch (err) {
      console.error(`[order] milestone ${m.id}: ${err.message}`);
      res.status(502).json({ error: 'Could not create the PayPal order. Please try again.' });
    }
  });

  app.post('/api/c/:token/authorize', async (req, res) => {
    const found = await store.getMilestoneByToken(db, req.params.token);
    if (!found || found.role !== 'client') return res.status(404).json({ error: 'Not found' });
    const m = found.milestone;
    if (m.status !== STATUS.DRAFT) return res.status(409).json({ error: `Milestone is ${m.status}` });
    if (!m.order_id || req.body?.orderID !== m.order_id) return res.status(400).json({ error: 'Order does not match this milestone' });
    try {
      const auth = await paypal.authorizeOrder(m.order_id);
      if (auth.status !== 'CREATED') throw new Error(`Authorization status ${auth.status}`);
      await transition(db, m.id, STATUS.FUNDED, { authorization_id: auth.id, last_error: null }, `Authorized ${auth.amount?.value ?? m.amount} ${m.currency} (held, not charged)`);
      res.json({ ok: true });
    } catch (err) {
      console.error(`[authorize] milestone ${m.id}: ${err.message}`);
      await store.updateMilestone(db, m.id, { last_error: `Authorization failed: ${err.message}` });
      res.status(502).json({ error: 'PayPal could not authorize this payment.' });
    }
  });

  app.post('/c/:token/void', async (req, res) => {
    const found = await load(req, res, 'client');
    if (!found) return;
    const m = found.milestone;
    if (m.status !== STATUS.FUNDED && m.status !== STATUS.FAILED) {
      return renderMilestone(res.status(409), found, { error: `You can’t cancel a milestone that is ${m.status}.` });
    }
    try {
      const auth = await paypal.voidAuthorization(m.authorization_id);
      if (auth.status !== 'VOIDED') throw new Error(`Authorization status ${auth.status}`);
      await transition(db, m.id, STATUS.VOIDED, { last_error: null }, 'Client cancelled; hold released');
      res.redirect(303, `/c/${m.client_token}`);
    } catch (err) {
      console.error(`[void] milestone ${m.id}: ${err.message}`);
      await renderMilestone(res.status(502), found, { error: 'PayPal could not cancel the hold. Please try again.' });
    }
  });

  app.post('/c/:token/payout', async (req, res) => {
    const found = await load(req, res, 'client');
    if (!found) return;
    await verifier.payout(found.milestone.id);
    res.redirect(303, `/c/${found.milestone.client_token}`);
  });

  // ----- Freelancer -----
  app.get('/f/:token', async (req, res) => {
    const found = await load(req, res, 'freelancer');
    if (found) await renderMilestone(res, found);
  });

  app.post('/f/:token/submit', async (req, res) => {
    const found = await load(req, res, 'freelancer');
    if (!found) return;
    const m = found.milestone;
    let url;
    try {
      url = (await assertPublicUrl(req.body.url, { allowPrivate: config.allowPrivateUrls })).href;
    } catch (err) {
      const message = err instanceof UnsafeUrlError ? err.message : 'That URL can’t be checked.';
      return renderMilestone(res.status(422), found, { error: message, submittedUrl: req.body.url });
    }
    try {
      await transition(db, m.id, STATUS.SUBMITTED, {}, `Submitted ${url}`);
    } catch (err) {
      if (!(err instanceof TransitionError)) throw err;
      return renderMilestone(res.status(409), found, { error: `You can’t submit while the milestone is ${m.status}.` });
    }
    const submission = await store.addSubmission(db, m.id, url);
    verifier.enqueue(m.id, Number(submission.id));
    res.redirect(303, `/f/${m.freelancer_token}`);
  });

  // ----- Evidence report page, visible to both roles of that milestone -----
  app.get('/r/:token/:reportId', async (req, res) => {
    const found = await load(req, res);
    if (!found) return;
    const reportId = Number(req.params.reportId);
    const report = Number.isInteger(reportId) ? await store.getReport(db, found.milestone.id, reportId) : null;
    if (!report) return res.status(404).render('error', { title: 'Not found', message: 'Report not found.' });
    res.render('report', { title: `Evidence report: ${found.milestone.title}`, m: found.milestone, role: found.role, r: report, token: req.params.token });
  });

  // ----- Evidence (screenshots from the DB), visible to both roles of that milestone -----
  app.get('/e/:token/:submissionId/:file', async (req, res) => {
    const match = /^(desktop|mobile)\.jpg$/.exec(req.params.file);
    const submissionId = Number(req.params.submissionId);
    if (!match || !Number.isInteger(submissionId)) return res.status(404).end();
    const found = await store.getMilestoneByToken(db, req.params.token);
    if (!found) return res.status(404).end();
    const shot = await store.getScreenshot(db, found.milestone.id, submissionId, match[1]);
    if (!shot) return res.status(404).end();
    res.set({ 'Content-Type': shot.mime, 'Cache-Control': 'private, max-age=86400' }).send(shot.data);
  });

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(`[error] ${req.method} ${req.path}: ${err.message}`);
    res.status(500).render('error', { title: 'Error', message: 'Something went wrong.' });
  });
  return app;
}
