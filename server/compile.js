// Compiles experiment source into a self-contained browser bundle with the pinned jsPsych packages.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const ourPackage = readJson(resolve(root, 'package.json'));

// Experiments may import jsPsych and the official plugins/extensions we install, nothing else.
export const AVAILABLE_PACKAGES = Object.fromEntries(
  Object.keys(ourPackage.dependencies)
    .filter((name) => name === 'jspsych' || name.startsWith('@jspsych/'))
    .map((name) => [name, readJson(resolve(root, 'node_modules', name, 'package.json')).version])
);

const packageOf = (specifier) => specifier.match(/^(@[^/]+\/[^/]+|[^/]+)/)?.[1];

export class CompileError extends Error {
  constructor(messages) {
    super(messages.join('\n'));
    this.messages = messages;
  }
}

const noDefault = () =>
  new CompileError(['The experiment must `export default function buildTimeline(jsPsych, context)` returning a timeline array.']);

const format = (m) => (m.location ? `line ${m.location.line}:${m.location.column + 1}: ${m.text}` : m.text);

// manifest: {stimulus name: URL}, fixed into the bundle so a version always uses the same files.
// external: leave packages unbundled (used for the quick shape check).
function experimentPlugin(code, manifest = {}, { external = false } = {}) {
  return {
    name: 'second-order',
    setup(b) {
      b.onResolve({ filter: /^second-order:experiment$/ }, () => ({ path: 'experiment.js', namespace: 'experiment' }));
      b.onResolve({ filter: /^second-order:manifest$/ }, () => ({ path: 'manifest.json', namespace: 'manifest' }));
      b.onLoad({ filter: /.*/, namespace: 'manifest' }, () => ({ contents: JSON.stringify(manifest), loader: 'json' }));
      b.onResolve({ filter: /^second-order$/ }, () => (external ? { path: 'second-order', external: true } : { path: resolve(root, 'server/lib/index.js') }));
      b.onResolve({ filter: /^second-order:runtime/ }, (args) => ({
        path: resolve(root, 'server/runtime', args.path.endsWith('.css') ? 'client.css' : 'client.js'),
      }));
      b.onLoad({ filter: /.*/, namespace: 'experiment' }, () => ({ contents: code, loader: 'js', resolveDir: root }));
      // Imports written in the experiment itself must name an available package.
      b.onResolve({ filter: /.*/, namespace: 'experiment' }, (args) => {
        if (args.path === 'second-order') return external ? { path: args.path, external: true } : undefined;
        const name = packageOf(args.path);
        if (args.path.startsWith('.') || args.path.startsWith('/') || !(name in AVAILABLE_PACKAGES)) {
          return {
            errors: [{
              text: `Cannot import "${args.path}". Experiments can only import "second-order", jspsych and the installed @jspsych packages (see get_authoring_guide).`,
            }],
          };
        }
        return external ? { path: args.path, external: true } : undefined; // else normal resolution from node_modules
      });
    },
  };
}

const entry = `
import 'jspsych/css/jspsych.css';
import 'second-order:runtime.css';
import { start } from 'second-order:runtime';
import * as experiment from 'second-order:experiment';
start(experiment);
`;

export async function compileExperiment(code, manifest = {}) {
  // 1. Check the module's shape on its own, with packages left external.
  let shape;
  try {
    shape = await build({
      stdin: { contents: 'export * from "second-order:experiment"; export { default } from "second-order:experiment";', resolveDir: root },
      bundle: true, write: false, metafile: true, format: 'esm', logLevel: 'silent',
      plugins: [experimentPlugin(code, manifest, { external: true })],
    });
  } catch (err) {
    const errors = err.errors ?? [{ text: err.message }];
    if (errors.some((e) => /No matching export .* for import "default"/.test(e.text))) throw noDefault();
    throw new CompileError(errors.map(format));
  }
  const exports = Object.values(shape.metafile.outputs)[0]?.exports ?? [];
  if (!exports.includes('default')) throw noDefault();

  // 2. Bundle for the browser.
  let result;
  try {
    result = await build({
      stdin: { contents: entry, resolveDir: root, loader: 'js' },
      bundle: true, write: false, metafile: true, minify: true, format: 'iife', target: ['es2020'],
      outdir: 'out', entryNames: 'bundle', logLevel: 'silent', legalComments: 'none',
      loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
      plugins: [experimentPlugin(code, manifest)],
    });
  } catch (err) {
    throw new CompileError((err.errors ?? [{ text: err.message }]).map(format));
  }

  const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
  const used = new Set(
    Object.keys(result.metafile.inputs)
      .map((path) => path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1])
      .filter((name) => name in AVAILABLE_PACKAGES)
  );
  const packages = {
    'second-order-runtime': ourPackage.version, // bump package.json version when server/runtime changes
    ...Object.fromEntries([...used].sort().map((name) => [name, AVAILABLE_PACKAGES[name]])),
  };
  const hash = createHash('sha256').update(js).update(css).digest('hex').slice(0, 16);
  return { js, css, packages, hash, warnings: result.warnings.map(format) };
}

// The same experiment and stimuli, built to run under jsPsych's data-only simulation (server/sim/).
export async function compileSimulation(code, manifest = {}) {
  try {
    const result = await build({
      stdin: { contents: "import './server/sim/entry.js';", resolveDir: root, loader: 'js' },
      bundle: true, write: false, format: 'iife', target: ['es2022'], outdir: 'out', logLevel: 'silent',
      loader: { '.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.svg': 'empty', '.png': 'dataurl' },
      plugins: [experimentPlugin(code, manifest)],
    });
    return result.outputFiles.find((f) => f.path.endsWith('.js')).text;
  } catch (err) {
    throw new CompileError((err.errors ?? [{ text: err.message }]).map(format));
  }
}

// The researcher dashboard for a version (server/dashboard/): same experiment, stimuli and packages.
export async function compileDashboard(code, manifest = {}) {
  try {
    const result = await build({
      stdin: { contents: "import './server/dashboard/entry.js';", resolveDir: root, loader: 'js' },
      bundle: true, write: false, minify: true, format: 'iife', target: ['es2020'], outdir: 'out', entryNames: 'dash',
      logLevel: 'silent', legalComments: 'none',
      loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
      plugins: [experimentPlugin(code, manifest)],
    });
    const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
    const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
    return { js, css, hash: createHash('sha256').update(js).update(css).digest('hex').slice(0, 16) };
  } catch (err) {
    throw new CompileError((err.errors ?? [{ text: err.message }]).map(format));
  }
}

export const RUNTIME_VERSION = ourPackage.version;
