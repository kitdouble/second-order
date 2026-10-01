// Production simulation service: a separate systemd unit with no network, no database access and a
// read-only filesystem, listening on a unix socket for the main app (SIM_SOCKET).
import { createServer } from 'node:http';
import { chmodSync, rmSync } from 'node:fs';
import { runLocally } from './sandbox.js';

const socket = process.env.SIM_SOCKET;
rmSync(socket, { force: true });

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/run') return res.writeHead(404).end();
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    const result = await runLocally(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
}).listen(socket, () => {
  chmodSync(socket, 0o660);
  console.log(`Simulation service on ${socket}`);
});
