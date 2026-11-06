// End-to-end money flow through the HTTP app with a fake PayPal and a fake
// browser capture (no network, no Chromium), on an in-memory database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getMilestone, toRows, countReports } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createVerifier } from '../src/verifier/service.js';
import { createAi, AiError } from '../src/ai/index.js';
import { createMoney } from '../src/money.js';
import { seedShowcase, createDemoMilestone } from '../src/demo.js';
import { deleteOldDemos, listShowcase } from '../src/db.js';

const mockAi = createAi({ provider: 'mock' });

function fakePayPal() {
  const calls = [];
  return {
    calls,
    createOrder: async (o) => { calls.push(['createOrder', o]); return { id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED' }; },
    authorizeOrder: async (id) => { calls.push(['authorize', id]); return { id: 'AUTH1', status: 'CREATED', amount: { value: '25.00' } }; },
    captureAuthorization: async (id) => { calls.push(['capture', id]); return { id: 'CAP1', status: 'COMPLETED' }; },
    voidAuthorization: async (id) => { calls.push(['void', id]); return { id, status: 'VOIDED' }; },
    refundCapture: async (id) => { calls.push(['refund', id]); return { id: 'REF1', status: 'COMPLETED' }; },
  };
}

const goodPage = { httpStatus: 200, consoleErrors: [], pageErrors: [], failedRequests: [], brokenImages: [], text: 'ok' };
const brokenPage = { ...goodPage, pageErrors: ['TypeError: x is undefined'] };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

async function setup(pages, { demo = { payeeEmail: 'demo-payee@example.com' } } = {}) {
  const db = await openDb({ url: ':memory:' });
  const paypal = fakePayPal();
  const money = createMoney(paypal);
  const capture = async (url) => ({
    checks: { url, ...(pages[url] ?? goodPage) },
    images: [{ label: 'desktop', data: JPEG }, { label: 'mobile', data: JPEG }],
  });
  const verifier = createVerifier({ db, money, ai: mockAi, capture, log: { error() {} } });
  const config = { baseUrl: 'https://93.184.216.34', paypal: { clientId: 'cid' }, allowPrivateUrls: false, storage: 'memory', demo };
  const app = createApp({ db, paypal, money, verifier, ai: mockAi, config });
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
  return { db, paypal, money, verifier, server, base, form, json, m: { ...row, id: Number(row.id) } };
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

  // After funding, the client sees the next step and a waiting timeline step.
  const funded = await (await fetch(`${base}/c/${m.client_token}`)).text();
  assert.match(funded, /Next step/);
  assert.match(funded, /Waiting for the freelancer to deliver/);
  assert.match(funded, /<span class="label">Waiting for delivery<\/span>/);
  assert.doesNotMatch(funded, /<span class="label">Submitted<\/span>\s*<span class="sub">Waiting/);

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

test('client can refund after payout, only once and only when PAID', async (t) => {
  const ctx = await setup({});
  const { db, paypal, verifier, server, form, m } = ctx;
  t.after(() => server.close());
  assert.equal((await form(`/c/${m.client_token}/refund`, {})).status, 409, 'no refund before payment');
  await fund(ctx);
  await form(`/f/${m.freelancer_token}/submit`, { url: 'https://93.184.216.34/' });
  await verifier.idle();
  assert.equal((await getMilestone(db, m.id)).status, 'PAID');
  assert.equal((await form(`/f/${m.freelancer_token}/refund`, {})).status, 404, 'freelancer cannot refund');
  assert.equal((await form(`/c/${m.client_token}/refund`, {})).status, 303);
  const after = await getMilestone(db, m.id);
  assert.equal(after.status, 'REFUNDED');
  assert.equal(after.refund_id, 'REF1');
  assert.deepEqual(paypal.calls.filter((c) => c[0] === 'refund'), [['refund', 'CAP1']]);
  assert.equal((await form(`/c/${m.client_token}/refund`, {})).status, 409, 'cannot refund twice');
});

test('one-click freelancer demo: simulated hold, real verification, never calls PayPal', async (t) => {
  const ctx = await setup({});
  const { db, paypal, verifier, server, base, form } = ctx;
  t.after(() => server.close());
  const calls = paypal.calls.length;
  const res = await form('/demo/freelancer', {});
  assert.equal(res.status, 303);
  const ftoken = res.headers.get('location').split('/').pop();
  const page = await (await fetch(`${base}/f/${ftoken}`)).text();
  assert.match(page, /simulated PayPal hold/);
  assert.match(page, /Good site/);
  const [row] = toRows(await db.execute({ sql: 'SELECT * FROM milestones WHERE freelancer_token = ?', args: [ftoken] }));
  assert.equal(row.status, 'FUNDED');
  assert.equal(row.funding, 'simulated');
  assert.match(row.authorization_id, /^SIM-AUTH-/);

  await form(`/f/${ftoken}/submit`, { url: 'https://93.184.216.34/demo-sites/good/' });
  await verifier.idle();
  const paid = await getMilestone(db, Number(row.id));
  assert.equal(paid.status, 'PAID');
  assert.match(paid.capture_id, /^SIM-CAPTURE-/);
  assert.equal((await form(`/c/${row.client_token}/refund`, {})).status, 303);
  assert.equal((await getMilestone(db, Number(row.id))).status, 'REFUNDED');
  assert.equal(paypal.calls.length, calls, 'no PayPal calls for simulated milestones');
  // A simulated milestone can never create a real PayPal order.
  assert.equal((await ctx.json(`/api/c/${row.client_token}/order`)).status, 409);
});

test('one-click client demo uses real PayPal with the configured payee, or is disabled', async (t) => {
  const ctx = await setup({});
  t.after(() => ctx.server.close());
  const res = await ctx.form('/demo/client', {});
  assert.equal(res.status, 303);
  const ctoken = res.headers.get('location').split('/').pop();
  const [row] = toRows(await ctx.db.execute({ sql: 'SELECT * FROM milestones WHERE client_token = ?', args: [ctoken] }));
  assert.deepEqual([row.status, row.funding, row.payee_email, row.demo_kind], ['DRAFT', 'paypal', 'demo-payee@example.com', 'try']);
  assert.equal((await ctx.form('/demo/nope', {})).status, 404);

  const off = await setup({}, { demo: {} });
  t.after(() => off.server.close());
  assert.equal((await off.form('/demo/client', {})).status, 503);
});

test('showcase is seeded once, verified, and read-only', async (t) => {
  const ctx = await setup({ 'https://93.184.216.34/demo-sites/broken/': brokenPage });
  const { db, money, verifier, server, form, base } = ctx;
  t.after(() => server.close());
  const seed = () => seedShowcase({ db, money, verifier, baseUrl: 'https://93.184.216.34', wait: async () => true, log: { log() {}, error() {} } });
  await seed();
  await seed();
  await verifier.idle();
  const showcase = await listShowcase(db);
  assert.equal(showcase.length, 2);
  assert.deepEqual(showcase.map((m) => m.status), ['PAID', 'FAILED']);
  const failed = showcase[1];
  assert.equal((await form(`/f/${failed.freelancer_token}/submit`, { url: 'https://93.184.216.34/' })).status, 403);
  assert.equal((await form(`/c/${failed.client_token}/void`, {})).status, 403);
  assert.equal((await form(`/c/${showcase[0].client_token}/refund`, {})).status, 403);
  assert.match(await (await fetch(`${base}/`)).text(), /See finished examples/);
});

test('old try-demos are cleaned up; real and showcase milestones are kept', async (t) => {
  const ctx = await setup({});
  const { db, money, server, m } = ctx;
  t.after(() => server.close());
  const old = await createDemoMilestone(db, money, { kind: 'freelancer' });
  await createDemoMilestone(db, money, { kind: 'freelancer' });
  await createDemoMilestone(db, money, { kind: 'freelancer', demoKind: 'showcase' });
  await db.execute({ sql: "UPDATE milestones SET created_at = datetime('now', '-2 days') WHERE id IN (?, ?)", args: [old.id, m.id] });
  assert.equal(await deleteOldDemos(db, 24), 1);
  assert.equal(await getMilestone(db, old.id), null);
  assert.ok(await getMilestone(db, m.id), 'real milestone kept even if old');
});

test('live endpoint streams status changes over SSE', async (t) => {
  const ctx = await setup({});
  const { server, base, m } = ctx;
  t.after(() => server.close());
  const ac = new AbortController();
  const res = await fetch(`${base}/live/${m.client_token}`, { signal: ac.signal });
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const reader = res.body.getReader();
  const seen = [];
  const readUntil = async (pred) => {
    const dec = new TextDecoder();
    let buf = '';
    while (!pred()) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const chunk of buf.split('\n\n').slice(0, -1)) if (chunk.startsWith('data: ')) seen.push(JSON.parse(chunk.slice(6)));
      buf = buf.split('\n\n').pop();
    }
  };
  await readUntil(() => seen.length >= 1);
  assert.deepEqual(seen[0], { type: 'hello', status: 'DRAFT', step: null });
  await fund(ctx);
  await readUntil(() => seen.some((e) => e.status === 'FUNDED'));
  ac.abort();
  assert.equal((await fetch(`${base}/live/nope`)).status, 404);
});

test('AI outage: attempt is not judged, freelancer is told plainly and can resubmit', async (t) => {
  const ctx = await setup({});
  const { db, paypal, server, base, form, m } = ctx;
  t.after(() => server.close());
  await fund(ctx);
  let fixCalls = 0;
  let judgeCalls = 0;
  const waits = [];
  const downAi = {
    ...mockAi,
    judge: async () => { judgeCalls++; throw new AiError('Gemini quota exceeded (HTTP 429 RESOURCE_EXHAUSTED)', { unavailable: true, quota: true }); },
    fixList: async () => { fixCalls++; return []; },
  };
  const capture = async (url) => ({ checks: { url, ...goodPage }, images: [{ label: 'desktop', data: JPEG }] });
  const down = createVerifier({ db, money: ctx.money, ai: downAi, capture, log: { error() {} }, sleep: async (ms) => { waits.push(ms); } });
  await db.execute({ sql: "UPDATE milestones SET status = 'SUBMITTED' WHERE id = ?", args: [m.id] });
  const s = await db.execute({ sql: "INSERT INTO submissions (milestone_id, url, attempt) VALUES (?, 'https://93.184.216.34/', 1)", args: [m.id] });
  await down.enqueue(m.id, Number(s.lastInsertRowid));
  // The AI was asked 3 times (waits of 20 s and 40 s) before giving up.
  assert.equal(judgeCalls, 3);
  assert.deepEqual(waits, [20_000, 40_000]);
  // Not a failure: back to FUNDED, money still held, nothing captured.
  assert.equal((await getMilestone(db, m.id)).status, 'FUNDED');
  assert.equal(fixCalls, 0, 'no fix list for an attempt that was not judged');
  assert.ok(!paypal.calls.some((c) => c[0] === 'capture' || c[0] === 'void'));
  const [report] = toRows(await db.execute({ sql: 'SELECT judged, passed FROM reports WHERE milestone_id = ?', args: [m.id] }));
  assert.deepEqual([report.judged, report.passed], [0, 0]);

  for (const token of [m.freelancer_token, m.client_token]) {
    const page = await (await fetch(`${base}/${token === m.client_token ? 'c' : 'f'}/${token}`)).text();
    assert.match(page, /id="status-badge">Not judged, please resubmit</);
    assert.match(page, /NOT JUDGED/);
    assert.match(page, /class="outcome notjudged"/);
    assert.doesNotMatch(page, /Changes needed/);
    assert.doesNotMatch(page, /FAIL · /);
    assert.doesNotMatch(page, /<li class="failed"/, 'no red timeline step');
    assert.doesNotMatch(page, /\{&#34;error/);
  }
  const fpage = await (await fetch(`${base}/f/${m.freelancer_token}`)).text();
  assert.match(fpage, /quota exceeded/);
  assert.match(fpage, />Resubmit</);
  const reportHtml = await (await fetch(base + fpage.match(/href="(\/r\/[^"]+)"/)[1])).text();
  assert.match(reportHtml, /Not judged, please resubmit/);
  assert.doesNotMatch(reportHtml, /Changes needed|0\/1|✕/);

  // The freelancer resubmits right away, and a judged attempt then works normally.
  assert.equal((await form(`/f/${m.freelancer_token}/submit`, { url: 'https://93.184.216.34/' })).status, 303);
  await ctx.verifier.idle();
  assert.equal((await getMilestone(db, m.id)).status, 'PAID');
});

test('AI busy once, then answers: the attempt is judged normally', async (t) => {
  const ctx = await setup({ 'https://93.184.216.34/broken': brokenPage });
  const { db, server, m } = ctx;
  t.after(() => server.close());
  await fund(ctx);
  let calls = 0;
  const flakyAi = {
    ...mockAi,
    judge: async (args) => {
      calls++;
      if (calls === 1) throw new AiError('Gemini temporarily unavailable (HTTP 503 UNAVAILABLE)', { unavailable: true });
      return mockAi.judge(args);
    },
  };
  const capture = async (url) => ({ checks: { url, ...brokenPage }, images: [] });
  const v = createVerifier({ db, money: ctx.money, ai: flakyAi, capture, log: { error() {} }, sleep: async () => {} });
  await db.execute({ sql: "UPDATE milestones SET status = 'SUBMITTED' WHERE id = ?", args: [m.id] });
  const s = await db.execute({ sql: "INSERT INTO submissions (milestone_id, url, attempt) VALUES (?, 'https://93.184.216.34/broken', 1)", args: [m.id] });
  await v.enqueue(m.id, Number(s.lastInsertRowid));
  assert.equal(calls, 2);
  assert.equal((await getMilestone(db, m.id)).status, 'FAILED', 'a real verdict: the broken page fails');
  const [r] = toRows(await db.execute({ sql: 'SELECT judged FROM reports WHERE milestone_id = ?', args: [m.id] }));
  assert.equal(r.judged, 1);
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
  assert.match(html, /id="judged-by">Mock · mock</, 'the report names the provider and model that judged it');
  assert.match(page, /Judged by Mock · mock/);
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
  const fresh = createVerifier({ db, money: ctx.money, ai: mockAi, capture, log: { error() {} } });
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
