// Everything environment-specific lives here. See .env.example.
const origin = (process.env.APP_ORIGIN || 'http://localhost:5173').replace(/\/$/, '');

export const config = {
  port: Number(process.env.API_PORT || 3000),
  origin,
  mcpUrl: `${origin}/mcp`,
  // Experiments run on their own origin so participant-facing code can never reach sessions or the API.
  runOrigin: (process.env.RUN_ORIGIN || 'http://127.0.0.1:3000').replace(/\/$/, ''),
  rpID: process.env.RP_ID || new URL(origin).hostname,
  rpName: 'Second Order',
  dbPath: process.env.DB_PATH || 'data/second-order.db',
  production: process.env.NODE_ENV === 'production',
  sessionDays: 30,
  inviteDays: 7,

  // OAuth clients may only send people back to these places: Claude, ChatGPT, and local tools
  // on loopback (Claude Code, Zed, MCP Inspector; checked in oauth.js). Add more with OAUTH_EXTRA_REDIRECTS (comma-separated prefixes).
  redirectAllowlist: [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/',
    ...(process.env.OAUTH_EXTRA_REDIRECTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ],
  accessTokenMinutes: 60,
  refreshTokenDays: 60,
};
