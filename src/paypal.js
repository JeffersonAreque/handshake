// PayPal Orders v2 / Payments v2 client (sandbox by default).
// The client secret, access token and Authorization headers are never logged
// or included in error messages.

import { randomUUID } from 'node:crypto';

export class PayPalError extends Error {
  constructor(message, { status, name, debugId } = {}) {
    super(message);
    this.status = status;
    this.paypalName = name;
    this.debugId = debugId;
  }
}

export function createPayPal({ clientId, clientSecret, apiBase = 'https://api-m.sandbox.paypal.com', fetch = globalThis.fetch }) {
  let cached = null; // { token, expiresAt }

  async function getToken() {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    if (!clientId || !clientSecret) throw new PayPalError('PayPal credentials are not configured');
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(`${apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError(`PayPal OAuth failed: HTTP ${res.status} ${body.error ?? ''}`.trim(), { status: res.status });
    // Refresh one minute before PayPal's expiry.
    cached = { token: body.access_token, expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 0) - 60) * 1000 };
    return cached.token;
  }

  async function call(method, path, body) {
    const token = await getToken();
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': randomUUID(),
        Prefer: 'return=representation',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) cached = null;
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!res.ok) {
      const details = (data.details ?? []).map((d) => d.issue).filter(Boolean).join(', ');
      throw new PayPalError(
        `PayPal ${method} ${path.replace(/\/[A-Z0-9]{10,}/g, '/…')} failed: HTTP ${res.status} ${data.name ?? ''}${details ? ` (${details})` : ''}`.trim(),
        { status: res.status, name: data.name, debugId: data.debug_id }
      );
    }
    return data;
  }

  return {
    /** Create an AUTHORIZE order whose funds go to the freelancer (payee). */
    async createOrder({ amount, currency = 'USD', payeeEmail, referenceId, description }) {
      const order = await call('POST', '/v2/checkout/orders', {
        intent: 'AUTHORIZE',
        purchase_units: [{
          reference_id: referenceId,
          description: description?.slice(0, 127),
          amount: { currency_code: currency, value: amount },
          payee: { email_address: payeeEmail },
        }],
        payment_source: {
          paypal: {
            experience_context: { brand_name: 'Handshake', shipping_preference: 'NO_SHIPPING', user_action: 'CONTINUE' },
          },
        },
      });
      return { id: order.id, status: order.status };
    },

    async getOrder(orderId) {
      return call('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    },

    /** Authorize an approved order. Returns the authorization object. */
    async authorizeOrder(orderId) {
      const data = await call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {});
      const auth = data.purchase_units?.[0]?.payments?.authorizations?.[0];
      if (!auth) throw new PayPalError('PayPal authorize returned no authorization');
      return auth;
    },

    async captureAuthorization(authorizationId) {
      return call('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, { final_capture: true });
    },

    async voidAuthorization(authorizationId) {
      await call('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`);
      return call('GET', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`);
    },

    async refundCapture(captureId) {
      return call('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {});
    },
  };
}
