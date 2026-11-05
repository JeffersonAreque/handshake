import { config, describeConfig } from './config.js';
import { openDb } from './db.js';
import { createPayPal } from './paypal.js';
import { createApp } from './app.js';
import { createAi } from './ai/index.js';
import { createVerifier } from './verifier/service.js';
import { captureEvidence } from './verifier/browser.js';

// Fails closed: AI_PROVIDER=gemini without GEMINI_API_KEY stops the server
// instead of silently approving deliveries with the mock.
const ai = createAi(config.ai);
const db = await openDb(config.db);
const paypal = createPayPal(config.paypal);
const verifier = createVerifier({ db, paypal, ai, capture: captureEvidence, allowPrivate: config.allowPrivateUrls });

const app = createApp({ db, paypal, verifier, ai, config });
app.listen(config.port, () => {
  console.log(`Handshake listening on ${config.port} (node ${process.version})`, { ...describeConfig(), aiModel: ai.model });
  verifier.recover().catch((err) => console.error(`[recover] ${err.message}`));
});
