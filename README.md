# Second Order

Invite-only platform used entirely through Claude or ChatGPT via MCP. There is no researcher web
interface: the only pages are sign-up (invite), sign-in, the OAuth consent screen, and a page that
shows the connector URL.

- `server/mcp.js` — the MCP endpoint (`/mcp`) and its tools. This is the product.
- `server/oauth.js` — OAuth 2.1 server for connectors: DCR, client ID metadata documents, PKCE,
  resource-bound tokens, refresh rotation, redirect allowlist (Claude, ChatGPT, Copilot Studio, localhost).
- `server/auth.js` — invites and passkeys (SimpleWebAuthn); `server/db.js` — SQLite (`node:sqlite`)
- `src/` — the few React pages, MetaForge visual style
- `scripts/invite.js` — create invite links from the shell (bootstrap; afterwards use `create_invite`)

## Set up your own lab (using Claude)

You can copy this repo and run your own Second Order. The quickest way is to open it in
[Claude Code](https://claude.com/claude-code) and ask Claude to do the setup. Paste something like:

> Set up Second Order for my lab. Follow the "Set up your own lab" section of README.md. Run it locally first,
> create my admin invite, then help me deploy it to a server at `<my domain>`. Don't put my ethics documents in
> the code: we'll add them through the MCP tools afterwards.

What Claude will be doing (you can also do it by hand):

1. **Run it locally.** Needs Node 22.13 or newer. `npm install`, copy `.env.example` to `.env`, `npm run dev`,
   then `npm run invite -- --name "Your Name" --email you@example.org --admin`. Open the printed link and create a
   passkey. This is also how you bootstrap the first admin on a server (`npm run invite:prod`).
2. **Connect your assistant.** Researchers use Second Order only through Claude or ChatGPT. Add a custom
   connector pointing at `<APP_ORIGIN>/mcp` (for example `https://yourlab.example.org/mcp`) and sign in with
   your passkey. Web connectors need a public HTTPS address, so for anything beyond trying it on your own
   machine, deploy to a server first. Then ask the assistant to call `get_authoring_guide` and build an
   experiment.
3. **Add your ethics-approved consent and debrief.** They are not part of this repo. A fresh install only has
   `example-protocol`, placeholder wording marked TEMPLATE, so you can try everything straight away; `check_launch`
   fails while a study still shows it. To add your own, tell the assistant, for example: "Add our consent and
   debrief to Second Order as `hrec-2025-123`" and paste your approved text as HTML. It will use `save_document`
   and show you the exact wording to confirm first. Notes:
   - Texts are per recruitment: `prolific`, `sona`, `lab`, or `any` for all. Placeholders: `{{minutes}}`,
     `{{payment}}` (Prolific forms), `{{credit}}` (SONA forms). A form that uses `{{payment}}` or `{{credit}}`
     can only be used for that recruitment.
   - Each edit is a new version with its own `form_label` (recorded in the data as `consent_form` /
     `debrief_form`), so you can always tell which text each participant saw.
   - `consent()` and `debrief()` use the lab's oldest document that isn't the example when no `document` is named.
     Name one with `consent({ minutes, document: "hrec-2025-123" })`.
4. **Check lab-specific defaults.** Pay rates (6 GBP/hour for Prolific, 1 credit/hour for SONA) are in
   `server/lib/context.js`. Prolific is optional: set `PROLIFIC_API_TOKEN` (see `.env.example`).
   `CLAUDE.md` describes the original maintainer's git workflow (push straight to `main`, which deploys); edit it
   to match how you work.
5. **Deploy.** Ubuntu 24.04 VPS and a domain pointing at it. Run `DOMAIN=yourlab.example.org` with
   `deploy/setup-server.sh` (see Production below), then `HOST=<server> npm run deploy`. The GitHub Actions
   workflow in `.github/workflows/deploy.yml` deploys every push to `main` and falls back to `2ndorder.live`
   when `DEPLOY_HOST` is not set: set the `DEPLOY_HOST` and `DEPLOY_SSH_KEY` repository secrets, or delete the
   workflow, and change the default host in `scripts/*.sh`.

Licence: MIT (see `LICENSE`). That covers the code only. `server/lib/blocks/assets/usyd-logo.png` is the University
of Sydney's logo and is not covered: replace it with your institution's logo, or remove it and the `{{logo}}`
placeholder from your documents.

## MCP tools

| Tool | Who | |
| --- | --- | --- |
| `whoami` | everyone | the signed-in account |
| `get_authoring_guide` | everyone | experiment contract, rules, exact package versions |
| `list_studies` / `get_study` | owner, admin | studies, versions, links, counts, code |
| `update_study` | editor | rename a study or change its description |
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
| `list_stimuli` / `remove_stimulus` | owner, admin | the study's stimulus files (with URLs) |
| `copy_stimuli` | editor (viewer on the source) | copy files from another study, e.g. for a replication |
| `create_upload_link` | owner, admin | one-hour page for dragging in stimulus files |
| `add_stimulus` / `import_stimulus_from_url` | owner, admin | add generated or public files |
| `create_participant_link` | owner, admin | Prolific / SONA / lab link pinned to one version |
| `close_participant_link` / `update_participant_link` | owner, admin | stop accepting participants / relabel a link |
| `set_esm_schedule` / `create_esm_codes` / `esm_status` | editor (status: viewer) | ESM / EMA through the MetaForge phone apps: schedule, enrolment codes, enrolment and compliance |
| `get_data` | owner, admin | trial rows as CSV (test data excluded by default) |
| `summarise_data` | viewer | per-group (participant, condition) n, mean, sd, median or share true, computed on the server |
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
debrief texts come from the document library (`server/documents.js`, in the database, never in the code; a fresh
install is seeded with a placeholder `example-protocol` from `server/documents/`); every edit is a new version
with its own label, and each study version keeps the texts it was saved with.

Access per study: owner (and admins), editor, viewer (`study_members`).

Stimuli are stored once by SHA-256 in `<data dir>/files`, shared between studies and saved versions.

`simulate` runs jsPsych's data-only simulation in jsdom, one participant per child process under Node's
permission model (`server/sim/`). In production those processes belong to the `second-order-sim` service:
no network, no database, read-only filesystem, memory-capped, reached over a unix socket (`SIM_SOCKET`).

Each version has a dashboard (`run.2ndorder.live/d/<preview token>`, `server/dashboard/`), ported from the
kit's: the timeline, run all / from an item / only an item, recruitment and condition switches, data with downloads; nothing
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
npm run invite -- --name "Your Name" --email you@example.org --admin
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
