// Builds the participant runtime into hosting/public/runtime/<version>/.
// Built output is committed: a study that ran on v1 keeps running on exactly
// that code, even after the runtime moves on. Bump the version in package.json
// (and RUNTIME_VERSION in @so/core) for any change participants could notice.
import { build } from "esbuild";
import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));
const version = `v${pkg.version.split(".")[0]}`;
// OUT_DIR lets CI rebuild elsewhere and check the committed bundle is current.
const out = process.env.OUT_DIR ?? path.join(here, "..", "hosting", "public", "runtime", version);
mkdirSync(out, { recursive: true });

// The sandbox bundle runs custom-jspsych code inside an isolated frame.
await build({
  entryPoints: [path.join(here, "src", "sandbox.js")],
  bundle: true,
  format: "iife",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  outfile: path.join(out, "sandbox.js"),
  logLevel: "warning",
});

await build({
  entryPoints: [path.join(here, "src", "main.js")],
  alias: { "@so/core": path.join(here, "..", "packages", "core", "src", "runtime.js") },
  bundle: true,
  format: "iife",
  target: ["es2020"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  outfile: path.join(out, "runtime.js"),
  logLevel: "warning",
});

// jspsych.css embeds Open Sans as base64 (~450 KB); we use system fonts instead.
const jspsychCss = readFileSync(path.join(here, "..", "node_modules", "jspsych", "css", "jspsych.css"), "utf8")
  .replace(/@font-face\s*{[^}]*}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\n{2,}/g, "\n");
const ours = readFileSync(path.join(here, "src", "runtime.css"), "utf8");
writeFileSync(path.join(out, "runtime.css"), `${jspsychCss}\n${ours}`);
console.log(`Built runtime ${version} -> ${path.relative(process.cwd(), out)}`);
