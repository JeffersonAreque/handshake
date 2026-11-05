import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal, PayPalError } from '../src/paypal.js';

const SECRET = 'super-secret-value';

function mockFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    const handler = handlers[`${init.method} ${path}`];
    if (!handler) throw new Error(`Unexpected ${init.method} ${path}`);
    const { status = 200, body = {} } = handler(init);
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

const tokenHandler = () => ({ body: { access_token: 'TOKEN', expires_in: 3600 } });

test('createOrder uses AUTHORIZE with the freelancer as payee, and caches the token', async () => {
  const fetch = mockFetch({
    'POST /v1/oauth2/token': tokenHandler,
    'POST /v2/checkout/orders': () => ({ status: 201, body: { id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED' } }),
  });
  const pp = createPayPal({ clientId: 'id', clientSecret: SECRET, fetch });
  const order = await pp.createOrder({ amount: '25.00', payeeEmail: 'freelancer@example.com', referenceId: 'm-1', description: 'Test' });
  await pp.createOrder({ amount: '5.00', payeeEmail: 'x@example.com', referenceId: 'm-2' });

  assert.deepEqual(order, { id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED' });
  const orderCalls = fetch.calls.filter((c) => c.path === '/v2/checkout/orders');
  const body = JSON.parse(orderCalls[0].init.body);
  assert.equal(body.intent, 'AUTHORIZE');
  assert.deepEqual(body.purchase_units[0].payee, { email_address: 'freelancer@example.com' });
  assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'USD', value: '25.00' });
  assert.equal(fetch.calls.filter((c) => c.path === '/v1/oauth2/token').length, 1, 'token is cached');
  assert.ok(orderCalls[0].init.headers['PayPal-Request-Id']);
});

test('authorize, capture and void', async () => {
  const fetch = mockFetch({
    'POST /v1/oauth2/token': tokenHandler,
    'POST /v2/checkout/orders/ORDER1/authorize': () => ({ status: 201, body: { purchase_units: [{ payments: { authorizations: [{ id: 'AUTH1', status: 'CREATED' }] } }] } }),
    'POST /v2/payments/authorizations/AUTH1/capture': (init) => ({ status: 201, body: { id: 'CAP1', status: 'COMPLETED', final: JSON.parse(init.body).final_capture } }),
    'POST /v2/payments/authorizations/AUTH2/void': () => ({ status: 204 }),
    'GET /v2/payments/authorizations/AUTH2': () => ({ body: { id: 'AUTH2', status: 'VOIDED' } }),
  });
  const pp = createPayPal({ clientId: 'id', clientSecret: SECRET, fetch });
  assert.equal((await pp.authorizeOrder('ORDER1')).id, 'AUTH1');
  const cap = await pp.captureAuthorization('AUTH1');
  assert.equal(cap.status, 'COMPLETED');
  assert.equal(cap.final, true);
  assert.equal((await pp.voidAuthorization('AUTH2')).status, 'VOIDED');
});

test('errors carry PayPal details but never the secret or token', async () => {
  const fetch = mockFetch({
    'POST /v1/oauth2/token': tokenHandler,
    'POST /v2/payments/authorizations/AUTH1/capture': () => ({
      status: 422,
      body: { name: 'UNPROCESSABLE_ENTITY', debug_id: 'dbg1', details: [{ issue: 'AUTHORIZATION_VOIDED' }] },
    }),
  });
  const pp = createPayPal({ clientId: 'id', clientSecret: SECRET, fetch });
  await assert.rejects(pp.captureAuthorization('AUTH1'), (err) => {
    assert.ok(err instanceof PayPalError);
    assert.match(err.message, /422/);
    assert.match(err.message, /AUTHORIZATION_VOIDED/);
    assert.equal(err.debugId, 'dbg1');
    assert.ok(!err.message.includes(SECRET) && !err.message.includes('TOKEN'));
    return true;
  });
});

test('OAuth failure does not leak credentials', async () => {
  const fetch = mockFetch({ 'POST /v1/oauth2/token': () => ({ status: 401, body: { error: 'invalid_client' } }) });
  const pp = createPayPal({ clientId: 'id', clientSecret: SECRET, fetch });
  await assert.rejects(pp.createOrder({ amount: '1.00', payeeEmail: 'a@b.co' }), (err) => !err.message.includes(SECRET) && /invalid_client/.test(err.message));
});
