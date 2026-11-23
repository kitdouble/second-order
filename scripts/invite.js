// Create an invite link from the command line (until the admin MCP tools exist).
//   npm run invite -- [--name "Full Name" --email person@example.com] [--admin] [--not-lab]
import { parseArgs } from 'node:util';
import { createInvite, db } from '../server/db.js';
import { config } from '../server/config.js';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    email: { type: 'string' },
    admin: { type: 'boolean', default: false },
    'not-lab': { type: 'boolean', default: false },
  },
});

// Name and email are optional: without them the person enters their own when they create a passkey.
const existing = values.email ? db.prepare('SELECT name, role FROM users WHERE email = ?').get(values.email) : null;
const { url } = createInvite({ email: values.email, name: values.name, role: values.admin ? 'admin' : 'member', labMember: !values['not-lab'] });

console.log(existing
  ? `\n${existing.name} already has an account; this link adds a new passkey to it.`
  : `\nInvite for ${values.email ? `${values.name ?? values.email} <${values.email}>` : "a new user (they enter their name and email)"} as ${values.admin ? 'admin' : 'member'}.`);
console.log(`Expires in ${config.inviteDays} days, single use:\n\n  ${url}\n`);
