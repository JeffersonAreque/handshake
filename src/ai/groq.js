// Groq adapter (OpenAI-compatible chat completions, plain fetch). Same
// prompts and the same raw output shape as the Gemini adapter; validation
// happens in ./verdicts.js. The API key goes only into the Authorization
// header and is never logged.
import { AiError } from './gemini.js';
import { JUDGE_SYSTEM, judgeUserText, DRAFT_SYSTEM, draftUserText, FIX_SYSTEM, fixUserText } from './prompts.js';

const API = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 90_000;
const RETRY_DELAYS_MS = [2_000, 6_000];

// The only model on this key that accepts images (gpt-oss models answer
// "content must be a string"). It also supports strict json_schema output.
export const DEFAULT_GROQ_MODEL = 'qwen/qwen3.8-27b';

// Strict JSON Schema: every property required, no extra properties.
const strict = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const VERDICTS_SCHEMA = strict({
  verdicts: {
    type: 'array',
    items: strict({ index: { type: 'integer' }, reason: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } }, pass: { type: 'boolean' } }),
  },
});
const CRITERIA_SCHEMA = strict({ criteria: { type: 'array', items: { type: 'string' } } });
const FIXES_SCHEMA = strict({ fixes: { type: 'array', items: strict({ index: { type: 'integer' }, fix: { type: 'string' } }) } });
const HEALTH_SCHEMA = strict({ ok: { type: 'boolean' } });

/** Short, safe description of a Groq HTTP error (no body echo, no headers). */
export function describeGroqError(status, body) {
  const code = String(body?.error?.code ?? body?.error?.type ?? '');
  const quota = status === 429 || /rate_limit|quota/i.test(code);
  const gone = status === 404 || status === 401 || status === 403 || /model_not_found|decommissioned/i.test(code);
  const unavailable = quota || gone || status >= 500 || status === 0;
  const what = quota ? 'rate limit or quota exceeded' : gone ? 'model or key not available' : unavailable ? 'temporarily unavailable' : 'request failed';
  return { message: `Groq ${what}${status ? ` (HTTP ${status}${code ? ` ${code}` : ''})` : ''}`, quota, gone, unavailable };
}

export function createGroq({ apiKey, model = DEFAULT_GROQ_MODEL, fetch = globalThis.fetch, sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!apiKey) throw new AiError('GROQ_API_KEY is not set');
  const health = {};

  async function generate({ system, content, schema, name, temperature = 0 }, { retries = RETRY_DELAYS_MS.length } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      let body = {};
      try {
        res = await fetch(API, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            temperature,
            response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
            messages: [{ role: 'system', content: system }, { role: 'user', content }],
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        body = await res.json().catch(() => ({}));
      } catch {
        res = { ok: false, status: 0 }; // network error or timeout
      }
      if (res.ok) {
        const text = body.choices?.[0]?.message?.content;
        try { return { data: JSON.parse(text), model }; } catch { throw new AiError('Groq returned invalid JSON'); }
      }
      const info = describeGroqError(res.status, body);
      if (!info.quota && !info.gone && info.unavailable && attempt < retries) { await sleepFn(RETRY_DELAYS_MS[attempt]); continue; }
      throw new AiError(info.message, info);
    }
  }

  async function checkModels() {
    try {
      await generate({ system: 'Health check.', content: 'Return {"ok": true}.', schema: HEALTH_SCHEMA, name: 'health' }, { retries: 0 });
      health[model] = { ok: true, checkedAt: new Date().toISOString() };
    } catch (err) {
      health[model] = { ok: false, error: err.message, gone: Boolean(err.gone), checkedAt: new Date().toISOString() };
    }
    return status();
  }

  const status = () => ({ chain: [model], health: { ...health } });

  return {
    provider: 'groq',
    model,
    checkModels,
    status,
    judge: ({ criteria, checks, images = [] }) =>
      generate({
        system: JUDGE_SYSTEM,
        schema: VERDICTS_SCHEMA,
        name: 'verdicts',
        content: [
          { type: 'text', text: judgeUserText({ criteria, checks }) },
          ...images.flatMap((img) => [
            { type: 'text', text: `${img.label}.jpg:` },
            { type: 'image_url', image_url: { url: `data:${img.mime ?? 'image/jpeg'};base64,${Buffer.from(img.data).toString('base64')}` } },
          ]),
        ],
      }),
    draftCriteria: (brief) => generate({ system: DRAFT_SYSTEM, schema: CRITERIA_SCHEMA, name: 'criteria', content: draftUserText(brief), temperature: 0.3 }),
    fixList: ({ criteria, verdicts, checks }) =>
      generate({ system: FIX_SYSTEM, schema: FIXES_SCHEMA, name: 'fixes', content: fixUserText({ criteria, verdicts, checks }), temperature: 0.2 }),
  };
}
