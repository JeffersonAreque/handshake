// Money movement per milestone. Real milestones use PayPal. One-click
// freelancer demo milestones use a simulated hold ("funding = simulated"),
// clearly labeled in the UI, so judges can try the verifier without a
// sandbox buyer login. Nothing else ever takes the simulated path.
import { randomBytes } from 'node:crypto';

const simId = (prefix) => `SIM-${prefix}-${randomBytes(5).toString('hex').toUpperCase()}`;

const simulated = {
  kind: 'simulated',
  async capture() { return { id: simId('CAPTURE'), status: 'COMPLETED' }; },
  async void() { return { status: 'VOIDED' }; },
  async refund() { return { id: simId('REFUND'), status: 'COMPLETED' }; },
};

export function createMoney(paypal) {
  const real = {
    kind: 'paypal',
    capture: (m) => paypal.captureAuthorization(m.authorization_id),
    void: (m) => paypal.voidAuthorization(m.authorization_id),
    refund: (m) => paypal.refundCapture(m.capture_id),
  };
  return {
    for: (m) => (m.funding === 'simulated' ? simulated : real),
    simulatedHoldId: () => simId('AUTH'),
  };
}
