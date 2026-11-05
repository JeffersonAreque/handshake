import { config, describeConfig } from './config.js';
import { openDb } from './db.js';
import { createPayPal } from './paypal.js';
import { createMoney } from './money.js';
import { createApp } from './app.js';
import { createAi } from './ai/index.js';
import { createVerifier } from './verifier/service.js';
import { captureEvidence } from './verifier/browser.js';
import { seedShowcase, startDemoCleanup } from './demo.js';

// Fails closed: AI_PROVIDER=gemini without GEMINI_API_KEY stops the server
// instead of silently approving deliveries with the mock.
const ai = createAi(config.ai);
const db = await openDb(config.db);
const paypal = createPayPal(config.paypal);
const money = createMoney(paypal);
const verifier = createVerifier({ db, money, ai, capture: captureEvidence, allowPrivate: config.allowPrivateUrls });

const app = createApp({ db, paypal, money, verifier, ai, config });
app.listen(config.port, async () => {
  console.log(`Handshake listening on ${config.port} (node ${process.version})`, { ...describeConfig(), aiModel: ai.model });
  try {
    await verifier.recover();
    startDemoCleanup(db);
    // The showcase verifies the bundled demo sites over the public URL, so
    // it runs only once the server is reachable.
    if (config.demo.seed) await seedShowcase({ db, money, verifier, baseUrl: config.baseUrl });
  } catch (err) {
    console.error(`[startup] ${err.message}`);
  }
});
