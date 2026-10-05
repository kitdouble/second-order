// Start the MCP server in memory, list its tools as a client would, and compare with scripts/tools.txt.
// Run by deploy, so a tool that disappears by accident can't ship. After adding or removing a tool on
// purpose: npm run check:tools -- --write
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'so-tools-')), 'check.db');
const { buildServer } = await import('../server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
await buildServer().connect(serverSide);
const client = new Client({ name: 'check-tools', version: '1' });
await client.connect(clientSide);
const actual = (await client.listTools()).tools.map((t) => t.name).sort();

const file = new URL('./tools.txt', import.meta.url);
if (process.argv.includes('--write')) {
  writeFileSync(file, actual.join('\n') + '\n');
  console.log(`Wrote ${actual.length} tools to scripts/tools.txt`);
  process.exit(0);
}
const expected = readFileSync(file, 'utf8').split('\n').filter(Boolean);
const missing = expected.filter((t) => !actual.includes(t));
const added = actual.filter((t) => !expected.includes(t));
if (missing.length || added.length) {
  if (missing.length) console.error(`Missing tools: ${missing.join(', ')}`);
  if (added.length) console.error(`New tools: ${added.join(', ')}`);
  console.error('If this is intended, run: npm run check:tools -- --write');
  process.exit(1);
}
console.log(`All ${actual.length} MCP tools present.`);
process.exit(0);
