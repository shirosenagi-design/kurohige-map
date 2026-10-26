# Render deployment gate (2026-10-26)

This is configuration and local verification only. No Render resource has been created, no public URL exists, and Nebius remains OFF. `render.yaml` is intentionally not synced until Neo approves the exact recurring charges and publication.

## Topology

| Component | Render plan | Purpose |
| --- | --- | --- |
| `kurohige-public-sample` | free web | Anonymous `/?sample=1`; server blocks every `/api/` request with `PUBLIC_SAMPLE_SERVER_API_BLOCKED`. No production database. |
| `kurohige-live-filming` | `0.5c-512mb` web + 1 GB disk | Filming LIVE origin. Own Basic credentials, approved guard file, runId and persistent ledger. Starts with Nebius OFF. |
| `kurohige-live-reviewer` | `0.5c-512mb` web + 1 GB disk | Reviewer LIVE origin. Independent Basic credentials, approved guard file, runId and persistent ledger. Starts with Nebius OFF. |
| `kurohige-product-data` | `0.1c-256mb` Postgres + 1 GB storage | Persistent review, account, session and sync data. External database IP allowlist is empty. New database only; no local JSON import. |

Each LIVE web has its own public `$PORT` handled by `server/renderGateway.mjs`. Each Vite preview binds only to its own `127.0.0.1:4173`. The gateway removes all incoming `Forwarded`, `X-Forwarded-*` and proxy-secret headers and creates its own internal marker. The existing Basic gate accepts that marker only from the loopback socket. Render's edge performs public TLS and HTTP-to-HTTPS redirection. This trust model requires deploying *on Render* with its edge in front; directly exposing the gateway outside Render would be unsafe. The gateway's `/health` becomes healthy only after Vite responds.

Current list-price estimate for the always-on resources: two paid webs at $7/month each, Postgres compute $6/month, up to $0.30/month for the configured 1 GB Postgres storage, and two 1 GB service disks at $0.25/month each: up to $20.80/month before tax, exchange-rate movement, bandwidth overages, and any email-delivery cost. At about ¥157/USD this is about ¥3,270/month. The anonymous sample web is free but may sleep when idle. These are recurring, usage-prorated services; review the exact Render checkout amount before Blueprint sync. No Render charge has been accepted here.

## Before a Render Blueprint sync

1. Confirm the paid plan, disk and database charges in the Render dashboard. `render.yaml` sets auto-deploy OFF; a Blueprint sync itself still creates paid resources and a public HTTPS origin.
2. Connect Render to the private repository. Do not upload `.env.local`, local `data/`, `.runtime/`, browser profiles, World Rev98, old backups or Stage 6 evidence.
3. Supply `KUROHIGE_LIVE_AI_USERNAME` (at least 8 chars) and `KUROHIGE_LIVE_AI_PASSWORD` (at least 24 chars) as server-only Render environment values on each LIVE web. Use different pairs for filming and reviewer; each web has an independent generated proxy secret and session secret. The Blueprint never contains credentials or the Nebius key.
4. Each LIVE web self-references its Render HTTPS URL in `AUTH_PUBLIC_BASE_URL` and `WEBAUTHN_ORIGIN`, and its Render hostname in `WEBAUTHN_RP_ID`. These values target the service's default `onrender.com` origin; update them deliberately if a custom domain becomes the browser origin. The existing production email-delivery adapter is not configured yet; Magic Link cannot be declared working until an approved mail provider is wired and tested. Do not replace it with the development mailbox.
5. Each LIVE web's pre-deploy command applies schema 001-005 to the same **new Render database only**, under the existing migration advisory lock, without importing local review JSON. Keep `REVIEW_DATABASE_URL` on Render's private database connection. The sample service never runs migrations.
6. Verify the public sample on `https://<sample-host>/?sample=1`, both LIVE services on their separate HTTPS origins, and the database schema before enabling any AI. A Render URL cannot be supplied until resources are actually created.

## LIVE session activation (separate approval required)

`NEBIUS_API_ENABLED=false` remains the default on both LIVE webs. The filming service is fixed to `KUROHIGE_LIVE_SESSION=filming` and `/etc/secrets/approved-filming-guard.json`; the reviewer service is fixed to `KUROHIGE_LIVE_SESSION=reviewer` and `/etc/secrets/approved-reviewer-guard.json`. After separately approving each Nebius budget, create each service's Render secret file with the existing Product guard schema, distinct `runId`, approved period, POST and estimated-USD ceilings, explicit token prices, and allowed operations. The filming file must use `ledgerPath=/var/data/kurohige/ledgers/filming/<unique-runId>.jsonl`; the reviewer file must use `ledgerPath=/var/data/kurohige/ledgers/reviewer/<different-runId>.jsonl`. Supply `NEBIUS_API_KEY` server-side only to the approved service. Only after those values are approved and validated may that service's `NEBIUS_API_ENABLED=true` be set. The existing guard fails closed on missing budget approval, abnormal usage, retries or ledger state. Each web has its own disk, so neither can read the other's ledger.

Each LIVE web has a separate persistent disk mounted at `/var/data/kurohige`. Keep its approved ledger there. Render's disk limits each web service to a single instance. A restart during an active run can put the existing guard into a safe stopped state; do not delete or reset a ledger to resume. A new run requires a separately approved runId/budget.

## Local verification and remaining gates

`node --test tests/renderGateway.test.mjs`: 4/4 PASS (isolated localhost, including actual production Vite preview; no external network). `npm run build`: PASS. No Render deployment, external HTTPS test, paid database test or real Nebius request was performed. Before public acceptance, verify Render TLS/redirect, that Vite's upstream port is unreachable externally, sample `/api/` 503, LIVE unauthorized 401, session-specific approved budgets, database backup/recovery, and production mail delivery. The existing Stage 6 PARTIAL findings remain separate.


