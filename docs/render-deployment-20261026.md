# Render deployment gate (2026-10-26)

This is configuration and local verification only. No Render resource has been created, no public URL exists, and Nebius remains OFF. `render.yaml` is intentionally not synced until Neo approves the exact recurring charges and publication.

## Topology

| Component | Render plan | Purpose |
| --- | --- | --- |
| `kurohige-public-sample` | free web | Anonymous `/?sample=1`; server blocks every `/api/` request with `PUBLIC_SAMPLE_SERVER_API_BLOCKED`. No production database. |
| `kurohige-live` | `0.5c-512mb` web + 1 GB disk | One approved LIVE session at a time. Separate filming and reviewer Basic credentials, runIds and ledger paths when changing sessions. Starts with Nebius OFF and session `disabled`. |
| `kurohige-product-data` | `0.1c-256mb` Postgres + 1 GB storage | Persistent review, account, session and sync data. External database IP allowlist is empty. New database only; no local JSON import. |

The live web's public `$PORT` belongs to `server/renderGateway.mjs`. Vite preview binds only to `127.0.0.1:4173`. The gateway removes all incoming `Forwarded`, `X-Forwarded-*` and proxy-secret headers and creates its own internal marker. The existing Basic gate accepts that marker only from the loopback socket. Render's edge performs public TLS and HTTP-to-HTTPS redirection. This trust model requires deploying *on Render* with its edge in front; directly exposing the gateway outside Render would be unsafe. The gateway's `/health` becomes healthy only after Vite responds.

Current list-price estimate for the always-on resources: paid web $7/month, Postgres compute $6/month, 1 GB Postgres storage $0.30/month, and 1 GB service disk $0.25/month: $13.55/month before tax, exchange-rate movement, bandwidth overages, and any email-delivery cost. At about ¥157/USD this is about ¥2,130/month. The anonymous sample web is free but may sleep when idle. These are recurring, usage-prorated services; review the checkout amount before Blueprint sync. No Render charge has been accepted here.

## Before a Render Blueprint sync

1. Confirm the paid plan, disk and database charges in the Render dashboard. `render.yaml` sets auto-deploy OFF; a Blueprint sync itself still creates paid resources and a public HTTPS origin.
2. Publish this source through a private repository that Render can access. Do not upload `.env.local`, local `data/`, `.runtime/`, browser profiles, World Rev98, old backups or Stage 6 evidence. This workspace currently has no Git repository.
3. Supply `KUROHIGE_LIVE_AI_USERNAME` (at least 8 chars) and `KUROHIGE_LIVE_AI_PASSWORD` (at least 24 chars) as server-only Render environment values. Supply a separate pair for filming and reviewer sessions; do not reuse either pair. The Blueprint never contains credentials or the Nebius key.
4. For account recovery, supply the actual LIVE HTTPS origin in `AUTH_PUBLIC_BASE_URL` and `WEBAUTHN_ORIGIN`, and its hostname in `WEBAUTHN_RP_ID`. The existing production email-delivery adapter is not configured yet; Magic Link cannot be declared working until an approved mail provider is wired and tested. Do not replace it with the development mailbox.
5. The live web pre-deploy command applies schema 001-005 to its **new Render database only**, without importing local review JSON. Keep `REVIEW_DATABASE_URL` on Render's private database connection. The sample service never runs migrations.
6. Verify the public sample on `https://<sample-host>/?sample=1`, the live service on its separate HTTPS origin, and the database schema before enabling any AI. A Render URL cannot be supplied until resources are actually created.

## LIVE session activation (separate approval required)

`NEBIUS_API_ENABLED=false` and `KUROHIGE_LIVE_SESSION=disabled` remain the default. After separately approving a Nebius budget and inspecting the resulting guard configuration, create a Render secret file such as `/etc/secrets/approved-product-guard.json`. It must contain the existing Product guard schema, a unique `runId`, approved period, POST and estimated-USD ceilings, explicit token prices, and allowed operations. For filming, set `KUROHIGE_LIVE_SESSION=filming` and `ledgerPath=/var/data/kurohige/ledgers/filming/<unique-runId>.jsonl`. For reviewer, rotate the Basic credentials, use `KUROHIGE_LIVE_SESSION=reviewer`, a *different* `runId` and `ledgerPath=/var/data/kurohige/ledgers/reviewer/<unique-runId>.jsonl`. Set `NEBIUS_PRODUCT_GUARD_CONFIG_PATH` to the secret-file path and supply `NEBIUS_API_KEY` server-side. Only after all of those are approved and validated may `NEBIUS_API_ENABLED=true` be set. The existing guard fails closed on missing budget approval, abnormal usage, retries or ledger state. Do not reuse the filming ledger for reviewer access. One live slot is deliberate to keep the fixed Render cost under the stated ceiling; sessions are sequential, not simultaneous.

The persistent disk is mounted only at `/var/data/kurohige`. Keep any approved ledger there. Render's disk limits this web service to a single instance. A restart during an active run can put the existing guard into a safe stopped state; do not delete or reset a ledger to resume. A new run requires a separately approved runId/budget.

## Local verification and remaining gates

`node --test tests/renderGateway.test.mjs`: 4/4 PASS (isolated localhost, including actual production Vite preview; no external network). `npm run build`: PASS. No Render deployment, external HTTPS test, paid database test or real Nebius request was performed. Before public acceptance, verify Render TLS/redirect, that Vite's upstream port is unreachable externally, sample `/api/` 503, LIVE unauthorized 401, session-specific approved budgets, database backup/recovery, and production mail delivery. The existing Stage 6 PARTIAL findings remain separate.


