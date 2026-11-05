// End-to-end money flow through the HTTP app with a fake PayPal and a fake
// browser capture (no network, no Chromium), on an in-memory database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getMilestone, toRows, countReports } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createVerifier } from '../src/verifier/service.js';
import { createAi } from '../src/ai/index.js';

const mockAi = createAi({ provider: 'mock' });

function fakePayPal() {
  const calls = [];
  return {
    calls,
    createOrder: async (o) => { calls.push(['createOrder', o]); return { id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED' }; },
    authorizeOrder: async (id) => { calls.push(['authorize', id]); return { id: 'AUTH1', status: 'CREATED', amount: { value: '25.00' } }; },
    captureAuthorization: async (id) => { calls.push(['capture', id]); return { id: 'CAP1', status: 'COMPLETED' }; },
    voidAuthorization: async (id) => { calls.push(['void', id]); return { id, status: 'VOIDED' }; },
  };
}

const goodPage = { httpStatus: 200, consoleErrors: [], pageErrors: [], failedRequests: [], brokenImages: [], text: 'ok' };
const brokenPage = { ...goodPage, pageErrors: ['TypeError: x is undefined'] };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

async function setup(pages) {
  const db = await openDb({ url: ':memory:' });
  const paypal = fakePayPal();
  const capture = async (url) => ({
    checks: { url, ...(pages[url] ?? goodPage) },
    images: [{ label: 'desktop', data: JPEG }, { label: 'mobile', data: JPEG }],
  });
  const verifier = createVerifier({ db, paypal, ai: mockAi, capture, log: { error() {} } });
  const config = { baseUrl: 'http://test', paypal: { clientId: 'cid' }, allowPrivateUrls: false, storage: 'memory' };
  const app = createApp({ db, paypal, verifier, ai: mockAi, config });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const form = (path, data) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  const json = (path, data) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) });

  const created = await form('/milestones', {
    title: 'Bakery landing page', amount: '25', payeeEmail: 'freelancer@example.com',
    criteria: '- Shows the bakery name\n- Has a contact form',
  });
  assert.equal(created.status, 303);
  const clientToken = created.headers.get('location').split('/').pop();
  const [row] = toRows(await db.execute({ sql: 'SELECT * FROM milestones WHERE client_token = ?', args: [clientToken] }));
  return { db, paypal, verifier, server, base, form, json, m: { ...row, id: Number(row.id) } };
}

const fund = async ({ json, m }) => {
  await json(`/api/c/${m.client_token}/order`);
  await json(`/api/c/${m.client_token}/authorize`, { orderID: 'ORDER1' });
};

test('create → fund → submit → pass → paid to the freelancer', async (t) => {
  const ctx = await setup({});
  const { db, paypal, verifier, server, base, form, json, m } = ctx;
  t.after(() => server.close());
  assert.deepEqual(JSON.parse(m.criteria), ['Shows the bakery name', 'Has a contact form']);
  assert.equal(m.amount, '25.00');

  // Freelancer can't submit before funding.
  assert.equal((await form(`/f/${m.freelancer_token}/submit`, { url: 'https://93.184.216.34/' })).status, 409);

  const order = await (await json(`/api/c/${m.client_token}/order`)).json();
  assert.equal(order.id, 'ORDER1');
  assert.equal(paypal.calls[0][1].payeeEmail, 'freelancer@example.com');
  assert.equal((await json(`/api/c/${m.client_token}/authorize`, { orderID: 'WRONG' })).status, 400);
  assert.equal((await json(`/api/c/${m.client_token}/authorize`, { orderID: 'ORDER1' })).status, 200);
  assert.equal((await getMilestone(db, m.id)).status, 'FUNDED');

  // Freelancer token can't use client endpoints.
  assert.equal((await json(`/api/c/${m.freelancer_token}/order`)).status, 404);

  assert.equal((await form(`/f/${m.freelancer_token}/submit`, { url: 'https://93.184.216.34/' })).status, 303);
  await verifier.idle();
  const after = await getMilestone(db, m.id);
  assert.equal(after.status, 'PAID');
  assert.equal(after.capture_id, 'CAP1');
  assert.deepEqual(paypal.calls.map((c) => c[0]), ['createOrder', 'authorize', 'capture']);

  const page = await (await fetch(`${base}/f/${m.freelancer_token}`)).text();
  assert.match(page, /freelancer@example\.com/);
  assert.match(page, /PASS/);

  // Screenshots are served from the DB to both roles, and only for this milestone.
  const shotPath = page.match(/\/e\/[^"]+\/(\d+)\/desktop\.jpg/)[0];
  const shot = await fetch(base + shotPath);
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await shot.arrayBuffer()), JPEG);
  const sid = shotPath.match(/\/(\d+)\/desktop/)[1];
  assert.equal((await fetch(`${base}/e/${m.client_token}/${sid}/mobile.jpg`)).status, 200);
  assert.equal((await fetch(`${base}/e/not-a-token/${sid}/mobile.jpg`)).status, 404);
  assert.equal((await fetch(`${base}/e/${m.client_token}/${sid}/..%2Fsecret.jpg`)).status, 404);
});

