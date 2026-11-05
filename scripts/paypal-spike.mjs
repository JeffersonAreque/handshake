// PayPal sandbox spike for Handshake.
// Proves: create order (AUTHORIZE) -> buyer approval -> authorize -> capture,
// and a second order: ... -> authorize -> void.
//
// Run: npm run spike   (reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from .env)
// Secrets, the access token and auth headers are never printed.

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const API = 'https://api-m.sandbox.paypal.com';
const PORT = Number(process.env.SPIKE_PORT || 8787);
const BASE = `http://localhost:${PORT}`;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error('Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET. Copy .env.example to .env and fill in sandbox credentials.');
  process.exit(1);
}

class PayPalError extends Error {}

async function getAccessToken() {
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    // Body here has only error/error_description; still keep it minimal.
    const body = await res.json().catch(() => ({}));
    throw new PayPalError(`OAuth failed: HTTP ${res.status} ${body.error ?? ''} ${body.error_description ?? ''}`.trim());
  }
  return (await res.json()).access_token;
}

let token;
async function pp(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': randomUUID(), // idempotency key
      Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const details = (data.details ?? []).map((d) => `${d.issue}: ${d.description}`).join('; ');
    throw new PayPalError(
      `${method} ${path} -> HTTP ${res.status} ${data.name ?? ''} ${data.message ?? ''} ${details} (debug_id ${data.debug_id ?? 'n/a'})`
    );
  }
  return data;
}

// --- Local return server: PayPal redirects the buyer here after approval ---
const waiters = new Map(); // orderId -> { resolve, reject }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  const orderId = url.searchParams.get('token');
  const waiter = orderId && waiters.get(orderId);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (url.pathname === '/return' && waiter) {
    res.end('<h2>Approved. You can close this tab and go back to the terminal.</h2>');
    waiter.resolve();
  } else if (url.pathname === '/cancel' && waiter) {
    res.end('<h2>Cancelled.</h2>');
    waiter.reject(new Error(`Buyer cancelled order ${orderId}`));
  } else {
    res.end('<p>Handshake spike: nothing to do here.</p>');
  }
});

function waitForApproval(orderId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for approval of ${orderId}`)), APPROVAL_TIMEOUT_MS);
    waiters.set(orderId, {
      resolve: () => { clearTimeout(timer); waiters.delete(orderId); resolve(); },
      reject: (e) => { clearTimeout(timer); waiters.delete(orderId); reject(e); },
    });
  });
}

// --- Escrow steps ---
async function createAuthorizeOrder(label, amount) {
  const order = await pp('POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [{
      reference_id: `milestone-${label}`,
      description: `Handshake spike milestone (${label})`,
      amount: { currency_code: 'USD', value: amount },
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'Handshake',
          user_action: 'CONTINUE',
          shipping_preference: 'NO_SHIPPING',
          return_url: `${BASE}/return`,
          cancel_url: `${BASE}/cancel`,
        },
      },
    },
  });
  const approve = order.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return { id: order.id, status: order.status, approveUrl: approve.href };
}

async function approveAndAuthorize(label, amount) {
  const order = await createAuthorizeOrder(label, amount);
  console.log(`\n[${label}] ORDER ${order.id}: ${order.status}`);
  console.log(`[${label}] Open this link and approve as the sandbox BUYER (personal) account:\n  ${order.approveUrl}`);
  await waitForApproval(order.id);
  console.log(`[${label}] Buyer approved.`);

  const authorized = await pp('POST', `/v2/checkout/orders/${order.id}/authorize`, {});
  const auth = authorized.purchase_units[0].payments.authorizations[0];
  console.log(`[${label}] ORDER ${authorized.status}; AUTHORIZATION ${auth.id}: ${auth.status} ${auth.amount.value} ${auth.amount.currency_code} (expires ${auth.expiration_time})`);
  return auth;
}

async function main() {
  token = await getAccessToken();
  console.log('OAuth token obtained (sandbox).');
  await new Promise((r) => server.listen(PORT, r));
  console.log(`Return server listening on ${BASE}`);

  // Run 1: funds held -> AI says "pass" -> capture (freelancer paid)
  const a1 = await approveAndAuthorize('capture', '25.00');
  const capture = await pp('POST', `/v2/payments/authorizations/${a1.id}/capture`, { final_capture: true });
  console.log(`[capture] CAPTURE ${capture.id}: ${capture.status}`);

  // Run 2: funds held -> client cancels -> void (nothing charged)
  const a2 = await approveAndAuthorize('void', '10.00');
  await pp('POST', `/v2/payments/authorizations/${a2.id}/void`);
  const voided = await pp('GET', `/v2/payments/authorizations/${a2.id}`);
  console.log(`[void] AUTHORIZATION ${voided.id}: ${voided.status}`);

  const ok = capture.status === 'COMPLETED' && voided.status === 'VOIDED';
  console.log(`\nCAPTURE: ${capture.status}\nVOID: ${voided.status}\n${ok ? 'SPIKE PASSED' : 'SPIKE FAILED'}`);
  return ok;
}

main()
  .then((ok) => { server.close(); process.exit(ok ? 0 : 1); })
  .catch((err) => {
    console.error(`\nSPIKE FAILED: ${err.message}`);
    server.close();
    process.exit(1);
  });
