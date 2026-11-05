// In-process event bus for live progress (one Render instance, so no broker
// needed). Pages subscribe over SSE; see GET /live/:token.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(1000);

const steps = new Map(); // milestoneId -> current verification step text

export function publishStatus(milestoneId, status) {
  if (!['SUBMITTED', 'VERIFYING'].includes(status)) steps.delete(milestoneId);
  bus.emit(`m:${milestoneId}`, { type: 'status', status });
}

export function publishStep(milestoneId, step) {
  steps.set(milestoneId, step);
  bus.emit(`m:${milestoneId}`, { type: 'step', step });
}

export const currentStep = (milestoneId) => steps.get(milestoneId) ?? null;
