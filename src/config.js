import path from 'node:path';

// All configuration comes from environment variables. Secrets are read here
// and never logged; use `describeConfig()` for a safe summary.
const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  dataDir: path.resolve(env.DATA_DIR || 'data'),
  paypal: {
    apiBase: env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    currency: 'USD',
  },
  ai: {
    provider: (env.AI_PROVIDER || 'mock').toLowerCase(),
  },
  // Local development only: lets the verifier open localhost / private URLs.
  allowPrivateUrls: env.ALLOW_PRIVATE_URLS === 'true',
};

export function describeConfig() {
  return {
    port: config.port,
    baseUrl: config.baseUrl,
    dataDir: config.dataDir,
    paypalApi: config.paypal.apiBase,
    paypalConfigured: Boolean(config.paypal.clientId && config.paypal.clientSecret),
    aiProvider: config.ai.provider,
    allowPrivateUrls: config.allowPrivateUrls,
  };
}
