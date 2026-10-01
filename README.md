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
| `list_users` | admin | accounts and open invites |
| `create_invite` | admin | single-use sign-up link |

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
