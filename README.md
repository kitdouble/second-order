# Second Order

Invite-only platform used entirely through Claude or ChatGPT via MCP. There is no researcher web
interface: the only pages are sign-up (invite), sign-in, the OAuth consent screen, and a page that
shows the connector URL.

- `server/mcp.js` — the MCP endpoint (`/mcp`) and its tools. This is the product.
- `server/oauth.js` — OAuth 2.1 server for connectors: DCR, client ID metadata documents, PKCE,
  resource-bound tokens, refresh rotation, redirect allowlist (Claude, ChatGPT, localhost).
- `server/auth.js` — invites and passkeys (SimpleWebAuthn); `server/db.js` — SQLite (`node:sqlite`)
- `src/` — the few React pages, MetaForge visual style
- `scripts/invite.js` — create invite links from the shell (bootstrap; afterwards use `create_invite`)

## MCP tools

| Tool | Who | |
| --- | --- | --- |
| `whoami` | everyone | the signed-in account |
| `get_authoring_guide` | everyone | experiment contract, rules, exact package versions |
| `list_studies` / `get_study` | owner, admin | studies, versions, links, counts, code |
| `create_study` | everyone | new empty study |
| `update_experiment` | owner, admin, editor | compile and make the experiment live (previews and participant links) |
| `save_version` / `restore_version` / `delete_version` | editor (delete: owner) | named snapshots, only when asked |
| `storage_report` | viewer | stimulus storage of the live experiment and saved versions |
| `simulate` | owner, admin | run simulated participants (sandboxed) and summarise their data |
| `show_dashboard` | owner, admin | in-chat panel: dashboard, study overview (links, counts, versions, stimuli) |
| `check_launch` | owner, admin | simulate + pre-launch checklist (pass / warn / fail), shown in the panel |
| `study_status` | owner, admin | completion, in progress / abandoned, dropout points, browser errors, durations |
| `create_download_link` | owner, admin | one-hour link to the full CSV/JSON, outside the chat |
| `delete_participant_data` / `list_deletions` | owner, admin | withdrawals and test-data cleanup, logged without data |
| `quality_report` / `set_exclusion_rules` | viewer / editor | durations and pay, dropouts, fast responders, attention checks, exclusions |
| `share_study` / `list_members` / `remove_member` | owner | collaborators as editor or viewer |
| `list_documents` / `get_document` / `save_document` | everyone (edit: document owner, admin) | consent and debrief library; edits need the researcher's confirmation |
| `list_stimuli` / `remove_stimulus` | owner, admin | the study's stimulus files |
| `create_upload_link` | owner, admin | one-hour page for dragging in stimulus files |
| `add_stimulus` / `import_stimulus_from_url` | owner, admin | add generated or public files |
| `create_participant_link` | owner, admin | Prolific / SONA / lab link pinned to one version |
| `close_participant_link` | owner, admin | stop accepting participants |
| `get_data` | owner, admin | trial rows as CSV (test data excluded by default) |
| `list_users` / `create_invite` | admin | accounts and invites |

## Experiments

Experiments are jsPsych v8 modules (`export default function buildTimeline(jsPsych, context)`), written by
the assistant and compiled by `server/compile.js` with esbuild against the exact jsPsych packages in
`package.json`. Each study has one live experiment (`server/live.js`): updates go live immediately for previews
and participant links, and are recorded as internal revisions (every data row has `revision`). When stimuli or
consent texts change, the live experiment is rebuilt on its next load. Saved versions are snapshots kept only
when the researcher asks; stimulus files are deleted once neither the live experiment nor a saved version uses
them (hourly, and right after removals).

Experiments can `import { consent, deviceCheck, demographics, fullscreen, preload, debrief, stimulus } from
"second-order"` (`server/lib/`): the lab's standard blocks, ported from the Meta Lab jsPsych kit. Consent and
debrief texts come from the document library (`server/documents.js`, seeded with the HREC 2022/796 texts in
`server/documents/`); every edit is a new version with its own label, and each study version keeps the texts
it was saved with.

Access per study: owner (and admins), editor, viewer (`study_members`).

Stimuli are stored once by SHA-256 in `<data dir>/files`, shared between studies and saved versions.

`simulate` runs jsPsych's data-only simulation in jsdom, one participant per child process under Node's
permission model (`server/sim/`). In production those processes belong to the `second-order-sim` service:
no network, no database, read-only filesystem, memory-capped, reached over a unix socket (`SIM_SOCKET`).

Each version has a dashboard (`run.2ndorder.live/d/<preview token>`, `server/dashboard/`), ported from the
kit's: the timeline, run all / from an item / only an item, recruitment switch, data with downloads; nothing
is saved. `show_dashboard` and `simulate` open the in-chat panel (`server/panel/`, built by `server/mcp-app.js`; an MCP
App, protocol 2026-01-26, with a hand-written bridge): tabs for the dashboard, the study (links and counts,
switchable versions, stimulus thumbnails) and simulation results (per-participant outcomes, value counts per
column). Where the host allows, the researcher's notes go to the chat (`ui/message`), each dashboard run is
summarised into Claude's context (`ui/update-model-context`), and downloads go through the host.

Live runs: the runtime numbers rows itself, reports browser errors and progress, checkpoints after every
top-level timeline item and resumes from there after a reload (same seed, same assigned condition; the
partial item's rows are replaced). A participant ID can complete a study once. `assignCondition()` is
balanced server-side per link.

Participants use a separate origin (`RUN_ORIGIN`, `run.2ndorder.live`) served by `server/run.js`, with a
strict CSP (data can only go back to Second Order). `server/runtime/client.js` wraps every experiment: it
starts the run, saves each trial as it finishes, and redirects to the completion URL, which the server only
reveals at the end. Bump `version` in `package.json` when the runtime changes; versions record it.

## Run locally

```bash
npm install
npm run dev            # http://localhost:5173 (API on :3000, proxied)
npm run invite -- --name "Kit Double" --email kitdouble@gmail.com --admin
```

Open the printed link and create a passkey. Invites are single-use and expire after 7 days.
An invite for an email that already has an account adds a passkey to it (new device / recovery).

## Production (BinaryLane, https://2ndorder.live)

Ubuntu 24.04 VPS running Node 24 behind Caddy (automatic HTTPS), as a systemd service.
Code lives in `/opt/second-order`, the database in `/var/lib/second-order`, daily backups in
`/var/backups/second-order` (14 days).

```bash
ssh root@<server-ip> 'bash -s' < deploy/setup-server.sh   # once, on a fresh server
npm run deploy                                             # build locally, rsync, restart
npm run invite:prod -- --name "Full Name" --email a@b.com  # invite someone on the live site
```

Passkeys and OAuth tokens are bound to the domain in `APP_ORIGIN` (`/opt/second-order/.env`).
Connector URL for Claude / ChatGPT: `https://2ndorder.live/mcp`.
