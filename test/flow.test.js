// End-to-end money flow through the HTTP app with a fake PayPal and a fake
// browser capture (no network, no Chromium).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getMilestone } from '../src/db.js';
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

async function setup(pages) {
  const db = openDb(':memory:');
  const paypal = fakePayPal();
  const capture = async (url) => ({ checks: { url, ...(pages[url] ?? goodPage) }, screenshots: [] });
  const verifier = createVerifier({ db, paypal, judge: mockJudge, capture, evidenceDir: 'unused', log: { error() {} } });
  const config = { baseUrl: 'http://test', dataDir: 'unused', paypal: { clientId: 'cid' }, allowPrivateUrls: false };
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
  const m = db.prepare('SELECT * FROM milestones WHERE client_token = ?').get(clientToken);
  return { db, paypal, verifier, server, base, form, json, m };
}

test('create → fund → submit → pass → paid to the freelancer', async (t) => {
  const { db, paypal, verifier, server, base, form, json, m } = await setup({});
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
  assert.equal(getMilestone(db, m.id).status, 'FUNDED');

  // Freelancer token can't use client endpoints.
  assert.equal((await json(`/api/c/${m.freelancer_token}/order`)).status, 404);

  const submit = await form(`/f/${m.freelancer_token}/submit`, { url: 'https://93.184.216.34/' });
  assert.equal(submit.status, 303);
  await verifier.idle();
  const after = getMilestone(db, m.id);
  assert.equal(after.status, 'PAID');
  assert.equal(after.capture_id, 'CAP1');
  assert.deepEqual(paypal.calls.map((c) => c[0]), ['createOrder', 'authorize', 'capture']);

  const page = await (await fetch(`${base}/f/${m.freelancer_token}`)).text();
  assert.match(page, /freelancer@example\.com/);
  assert.match(page, /PASS/);
});

test('fail → resubmit → client voids; nothing is captured', async (t) => {
  const { db, paypal, verifier, server, form, json, m } = await setup({ 'https://93.184.216.34/broken': brokenPage });
  t.after(() => server.close());
  await json(`/api/c/${m.client_token}/order`);
  await json(`/api/c/${m.client_token}/authorize`, { orderID: 'ORDER1' });

  await form(`/f/${m.freelancer_token}/submit`, { url: 'https://93.184.216.34/broken' });
  await verifier.idle();
  assert.equal(getMilestone(db, m.id).status, 'FAILED');

  await form(`/f/${m.freelancer_token}/submit`, { url: 'https://93.184.216.34/broken' });
  await verifier.idle();
  assert.equal(getMilestone(db, m.id).status, 'FAILED');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reports WHERE milestone_id = ?').get(m.id).n, 2);

  assert.equal((await form(`/c/${m.client_token}/void`, {})).status, 303);
  assert.equal(getMilestone(db, m.id).status, 'VOIDED');
  assert.ok(!paypal.calls.some((c) => c[0] === 'capture'));
});

test('private URLs are rejected at submission', async (t) => {
  const { db, server, form, json, m } = await setup({});
  t.after(() => server.close());
  await json(`/api/c/${m.client_token}/order`);
  await json(`/api/c/${m.client_token}/authorize`, { orderID: 'ORDER1' });
  for (const url of ['http://localhost:3000', 'http://169.254.169.254/', 'file:///etc/passwd']) {
    assert.equal((await form(`/f/${m.freelancer_token}/submit`, { url })).status, 422, url);
  }
  assert.equal(getMilestone(db, m.id).status, 'FUNDED');
});

test('invalid milestone input is rejected', async (t) => {
  const { server, form } = await setup({});
  t.after(() => server.close());
  const res = await form('/milestones', { title: 'x', amount: '0', payeeEmail: 'nope', criteria: '' });
  assert.equal(res.status, 422);
});
