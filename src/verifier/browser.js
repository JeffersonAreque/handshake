// Opens a submitted URL in headless Chromium and collects evidence:
// desktop + mobile screenshots and objective checks. Page content is data,
// never instructions.
import { chromium } from 'playwright';
import { startEgressProxy } from './egressProxy.js';

const PAGE_TIMEOUT_MS = 60_000;
const MAX_SHOT_HEIGHT = 3000;
// Tuned for a 512 MB container: one renderer process (site isolation off so
// the limit is honored), a capped V8 heap per renderer, and no extra helpers.
const LAUNCH_ARGS = [
  '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--mute-audio', '--no-first-run', '--disable-quic',
  '--renderer-process-limit=1',
  '--disable-site-isolation-trials',
  '--disable-features=site-per-process,IsolateOrigins,Translate,MediaRouter,OptimizationHints,BackForwardCache',
  '--js-flags=--max-old-space-size=128',
  '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync',
];

const VIEWPORTS = [
  { label: 'desktop', options: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
  { label: 'mobile', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
];

async function capturePage(browser, url, { label, options }) {
  const context = await browser.newContext({ ...options, ignoreHTTPSErrors: false, javaScriptEnabled: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => { if (msg.type() === 'error' && consoleErrors.length < 20) consoleErrors.push(msg.text().slice(0, 300)); });
  page.on('pageerror', (err) => { if (pageErrors.length < 20) pageErrors.push(String(err.message).slice(0, 300)); });
  page.on('requestfailed', (req) => {
    if (failedRequests.length < 20) failedRequests.push(`${req.failure()?.errorText ?? 'failed'} ${req.url().slice(0, 300)}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && res.request().resourceType() !== 'document' && failedRequests.length < 20) failedRequests.push(`${res.status()} ${res.url().slice(0, 300)}`);
  });

  const started = Date.now();
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  } catch (err) {
    await context.close();
    throw new Error(`Could not open the page (${label}): ${err.message.split('\n')[0]}`);
  }
  const loadMs = Date.now() - started;
  const info = await page.evaluate(() => ({
    title: document.title,
    text: (document.body?.innerText || '').slice(0, 4000),
    brokenImages: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src).slice(0, 20),
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    height: document.documentElement.scrollHeight,
  }));
  // Full page, capped in height and as JPEG, so evidence stays small in the DB.
  const shot = { type: 'jpeg', quality: 70, timeout: 15_000 };
  const viewportSize = page.viewportSize();
  const data = await page
    .screenshot({ ...shot, fullPage: true, clip: { x: 0, y: 0, width: viewportSize.width, height: Math.min(Math.max(info.height, viewportSize.height), MAX_SHOT_HEIGHT) } })
    .catch(() => page.screenshot(shot));
  // Free the renderer right away, before the next viewport starts.
  await page.close().catch(() => {});
  await context.close().catch(() => {});
  delete info.height;
  const result = {
    label,
    data,
    httpStatus: response?.status() ?? null,
    finalUrl: page.url(),
    loadMs,
    consoleErrors,
    pageErrors,
    failedRequests,
    ...info,
  };
  return result;
}

/**
 * Captures `url` on desktop and mobile. Returns
 * { checks: {...}, images: [{label, data: Buffer (JPEG)}] }. Throws if the
 * page can't be opened.
 */
export async function captureEvidence(url, { allowPrivate = false } = {}) {
  // Unless explicitly allowed (local dev), all browser traffic goes through
  // the egress proxy, which blocks private/internal addresses. '<-loopback>'
  // stops Chromium from silently bypassing the proxy for localhost.
  const proxy = allowPrivate ? null : await startEgressProxy();
  const browser = await chromium.launch({
    headless: true,
    args: LAUNCH_ARGS,
    ...(proxy && { proxy: { server: proxy.server, bypass: '<-loopback>' } }),
  });
  try {
    const pages = [];
    for (const viewport of VIEWPORTS) pages.push(await capturePage(browser, url, viewport));
    const [desktop, mobile] = pages;
    return {
      checks: {
        url,
        httpStatus: desktop.httpStatus,
        finalUrl: desktop.finalUrl,
        title: desktop.title,
        loadMs: desktop.loadMs,
        consoleErrors: [...new Set([...desktop.consoleErrors, ...mobile.consoleErrors])],
        pageErrors: [...new Set([...desktop.pageErrors, ...mobile.pageErrors])],
        failedRequests: [...new Set([...desktop.failedRequests, ...mobile.failedRequests])],
        brokenImages: [...new Set([...desktop.brokenImages, ...mobile.brokenImages])],
        mobileHorizontalOverflow: mobile.horizontalOverflow,
        blockedHosts: proxy ? [...new Set(proxy.blocked)] : [],
        text: desktop.text,
      },
      images: pages.map((p) => ({ label: p.label, data: p.data })),
    };
  } finally {
    await browser.close();
    await proxy?.close();
  }
}
