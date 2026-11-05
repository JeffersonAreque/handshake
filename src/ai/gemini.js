// Gemini adapter (@google/genai). Returns raw parsed JSON; validation happens
// in ./verdicts.js. The API key is passed to the SDK only and never logged.
import { GoogleGenAI, Type } from '@google/genai';
import { JUDGE_SYSTEM, judgeUserText, DRAFT_SYSTEM, draftUserText, FIX_SYSTEM, fixUserText } from './prompts.js';

const TIMEOUT_MS = 90_000;
const RETRY_DELAYS_MS = [1_500, 4_000];

const VERDICTS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verdicts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.INTEGER },
          pass: { type: Type.BOOLEAN },
          reason: { type: Type.STRING },
          evidence: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['index', 'pass', 'reason', 'evidence'],
        propertyOrdering: ['index', 'reason', 'evidence', 'pass'],
      },
    },
  },
  required: ['verdicts'],
};
const CRITERIA_SCHEMA = {
  type: Type.OBJECT,
  properties: { criteria: { type: Type.ARRAY, items: { type: Type.STRING } } },
  required: ['criteria'],
};
const FIXES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    fixes: {
      type: Type.ARRAY,
      items: { type: Type.OBJECT, properties: { index: { type: Type.INTEGER }, fix: { type: Type.STRING } }, required: ['index', 'fix'] },
    },
  },
  required: ['fixes'],
};

/** `unavailable` = the provider failed (quota, outage), nothing was judged. */
export class AiError extends Error {
  constructor(message, { unavailable = false, quota = false } = {}) {
    super(message);
    this.unavailable = unavailable;
    this.quota = quota;
  }
}

const retryable = (err) => /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE|fetch failed|timed out/i.test(String(err?.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Short, safe description of an SDK error (no raw JSON, URLs or request details). */
export function describeGeminiError(err) {
  const msg = String(err?.message ?? err);
  const code = msg.match(/"code"\s*:\s*(\d{3})/)?.[1] ?? msg.match(/\b(4\d\d|5\d\d)\b/)?.[1];
  const status = msg.match(/RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|INTERNAL|PERMISSION_DENIED|INVALID_ARGUMENT|NOT_FOUND/)?.[0];
  const quota = code === '429' || status === 'RESOURCE_EXHAUSTED' || /quota/i.test(msg);
  const unavailable = quota || /^5/.test(code ?? '') || ['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'INTERNAL'].includes(status) || /timed out|fetch failed/i.test(msg);
  const what = quota ? 'quota exceeded' : unavailable ? 'temporarily unavailable' : 'request failed';
  return { message: `Gemini ${what}${code ? ` (HTTP ${code}${status ? ` ${status}` : ''})` : ''}`, quota, unavailable };
}

export function createGemini({ apiKey, model = 'gemini-2.5-flash', fallbackModel = 'gemini-2.5-flash-lite', client, sleepFn = sleep }) {
  if (!client && !apiKey) throw new AiError('GEMINI_API_KEY is not set');
  const ai = client ?? new GoogleGenAI({ apiKey });

  /** Calls the main model; if its quota is used up, tries the fallback model once. */
  async function generate(req) {
    try {
      return { data: await generateWith(model, req), model };
    } catch (err) {
      if (!(err instanceof AiError && err.quota) || !fallbackModel || fallbackModel === model) throw err;
      return { data: await generateWith(fallbackModel, req), model: fallbackModel };
    }
  }

  async function generateWith(model, { system, parts, schema, temperature = 0 }) {
    for (let attempt = 0; ; attempt++) {
      let timer;
      try {
        const res = await Promise.race([
          ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts }],
            config: { systemInstruction: system, responseMimeType: 'application/json', responseSchema: schema, temperature },
          }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new AiError('Gemini request timed out')), TIMEOUT_MS); }),
        ]);
        const text = typeof res.text === 'function' ? res.text() : res.text;
        try { return JSON.parse(text); } catch { throw new AiError('Gemini returned invalid JSON'); }
      } catch (err) {
        if (err instanceof AiError && !err.unavailable && /invalid JSON/.test(err.message)) throw err;
        const info = describeGeminiError(err);
        // A used-up quota won't recover in seconds: don't retry it.
        if (!info.quota && attempt < RETRY_DELAYS_MS.length && retryable(err)) { await sleepFn(RETRY_DELAYS_MS[attempt]); continue; }
        throw new AiError(info.message, info);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return {
    provider: 'gemini',
    model,
    judge: ({ criteria, checks, images }) =>
      generate({
        system: JUDGE_SYSTEM,
        schema: VERDICTS_SCHEMA,
        parts: [
          { text: judgeUserText({ criteria, checks }) },
          ...images.flatMap((img) => [
            { text: `${img.label}.jpg:` },
            { inlineData: { mimeType: img.mime ?? 'image/jpeg', data: Buffer.from(img.data).toString('base64') } },
          ]),
        ],
      }),
    draftCriteria: (brief) => generate({ system: DRAFT_SYSTEM, schema: CRITERIA_SCHEMA, parts: [{ text: draftUserText(brief) }], temperature: 0.3 }),
    fixList: ({ criteria, verdicts, checks }) =>
      generate({ system: FIX_SYSTEM, schema: FIXES_SCHEMA, parts: [{ text: fixUserText({ criteria, verdicts, checks }) }], temperature: 0.2 }),
  };
}
