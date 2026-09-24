// Fails if the committed runtime bundle doesn't match its source, i.e. someone
// changed runtime code without rebuilding (and, if needed, bumping the version).
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "rt-"));
execFileSync("node", ["runtime/build.mjs"], { env: { ...process.env, OUT_DIR: tmp }, stdio: "inherit" });
const version = `v${JSON.parse(readFileSync("runtime/package.json", "utf8")).version.split(".")[0]}`;
for (const f of ["runtime.js", "runtime.css", "sandbox.js"]) {
  const a = readFileSync(path.join(tmp, f));
  const b = readFileSync(path.join("hosting/public/runtime", version, f));
  if (!a.equals(b)) {
    console.error(`hosting/public/runtime/${version}/${f} is out of date. Run "npm run build:runtime" and commit the result.`);
    process.exit(1);
  }
}
console.log(`Runtime ${version} bundle matches its source.`);
