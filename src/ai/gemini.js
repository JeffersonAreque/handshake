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

export class AiError extends Error {}

const retryable = (err) => /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE|fetch failed|timed out/i.test(String(err?.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createGemini({ apiKey, model = 'gemini-2.5-flash', client, sleepFn = sleep }) {
  if (!client && !apiKey) throw new AiError('GEMINI_API_KEY is not set');
  const ai = client ?? new GoogleGenAI({ apiKey });

  async function generate({ system, parts, schema, temperature = 0 }) {
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
        if (attempt < RETRY_DELAYS_MS.length && retryable(err)) { await sleepFn(RETRY_DELAYS_MS[attempt]); continue; }
        // SDK errors may embed request details; keep only the first line.
        throw new AiError(`Gemini error: ${String(err?.message ?? err).split('\n')[0].slice(0, 200)}`);
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
