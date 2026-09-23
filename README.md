# Second Order

Study platform for the USYD Meta Lab, served at https://2ndorder.live.

This repo is the deployment skeleton: it proves that a push to `main` goes live
automatically. The platform itself (specs, compiler, MCP server, review flow)
gets built on top of it, following the design brief.

## How a push goes live

Push to `main` → Cloud Build runs `cloudbuild.yaml`:

1. Runs the tests. If any fail, nothing changes in production.
2. Builds the two container images.
3. Deploys the ingest service, then the researcher app, to Cloud Run (Sydney).
4. Deploys Firebase Hosting, which serves study bundles and routes everything
   else to the two services.

A green tick next to the commit on GitHub means it's live. A red cross means it
failed and the previous version is still running.

## What's where

| Path | What it is | Where it runs |
| --- | --- | --- |
| `apps/web` | Next.js researcher app: UI, API, MCP endpoint (`/api/mcp`, placeholder) | Cloud Run service `so-web` |
| `services/ingest` | Receives trial data from participants' browsers; safe to retry | Cloud Run service `so-ingest` |
| `hosting/public/run/` | Compiled study bundles, one fixed folder per approved version | Firebase Hosting |
| `firebase.json` | Routes: `/api/ingest/**` → ingest, `/run/**` → static, everything else → app | Firebase Hosting |
| `cloudbuild.yaml` | The deploy pipeline | Cloud Build |

## Checking a deploy

- https://2ndorder.live shows the running commit.
- https://2ndorder.live/api/health — app
- https://2ndorder.live/api/ingest/health — ingest, including whether the database is connected
- https://2ndorder.live/run/demo/ — sends a test trial end to end

## Rolling back

In the Cloud Run console, open the service, go to **Revisions**, and send 100%
of traffic to the previous revision. Or revert the commit on GitHub, which
deploys the old code again.

## Local development (optional)

Only needed if you want to run things on your own machine. Node 22:

```
cd apps/web && npm install && npm run dev          # http://localhost:3000
cd services/ingest && npm install && npm test
```

First-time cloud setup is in [SETUP.md](SETUP.md).
