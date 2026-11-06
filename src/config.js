import path from 'node:path';

// All configuration comes from environment variables. Secrets are read here
// and never logged; use `describeConfig()` for a safe summary.
const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  dataDir: path.resolve(env.DATA_DIR || 'data'),
  // Turso when both vars are set; otherwise a local SQLite file in dataDir.
  db: env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN
    ? { url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN }
    : { url: `file:${path.resolve(env.DATA_DIR || 'data', 'handshake.db').replace(/\\/g, '/')}` },
  get storage() { return this.db.authToken ? 'turso' : 'local-sqlite'; },
  paypal: {
    apiBase: env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    currency: 'USD',
  },
  ai: {
    provider: (env.AI_PROVIDER || 'mock').trim().toLowerCase(),
    model: (env.AI_MODEL || '').trim() || undefined, // gemini default: gemini-2.5-flash
    // Comma-separated, tried in order when a model is out of quota or not
    // available to the key ('none' disables). Default: gemini-3.5-flash-lite,gemini-flash-lite-latest
    fallbackModels: env.AI_FALLBACK_MODEL === 'none' ? [] : (env.AI_FALLBACK_MODEL || '').trim() || undefined,
    apiKey: (env.GEMINI_API_KEY || '').trim(),
    // Fallback provider after the Gemini chain (or the only one with AI_PROVIDER=groq).
    groq: {
      apiKey: (env.GROQ_API_KEY || '').trim(),
      model: (env.GROQ_MODEL || '').trim() || undefined, // default qwen/qwen3.8-27b (vision)
    },
  },
  demo: {
    // Sandbox business account that receives "Try as client" payments.
    payeeEmail: (env.DEMO_PAYEE_EMAIL || '').trim(),
    // Optional sandbox buyer login shown on demo pages so judges can pay.
    buyerEmail: (env.DEMO_BUYER_EMAIL || '').trim(),
    buyerPassword: env.DEMO_BUYER_PASSWORD || '',
    seed: env.SEED_DEMO !== 'false',
  },
  // Local development only: lets the verifier open localhost / private URLs.
  allowPrivateUrls: env.ALLOW_PRIVATE_URLS === 'true',
};

export function describeConfig() {
  return {
    port: config.port,
    baseUrl: config.baseUrl,
    storage: config.storage,
    paypalApi: config.paypal.apiBase,
    paypalConfigured: Boolean(config.paypal.clientId && config.paypal.clientSecret),
    aiProvider: config.ai.provider,
    aiModel: config.ai.model ?? 'default',
    geminiKeySet: Boolean(config.ai.apiKey),
    groqKeySet: Boolean(config.ai.groq.apiKey),
    allowPrivateUrls: config.allowPrivateUrls,
    demoClient: Boolean(config.demo.payeeEmail),
    demoBuyerShown: Boolean(config.demo.buyerEmail),
    seedDemo: config.demo.seed,
  };
}
