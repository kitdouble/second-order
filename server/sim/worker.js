// One simulated participant. Runs as its own process under Node's permission model (no file writes, no
// child processes, reads limited to node_modules), with an empty environment, and in production inside
// a service with no network. Input on stdin: { bundle, recruitment, version, simulationOptions }.
// Output on stdout: { rows, logs } or { error, logs }.
import jsdom from 'jsdom';

const { JSDOM, VirtualConsole } = jsdom;

// A desktop Chrome, so browser detection (deviceCheck) sees a normal computer.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const logs = [];
const virtualConsole = new VirtualConsole();
for (const level of ['error', 'warn']) virtualConsole.on(level, (...args) => logs.length < 50 && logs.push(`${level}: ${args.map(String).join(' ').slice(0, 500)}`));
virtualConsole.on('jsdomError', (err) => logs.length < 50 && logs.push(`error: ${String(err.message).slice(0, 500)}`));

let finished = false;
// Exit only once stdout has drained: stdout is a pipe, and exiting straight after a large write cuts
// the output short (which the sandbox would report as a crash).
const finish = (result) => {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify({ ...result, logs }), () => process.exit(0));
};
const fail = (err) => finish({ error: String(err?.stack || err).split('\n').slice(0, 6).join('\n') });
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);
let dom;
// Nothing left to run but the timeline hasn't finished: a trial is waiting for something that never
// happens in simulation (e.g. a real media event).
process.on('beforeExit', () => {
  const at = dom?.window.__soCurrentTrial;
  fail(at
    ? `The simulation stalled at a ${at.plugin} trial${at.name ? ` ("${at.name}")` : ''} after ${at.completed} trials: it waits for something that never happens in simulation. Give it simulation_options or check it ends.`
    : 'The simulation stalled before the first trial.');
});

try {
  dom = new JSDOM('<!doctype html><html><body><div id="jspsych-target"></div></body></html>', {
    url: 'https://run.2ndorder.live/simulate',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  // Set here rather than via `resources`, which would also switch on fetching subresources.
  Object.defineProperty(dom.window.navigator, 'userAgent', { get: () => USER_AGENT });
  dom.window.__SO_SIM__ = { recruitment: input.recruitment, version: input.version, participant: input.participant, simulationOptions: input.simulationOptions };
  dom.window.eval(input.bundle);
  const rows = await dom.window.__soSimulation;
  finish({ rows: JSON.parse(JSON.stringify(rows)), standIns: [...dom.window.__soStandIns] });
} catch (err) {
  fail(err);
}
