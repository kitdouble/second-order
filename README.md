# Second Order

Study platform for the USYD Meta Lab, at https://2ndorder.live. A study is a
versioned YAML spec; Claude edits specs through an MCP connector; people
approve every gate; a deterministic jsPsych runtime runs participants.

First-time cloud setup: [SETUP.md](SETUP.md). After that, every push to `main`
tests and deploys automatically.

## What's built

| Area | What works |
| --- | --- |
| Spec | YAML schema, semantic validation with fixable error paths, `$cond` per-condition params, content hashes as versions, semantic diffs (design vs wording) |
| Blocks | consent, instructions, dot-numerosity 2AFC with confidence, feedback and staircase, attention check, Likert questionnaire, debrief |
| Checks | QA (synthetic participant through every condition), simulation (power, sequential stopping, meta-d' parameter recovery), preview links per condition |
| Review | request, approve or request changes (people only, in the web app), findings that must be accepted or dismissed with a reason, tiers with a 200 self-approval cap |
| AI review | verification and design-critic tasks queued automatically; a separate "Lab Reviewer" Claude project claims and answers them |
| Running | pilot (auto-ends at pilot N, runs pilot checks), go-live, deficit-weighted assignment, stopping rule checked after every session with automatic pause, max-N cap, reload-safe sessions, quality flags |
| Data | pseudonymised CSV exports, generated R script that reproduces every measure, exclusion and the Bayes factor, generated preregistration, drift report |
| Agent | OAuth 2.1 (dynamic registration, PKCE) and 11 MCP tools: search, get, diff, status, get_data, report, edit_spec, check, review, save, prolific |
| People | one-time sign-in links, tiers, meeting-prep page (what changed since the last meeting, dismissed AI points), audit log |

Verified here: 20 automated tests; meta-d' recovery; Bayes factors identical to
BayesFactor 0.9.12; the generated R script reproducing the platform's numbers on
exported data; a real Chromium participant run; the full researcher lifecycle
in the web UI; the OAuth flow and every MCP tool.

Not built yet (see the design brief roadmap): passkeys, paper-level outputs and
reviewer mode, class/demo targets, deception block, naivety protection,
bot detection, lab norms, longitudinal studies, screenshot QA.

## Layout

| Path | What it is | Runs on |
| --- | --- | --- |
| `packages/core` | Spec schema, blocks, compiler, stats (meta-d', JZS BF), simulation, QA, diff, R/prereg generators, DB schema | shared |
| `apps/web` | Researcher app, REST routes, OAuth, MCP endpoint `/api/mcp` | Cloud Run `so-web` |
| `services/ingest` | Participant API: sessions, assignment, trial data, completion, stopping rule | Cloud Run `so-ingest` |
| `runtime` | jsPsych participant runtime source | built into `hosting/public/runtime/v1/` |
| `hosting/public` | Study page `/s/<hash>/` and the committed runtime bundles | Firebase Hosting |
| `firebase.json` | Routes: `/api/ingest/**` → ingest, `/s/**` → runtime, rest → app | Firebase Hosting |
| `cloudbuild.yaml` | Test, build, deploy | Cloud Build |

The runtime bundle is committed on purpose: a study that ran on `v1` keeps
exactly that code. Change participant-visible behaviour → bump the runtime
version (in `runtime/package.json` and `RUNTIME_VERSION` in core), rebuild.

## Local development (optional)

Node 22 and a Postgres database.

```
npm install
npm test
DATABASE_URL=... BOOTSTRAP_TOKEN=... npm run dev --workspace @second-order/web   # :3000
DATABASE_URL=... PORT=8080 node services/ingest/src/server.js
node scripts/dev-proxy.mjs                                                      # :5000, like Firebase
npm run build:runtime                                                           # after runtime changes
```
