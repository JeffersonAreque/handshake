import path from 'node:path';
import { config, describeConfig } from './config.js';
import { openDb } from './db.js';
import { createPayPal } from './paypal.js';
import { createApp } from './app.js';
import { createVerifier } from './verifier/service.js';
import { captureEvidence } from './verifier/browser.js';
import { mockJudge } from './verifier/mockJudge.js';

const db = openDb(path.join(config.dataDir, 'handshake.db'));
const paypal = createPayPal(config.paypal);

if (config.ai.provider !== 'mock') console.warn(`AI_PROVIDER=${config.ai.provider} is not available yet; using mock.`);
const verifier = createVerifier({
  db,
  paypal,
  judge: mockJudge,
  capture: captureEvidence,
  evidenceDir: path.join(config.dataDir, 'evidence'),
  allowPrivate: config.allowPrivateUrls,
});

const app = createApp({ db, paypal, verifier, config });
app.listen(config.port, () => {
  console.log(`Handshake listening on ${config.port} (node ${process.version})`, describeConfig());
  verifier.recover();
});
