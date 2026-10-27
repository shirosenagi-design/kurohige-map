# KUROHIGE MAP — A Living Map of Possibilities

**What if AI helped you discover a direction you did not know to look for?** KUROHIGE MAP turns a person's interests, experiences, constraints, and curiosity into a sea of possibilities. Each island represents a possible action or experience, and the map grows as the person explores.

The aim is not to prescribe the right answer. It is to create encounters with possibilities that might otherwise remain unseen, including for people who do not yet have a clear goal.

## Why We Built It

Goal-setting tools often begin by asking people to name a destination. Recommendation systems tend to rank options against preferences they already know. But a person may be curious without knowing what they want to pursue next.

KUROHIGE MAP starts with the person rather than a single goal. Its AI generation path uses a Person Map to propose different areas of possibility, then presents them as a world to explore. Discovery, reflection, and small actions can shape the journey without reducing it to a checklist or a ranked feed.

## How It Works

1. **Create a Person Map.** Describe interests, experiences, practical context, and things you would rather avoid. A clear goal is optional.
2. **Explore the Living Map.** Possibilities appear as islands. Pan across the sea to discover more; select an island to look closer.
3. **Make the journey your own.** Keep an island, consider its small steps, and record experiences in a voyage log after landing. The voyage log is about taking part in the possibility, rather than rating a place.

The public sample demonstrates the exploration interface with fixed content. The separate LIVE services contain the server-side Nemotron generation path; their verified behavior and limits are described below.

## Try the Demo

[Open the anonymous public sample](https://kurohige-public-sample.onrender.com/?sample=1). It has a fixed, varied **120-island** dataset in a separate browser storage area. Pan to discover islands. It does **not** generate islands with Nemotron in real time, and its server blocks AI API requests.

Filming and reviewer LIVE experiences are separate Render deployments. Chargeable AI routes require server-side Basic authentication. The reviewer URL and access credentials must be provided privately; they are not included in this public README or repository.

## Technology

- **Interface:** React, TypeScript, Vite, and PixiJS for the Cover, Person Map summary, Living Map, island detail, and voyage log.
- **AI path:** NVIDIA Nemotron via Nebius for semantic islands, visual recipes, island details, and steps. Server-side requests are disabled unless `NEBIUS_API_ENABLED=true` is explicitly configured.
- **Data:** Local-first World and Profile storage, with PostgreSQL components for accounts, voyage logs, landing eligibility, and account synchronization.
- **Deployment:** [`render.yaml`](render.yaml) defines the anonymous sample, independent filming and reviewer LIVE web services, and PostgreSQL.

## Verification Status & Known Limitations

The anonymous sample's fixed-island exploration and interface have been checked separately from LIVE AI generation. Mock tests of World expansion do not establish that a full LIVE Nemotron journey works. In particular, a LIVE six-island expansion can fail when bounded candidate recovery does not produce six safe, distinct possibilities; the app reports the error and retains the existing World. That operation is **not** presented as verified for the reviewer deployment.

Cross-device World/Profile recovery has partial browser and PostgreSQL evidence. Intermittent database connection delay and a blank-screen case remain unresolved. Production Magic Link email delivery is not configured or verified. These are not claimed as completed production flows.

## Run Locally

Use Node.js 24. Install dependencies with `npm ci`, then run `npm run dev`. Open `http://127.0.0.1:5173/?sample=1` for the API-free sample. `npm test` runs the configured regression suite; `npm run build` creates a production build.

Local LIVE AI requires separate server-side credentials and explicit enablement. This repository contains no usable secrets. Keep environment files, browser storage, database dumps, and local backups out of Git. The Render Blueprint leaves Nebius disabled by default and does not provide a production email service.

## License

MIT. See [LICENSE](LICENSE). Third-party packages retain their own licenses.
