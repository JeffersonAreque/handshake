// Provider switch. The rest of the app only sees these three functions, and
// always gets validated output.
import { createGemini, AiError } from './gemini.js';
import { createMock } from './mock.js';
import { normalizeVerdicts, normalizeCriteria, normalizeFixes } from './verdicts.js';

export { AiError };

/**
 * @param {{provider: string, model?: string, fallbackModel?: string, apiKey?: string, client?: object}} options
 *   provider: 'gemini' | 'mock'. Fails closed: 'gemini' without a key throws.
 */
export function createAi({ provider = 'mock', model, fallbackModels, apiKey, client } = {}) {
  let adapter;
  if (provider === 'gemini') adapter = createGemini({ apiKey, model: model || undefined, fallbackModels, client });
  else if (provider === 'mock') adapter = createMock();
  else throw new AiError(`Unknown AI_PROVIDER "${provider}" (use gemini or mock)`);

  return {
    provider: adapter.provider,
    model: adapter.model,
    /** Probes each configured model once; returns { chain, health }. */
    checkModels: () => (adapter.checkModels ? adapter.checkModels() : Promise.resolve({ chain: [adapter.model], health: {} })),
    status: () => (adapter.status ? adapter.status() : { chain: [adapter.model], health: {} }),
    /**
     * One verdict per criterion, validated. Returns { verdicts, model } where
     * model is the one that answered (the fallback if the main one was out of quota).
     */
    async judge({ criteria, checks, images = [] }) {
      const { data, model: used } = await adapter.judge({ criteria, checks, images });
      return { verdicts: normalizeVerdicts(criteria, data, checks), model: used };
    },
    async draftCriteria(brief) {
      const { data, model: used } = await adapter.draftCriteria(String(brief));
      const criteria = normalizeCriteria(data);
      if (!criteria.length) throw new AiError('The AI could not draft criteria from this brief');
      return { criteria, model: used };
    },
    async fixList({ criteria, verdicts, checks }) {
      const { data } = await adapter.fixList({ criteria, verdicts, checks });
      return normalizeFixes(data, criteria);
    },
  };
}
