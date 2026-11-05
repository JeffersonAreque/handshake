// End-to-end money flow through the HTTP app with a fake PayPal and a fake
// browser capture (no network, no Chromium), on an in-memory database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getMilestone, toRows, countReports } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createVerifier } from '../src/verifier/service.js';
import { mockJudge } from '../src/verifier/mockJudge.js';

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
  const verifier = createVerifier({ db, paypal, judge: mockJudge, capture, log: { error() {} } });
  const config = { baseUrl: 'http://test', paypal: { clientId: 'cid' }, allowPrivateUrls: false, storage: 'memory' };
  const app = createApp({ db, paypal, verifier, config });
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

  assert.equal((await form(`/c/${m.client_token}/void`, {})).status, 303);
  assert.equal((await getMilestone(db, m.id)).status, 'VOIDED');
  assert.ok(!paypal.calls.some((c) => c[0] === 'capture'));
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
  const fresh = createVerifier({ db, paypal, judge: mockJudge, capture, log: { error() {} } });
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

test('invalid milestone input is rejected', async (t) => {
  const { server, form } = await setup({});
  t.after(() => server.close());
  const res = await form('/milestones', { title: 'x', amount: '0', payeeEmail: 'nope', criteria: '' });
  assert.equal(res.status, 422);
});
