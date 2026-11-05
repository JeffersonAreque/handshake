# Handshake — project rules

Milestone escrow for freelance work: the client funds a milestone with PayPal (AUTHORIZE), an AI verifier checks the delivered URL, and the payment is captured to the freelancer only if every acceptance criterion passes. Built for the PayPal AI Hackathon; the approved plan is in `docs/plan-step2.md`.

## Secrets
- Never commit `.env` or any secret (API keys, PayPal client secret, tokens). Only `.env.example` with placeholder values is committed.
- Never print keys, tokens or `Authorization` headers to the terminal, logs, test output or error messages. Do not `cat`/read `.env`.
- Secrets come only from environment variables.

## Git
- Commit email: `146986673+JeffersonAreque@users.noreply.github.com`.
- Run `npm test` before every commit. Do not commit if tests fail.
- Before committing, check `git status` / `git diff --cached` for secrets.

## Editing
- Create and edit files with the Edit/Write tools, not PowerShell (`Set-Content`, `Out-File`, etc.) or shell redirection.

## Conventions
- Node 24+, ES modules, `node:test` for tests.
- Storage: `@libsql/client`, Turso when `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` are set, otherwise a local SQLite file in `DATA_DIR`. Tests use `:memory:`. Screenshots are stored in the DB, not on disk (Render's free disk resets on restart).
- PayPal sandbox only (`https://api-m.sandbox.paypal.com`).
- All milestone status changes go through `transition()`; money never moves from the wrong status.
