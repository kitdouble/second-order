// Create an invite link from the command line (until the admin MCP tools exist).
//   npm run invite -- --name "Kit Double" --email kit@example.com --admin
import { parseArgs } from 'node:util';
import { createInvite, db } from '../server/db.js';
import { config } from '../server/config.js';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    email: { type: 'string' },
    admin: { type: 'boolean', default: false },
  },
});

if (!values.email || !values.name) {
  console.error('Usage: npm run invite -- --name "Full Name" --email person@example.com [--admin]');
  process.exit(1);
}

const existing = db.prepare('SELECT name, role FROM users WHERE email = ?').get(values.email);
const { url } = createInvite({ email: values.email, name: values.name, role: values.admin ? 'admin' : 'member' });

console.log(existing
  ? `\n${existing.name} already has an account; this link adds a new passkey to it.`
  : `\nInvite for ${values.name} <${values.email}> as ${values.admin ? 'admin' : 'member'}.`);
console.log(`Expires in ${config.inviteDays} days, single use:\n\n  ${url}\n`);
