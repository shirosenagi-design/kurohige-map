# KUROHIGE MAP

KUROHIGE MAP turns a person's interests, experience, and constraints into an explorable sea of possibilities. People can discover islands, keep ideas, try small steps, and revisit their voyage history.

## Try the public sample

[Open the anonymous sample](https://kurohige-public-sample.onrender.com/?sample=1). It uses a fixed, varied 120-island dataset and a separate browser storage area. Pan to discover more islands. The sample does **not** call Nemotron or present its islands as live AI output. Its server blocks API requests.

The filming and reviewer LIVE services are separate Render deployments. Chargeable AI routes require their own server-side Basic credentials; the reviewer URL and credentials are shared privately with judges. No credentials or API keys belong in this repository or a public submission form.

## What is in this repository

- A React, TypeScript, Vite, and PixiJS Product with Cover, Person Map summary, Living Map, island detail, and voyage log screens.
- Local-first World and Profile storage, plus PostgreSQL-backed accounts, review data, landing eligibility, and account sync components.
- A server-side Nemotron integration for semantic islands, visual recipes, island details, and steps. It is disabled unless `NEBIUS_API_ENABLED=true` is explicitly set on the server.
- A Render Blueprint for one anonymous sample web service, independent filming and reviewer LIVE web services, and PostgreSQL.

## Current verification limits

The public sample uses fixed data. Mock tests for World expansion are separate from live Nemotron verification. A LIVE request to add six islands can fail when the generator cannot supply six safe, distinct candidates after bounded recovery; the app reports an error and keeps the existing World. Do not present that operation as verified for the reviewer deployment.

Cross-device World/Profile recovery has partial browser and PostgreSQL evidence; intermittent database connection delay and a blank-screen case remain unresolved. Production Magic Link email delivery is not configured or verified. These are not claimed as completed production flows.

## Local development

Requires Node.js 24. Install dependencies with `npm ci`, then start Vite with `npm run dev`. Open `http://127.0.0.1:5173/?sample=1` for the API-free sample. `npm test` runs the configured regression suite, and `npm run build` creates a production build. Local LIVE AI requires separate server-side credentials and explicit enablement; the repository contains no usable secrets.

Deployment configuration is in [`render.yaml`](render.yaml). Keep environment files, browser storage, database dumps, and local backups out of Git. The Blueprint leaves Nebius disabled by default and does not provide a production email service.

## License

MIT. See [LICENSE](LICENSE). Third-party packages retain their own licenses.
