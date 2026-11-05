# Handshake — Step 2 plan (full app)

> Status: approved. Built in vertical slices, with a commit + push after each slice.

**Context:** The step 1 spike passed (authorize → capture and authorize → void, commit 795fed6). Step 2 turns it into a public demo app on Render that the hackathon judges can click through. Gemini is the AI provider, and AI is used at both ends of the flow.

## Step 0
`CLAUDE.md` with the project rules: secrets, commit email, run tests before each commit, and how to edit files.

## Slice 1: money flow end to end, deployed on day one
- Node 24 + Express + EJS + `node:sqlite`. The spike logic moves to `src/paypal.js`: token cache, createOrder (AUTHORIZE, with `payee.email_address` set to the freelancer's sandbox email), authorize, capture and void.
- Creating a milestone takes a title, an amount, the freelancer's PayPal email and the criteria. It returns two secret links, one for the client and one for the freelancer. The payee email is shown in the UI.
- Paying with the PayPal JS SDK sets the milestone to FUNDED. The freelancer then submits a URL, and the mock verifier takes Playwright screenshots. On a pass the payment is captured and the milestone becomes PAID. On a fail it becomes FAILED, and the freelancer can resubmit or the client can void. A single `transition()` guard handles every status change. Only http(s) URLs are accepted, and private IPs are blocked.
- Tests cover status transitions, URL safety and the PayPal module (with mocked fetch).
- Deploy with a Dockerfile (Playwright image) and `render.yaml` on Render's free plan. Then confirm Chromium fits in 512 MB. If it doesn't, stop and propose a fallback.

**Change after the first Render test:** the free plan restarts the container when it's idle and wipes the local disk, which lost a funded milestone. Storage moved to Turso (libsql), with screenshots stored in the DB, and a local SQLite file is used when the Turso variables are missing. An UptimeRobot ping hits `/healthz` every 5 minutes to keep the service awake.

**Memory (after slimming Chromium):** peaks on Render were 241 MB total / 160 MB anon for example.com and 278 MB / 180 MB for wikipedia.org, against a 512 MB limit (before slimming: 491 MB total).

## Slice 2: real AI (done)
Default model: `gemini-2.5-flash` (it was correct, fast and cheap in a comparison with 3.5-flash). Every pass must cite evidence, and an objective failure such as HTTP ≥ 400 overrides the model.
- `src/ai/` with a Gemini adapter (`AI_PROVIDER`, `AI_MODEL`, `GEMINI_API_KEY`) and a mock adapter.
- From the client's plain-language brief, Gemini drafts measurable acceptance criteria, which the client can edit before funding.
- Verifier: Playwright takes desktop and mobile screenshots and runs checks (HTTP status, console errors, broken links and images, page text). Gemini vision then returns strict JSON for each criterion, with pass, reason and evidence. Page text is treated as untrusted data.
- On a fail, Gemini writes a short fix list for the freelancer.
- The evidence report page is added in this slice.

## Slice 3: polish and demo
- CSS design system with light and dark themes, mobile-friendly.
- A timeline of the milestone (Funded → Submitted → Verifying → Passed → Paid), with live progress over SSE.
- Refund after capture.
- Bundled demo sites at `/demo-sites/good` and `/demo-sites/broken`.
- Demo data is seeded on boot, with one-click "Try as client" and "Try as freelancer" buttons.
- README in English for the judges.

## Verify each slice
- `npm test` passes, and the flow works locally and on the Render URL.
- The sandbox capture lands in the freelancer's account.
- Void and refund work in the sandbox.