test('fail → resubmit → client voids; nothing is captured', async (t) => {
  const ctx = await setup({ 'https://93.184.216.34/broken': brokenPage });
  const { db, paypal, verifier, server, form, m } = ctx;
  t.after(() => server.close());
  await fund(ctx);

  await form(`/f/${m.freelancer_token}/submit`, { url: 'https://93.184.216.34/broken' });
  await verifier.idle();
  assert.equal((await getMilestone(db, m.id)).status, 'FAILED');

  await form(`/f/${m.freelancer_token}/submit`, { url: 'https://93.184.216.34/broken' });
  await verifier.idle();
  assert.equal((await getMilestone(db, m.id)).status, 'FAILED');
  assert.equal(await countReports(db, m.id), 2);

  // The freelancer sees an AI fix list, and the full evidence report opens for both roles.
  const page = await (await fetch(`${ctx.base}/f/${m.freelancer_token}`)).text();
  assert.match(page, /What to fix before resubmitting/);
  assert.match(page, /TypeError: x is undefined/);
  const reportPath = page.match(/href="(\/r\/[^"]+)"/)[1];
  const report = await fetch(ctx.base + reportPath);
  assert.equal(report.status, 200);
  const html = await report.text();
  assert.match(html, /Evidence report/);
  assert.match(html, /Suggested fixes/);
  const reportId = reportPath.split('/').pop();
  assert.equal((await fetch(`${ctx.base}/r/${m.client_token}/${reportId}`)).status, 200);
  assert.equal((await fetch(`${ctx.base}/r/someone-else/${reportId}`)).status, 404);

  assert.equal((await form(`/c/${m.client_token}/void`, {})).status, 303);
  assert.equal((await getMilestone(db, m.id)).status, 'VOIDED');
  assert.ok(!paypal.calls.some((c) => c[0] === 'capture'));
});

test('AI drafts criteria from a brief, with validation and a rate limit', async (t) => {
  const { server, base, form, db } = await setup({});
  t.after(() => server.close());
  const draft = (brief) => fetch(`${base}/api/draft-criteria`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brief }) });
  assert.equal((await draft('too short')).status, 400);
  const ok = await draft('A one-page site for my bakery with opening hours. It needs a contact form.');
  assert.equal(ok.status, 200);
  const { criteria } = await ok.json();
  assert.ok(criteria.length >= 3 && criteria.every((c) => typeof c === 'string'));

  // The brief is stored with the milestone.
  const created = await form('/milestones', { title: 'Brief test', amount: '5', payeeEmail: 'f@example.com', brief: 'A bakery page with hours.', criteria: criteria.join('\n') });
  assert.equal(created.status, 303);
  const [row] = toRows(await db.execute("SELECT brief FROM milestones WHERE title = 'Brief test'"));
  assert.equal(row.brief, 'A bakery page with hours.');

  let limited = false;
  for (let i = 0; i < 10 && !limited; i++) limited = (await draft('Another brief that is long enough to draft.')).status === 429;
  assert.ok(limited, 'draft endpoint is rate limited');
});

test('a restart mid-verification resumes and still pays out', async (t) => {
  const ctx = await setup({});
  const { db, paypal, server, m } = ctx;
  t.after(() => server.close());
  await fund(ctx);
  // Simulate a crash right after the milestone moved to VERIFYING.
  await db.execute({ sql: "UPDATE milestones SET status = 'VERIFYING' WHERE id = ?", args: [m.id] });
  await db.execute({ sql: "INSERT INTO submissions (milestone_id, url, attempt) VALUES (?, 'https://93.184.216.34/', 1)", args: [m.id] });
  const capture = async (url) => ({ checks: { url, ...goodPage }, images: [] });
  const fresh = createVerifier({ db, paypal, ai: mockAi, capture, log: { error() {} } });
  await fresh.recover();
  await fresh.idle();
  assert.equal((await getMilestone(db, m.id)).status, 'PAID');
});

test('private URLs are rejected at submission', async (t) => {
  const ctx = await setup({});
  const { db, server, form, m } = ctx;
  t.after(() => server.close());
  await fund(ctx);
  for (const url of ['http://localhost:3000', 'http://169.254.169.254/', 'file:///etc/passwd']) {
    assert.equal((await form(`/f/${m.freelancer_token}/submit`, { url })).status, 422, url);
  }
  assert.equal((await getMilestone(db, m.id)).status, 'FUNDED');
});

test('browser probe only opens allowlisted sites and is rate limited', async (t) => {
  const { server, base } = await setup({});
  t.after(() => server.close());
  assert.equal((await fetch(`${base}/healthz/browser?site=http://169.254.169.254`)).status, 400);
  const ok = await fetch(`${base}/healthz/browser?site=example`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).url, 'https://example.com');
  assert.equal((await fetch(`${base}/healthz/browser?site=wikipedia`)).status, 429);
});

test('invalid milestone input is rejected', async (t) => {
  const { server, form } = await setup({});
  t.after(() => server.close());
  const res = await form('/milestones', { title: 'x', amount: '0', payeeEmail: 'nope', criteria: '' });
  assert.equal(res.status, 422);
});
