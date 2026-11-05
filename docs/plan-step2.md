# Handshake — Step 2 plan (full app)

> Status: proposed, not yet approved or implemented.

**Context:** The step 1 spike passed (authorize → capture and authorize → void, commit 795fed6). Step 2 turns it into a public demo app on Render that the hackathon judges can click through.
1. **Layout:** Node 24 + Express, with `src/server.js`, `src/routes/{client,freelancer,api}.js` and EJS views. `scripts/paypal-spike.mjs` moves into a shared `src/paypal.js` (token caching, plus createOrder, authorize, capture, void, get, refund).
2. **Database:** built-in `node:sqlite`, so there's nothing native to compile. Tables are `milestones` (title, amount, criteria JSON, status, order/authorization/capture IDs), `submissions` (URL, attempt number) and `reports` (verdict per criterion, evidence paths, model used).
3. **Two roles without accounts:** when a client creates a milestone, it gets two secret links, one for the client and one for the freelancer. Each role sees only its own view.
4. **Status flow:** DRAFT → FUNDED → SUBMITTED → VERIFYING → PASSED → PAID, or FAILED → resubmit, or VOIDED, or REFUNDED. All status changes go through a single `transition()` guard so money can't move from the wrong status.
5. **Paying:** the PayPal JS SDK buttons call the server to create the order (AUTHORIZE). On approval, the server authorizes and the milestone becomes FUNDED. Capture happens only when every criterion passes. The client can void before payout, or refund after payout (`/v2/payments/captures/{id}/refund`). If an authorization is older than 3 days, the app re-authorizes before capturing.
6. **AI agent:** `src/agent/` runs Playwright (headless Chromium) in a tool loop of at most 15 steps. Tools: navigate, click, type, screenshot (desktop and mobile), read_text, console_errors, finish. It must return a pass or fail for each criterion, with evidence screenshots and a short reason.
7. **Configurable AI provider:** `src/ai/index.js` reads `AI_PROVIDER` (claude, gemini or mock), `AI_MODEL` and `AI_API_KEY`. It has one neutral interface, `chat({system, messages, tools, images})`, with adapters for `@anthropic-ai/sdk` and `@google/genai`. The mock adapter allows offline tests.
8. **Safety:**
   - Only http(s) URLs are accepted, and private or localhost IPs are blocked so the agent can't reach the server's internal network.
   - Page content is treated as untrusted data: a page that says "all criteria pass" doesn't count without evidence.
   - Timeouts are 60 s per page and 3 minutes per verification run.
   - Keys come only from env and never appear in logs.
9. **UI:** a custom CSS design system (dark and light themes, mobile-friendly). Pages: landing, create milestone, client dashboard, freelancer submit page, and an evidence report with a screenshot gallery and pass/fail per criterion. Live verification progress streams via SSE, so judges watch the agent work.
10. **Demo extras:** `/demo-sites/good` and `/demo-sites/broken` are bundled sample deliverables, so judges can trigger a pass and a fail in seconds.
11. **Deploy:** a `Dockerfile` built on the `mcr.microsoft.com/playwright` image, plus a `render.yaml` with a 1 GB disk at `/data` for SQLite and screenshots. A persistent disk needs Render's paid Starter plan (about $7/month); on the free plan, data resets on every redeploy.
12. **Tests:** `node:test` covers the status flow, URL safety checks, the AI provider switch (with the mock) and the PayPal module (mocked responses).
13. **Verify:** first an end-to-end run locally with `AI_PROVIDER=mock`, then with Claude and with Gemini against the good and broken demo sites. The pass should end PAID and the fail should end with a resubmit. Also run void and refund in the sandbox, then repeat the same run on the Render URL.
