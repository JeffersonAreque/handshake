// Provider switch. The rest of the app only sees these functions, and always
// gets validated output. Providers are tried in order: the primary one
// (AI_PROVIDER), then Groq as a fallback when GROQ_API_KEY is set. A
// provider is skipped only when it is unavailable (quota, outage, model gone).
import { createGemini, AiError } from './gemini.js';
import { createGroq } from './groq.js';
import { createMock } from './mock.js';
import { normalizeVerdicts, normalizeCriteria, normalizeFixes } from './verdicts.js';

export { AiError };

const LABELS = { gemini: 'Gemini', groq: 'Groq', mock: 'Mock' };
export const providerLabel = (p) => LABELS[p] ?? p;

/**
 * @param {object} o
 * @param {'gemini'|'groq'|'mock'} o.provider  primary provider. Fails closed: a provider without its key throws.
 * @param {{apiKey?: string, model?: string, fetch?: Function}} [o.groq]  Groq fallback (used when apiKey is set)
 */
export function createAi({ provider = 'mock', model, fallbackModels, apiKey, client, groq } = {}) {
  const adapters = [];
  if (provider === 'gemini') adapters.push(createGemini({ apiKey, model: model || undefined, fallbackModels, client }));
  else if (provider === 'groq') adapters.push(createGroq({ ...groq, model: groq?.model || undefined }));
  else if (provider === 'mock') adapters.push(createMock());
  else throw new AiError(`Unknown AI_PROVIDER "${provider}" (use gemini, groq or mock)`);
  if (provider === 'gemini' && groq?.apiKey) adapters.push(createGroq({ ...groq, model: groq.model || undefined }));

  /** Runs `fn` on each provider in order; moves on only when one is unavailable. */
  async function run(fn) {
    let lastErr;
    for (const adapter of adapters) {
      try {
        return { ...(await fn(adapter)), provider: adapter.provider };
      } catch (err) {
        lastErr = err;
        if (!(err instanceof AiError && err.unavailable)) throw err;
      }
    }
    throw lastErr;
  }

  // Chain entries are "provider:model", in the order they are tried.
  const merge = (statuses) => ({
    chain: statuses.flatMap((s, i) => s.chain.map((m) => `${adapters[i].provider}:${m}`)),
    health: Object.fromEntries(statuses.flatMap((s, i) => Object.entries(s.health).map(([m, h]) => [`${adapters[i].provider}:${m}`, h]))),
  });
  const statusOf = (a) => (a.status ? a.status() : { chain: [a.model], health: {} });

  return {
    provider: adapters[0].provider,
    model: adapters[0].model,
    /** Probes each configured model once; returns { chain, health }. */
    checkModels: async () => {
      const statuses = [];
      for (const a of adapters) statuses.push(a.checkModels ? await a.checkModels() : statusOf(a));
      return merge(statuses);
    },
    status: () => merge(adapters.map(statusOf)),
    /**
     * One verdict per criterion, validated. Returns { verdicts, provider, model }
     * for the provider and model that answered.
     */
    async judge({ criteria, checks, images = [] }) {
      const { data, model: used, provider: by } = await run((a) => a.judge({ criteria, checks, images }));
      return { verdicts: normalizeVerdicts(criteria, data, checks), provider: by, model: used };
    },
    async draftCriteria(brief) {
      const { data, model: used, provider: by } = await run((a) => a.draftCriteria(String(brief)));
      const criteria = normalizeCriteria(data);
      if (!criteria.length) throw new AiError('The AI could not draft criteria from this brief');
      return { criteria, provider: by, model: used };
    },
    async fixList({ criteria, verdicts, checks }) {
      const { data } = await run((a) => a.fixList({ criteria, verdicts, checks }));
      return normalizeFixes(data, criteria);
    },
  };
}
