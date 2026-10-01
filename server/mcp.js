// The MCP endpoint: this is the product. Every capability is a tool here.
import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createInvite, db } from './db.js';
import { config } from './config.js';
import { requireMcpAuth } from './oauth.js';

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const userOf = (extra) => extra.authInfo.extra.user;

// Tool callbacks get (args, extra), or just (extra) when the tool takes no input.
function adminOnly(handler) {
  return (...callArgs) =>
    userOf(callArgs.at(-1)).role === 'admin'
      ? handler(...callArgs)
      : { ...text('Only Second Order admins can do this.'), isError: true };
}

function buildServer() {
  const server = new McpServer(
    { name: 'second-order', title: 'Second Order', version: '0.1.0' },
    { instructions: 'Second Order is an invite-only platform for building and running online behavioural experiments. All work happens through these tools; there is no researcher web interface.' }
  );

  server.registerTool('whoami', {
    title: 'Who am I',
    description: 'Show the Second Order account this connection is signed in as.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (extra) => text(userOf(extra)));

  server.registerTool('list_users', {
    title: 'List users',
    description: 'Admin only. List everyone with a Second Order account, plus invites that have not been used yet.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, adminOnly(async () => {
    const users = db.prepare(
      `SELECT u.name, u.email, u.role, datetime(u.created_at / 1000, 'unixepoch') AS joined,
              (SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id) AS passkeys
       FROM users u ORDER BY u.created_at`
    ).all();
    const pendingInvites = db.prepare(
      `SELECT name, email, role, datetime(expires_at / 1000, 'unixepoch') AS expires
       FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at`
    ).all(Date.now());
    return text({ users, pendingInvites });
  }));

  server.registerTool('create_invite', {
    title: 'Create invite link',
    description:
      'Admin only. Create a single-use sign-up link (valid ' + config.inviteDays + ' days) for a person to join Second Order with a passkey. ' +
      'If the email already has an account, the link adds a passkey for a new device instead. ' +
      'Returns the link for the admin to send; nothing is emailed.',
    inputSchema: {
      name: z.string().min(1).describe('Full name of the person being invited'),
      email: z.string().email().describe('Their email address (their account identifier)'),
      admin: z.boolean().default(false).describe('Make them an admin. Only do this if explicitly asked.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, adminOnly(async ({ name, email, admin }, extra) => {
    const { url } = createInvite({ name, email, role: admin ? 'admin' : 'member', createdBy: userOf(extra).id });
    return text(`Invite for ${name} <${email}>${admin ? ' as admin' : ''}. Single use, expires in ${config.inviteDays} days:\n\n${url}`);
  }));

  return server;
}

export const mcp = Router();

// Stateless Streamable HTTP: a fresh server + transport per request, no MCP sessions to keep.
mcp.post('/', requireMcpAuth, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

mcp.all('/', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});
