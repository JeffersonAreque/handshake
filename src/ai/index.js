// Provider switch. The rest of the app only sees these three functions, and
// always gets validated output.
import { createGemini, AiError } from './gemini.js';
import { createMock } from './mock.js';
import { normalizeVerdicts, normalizeCriteria, normalizeFixes } from './verdicts.js';

export { AiError };

/**
 * @param {{provider: string, model?: string, apiKey?: string, client?: object}} options
 *   provider: 'gemini' | 'mock'. Fails closed: 'gemini' without a key throws.
 */
export function createAi({ provider = 'mock', model, apiKey, client } = {}) {
  let adapter;
  if (provider === 'gemini') adapter = createGemini({ apiKey, model: model || undefined, client });
  else if (provider === 'mock') adapter = createMock();
  else throw new AiError(`Unknown AI_PROVIDER "${provider}" (use gemini or mock)`);

  return {
    provider: adapter.provider,
    model: adapter.model,
    /** One verdict per criterion, validated; never throws for bad JSON content. */
    async judge({ criteria, checks, images = [] }) {
      return normalizeVerdicts(criteria, await adapter.judge({ criteria, checks, images }), checks);
    },
    async draftCriteria(brief) {
      const criteria = normalizeCriteria(await adapter.draftCriteria(String(brief)));
      if (!criteria.length) throw new AiError('The AI could not draft criteria from this brief');
      return criteria;
    },
    async fixList({ criteria, verdicts, checks }) {
      return normalizeFixes(await adapter.fixList({ criteria, verdicts, checks }), criteria);
    },
  };
}
