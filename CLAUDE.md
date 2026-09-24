# Second Order: notes for Claude (and people) working on this repo

Second Order runs the Meta Lab's online experiments. A study is a YAML spec; `packages/core` validates,
simulates, scores and describes it; `runtime/` renders it in the browser with jsPsych; `apps/web` is the
researcher app and MCP server; `services/ingest` stores participant data. Pushing to `main` deploys (see SETUP.md).

## Commands
- `npm test` runs the core tests. Run it before every commit.
- `npm run build:runtime` rebuilds `hosting/public/runtime/v1/` and `hosting/public/s/index.html` (committed; the
  page is generated from `runtime/src/index.html` with content-hashed asset URLs, so browsers never run a stale build). Run it after any change under `runtime/`
  or to `packages/core/src/runtime.js`, then `node scripts/check-runtime.mjs` (Cloud Build runs the same check and
  fails if the committed bundle is stale).
- `node scripts/embed-examples.mjs` after editing anything in `packages/core/examples/`.
- `npm run build -w @second-order/web` builds the web app.

## Rules that keep studies trustworthy
- Never change what an existing block version does. Studies are pinned to `name@N`; a behaviour change is a new
  version (`name@2`), registered alongside the old one. Wording or bug fixes that change data are behaviour changes.
- The runtime is shared by every live study. Changes there must be backwards compatible with every spec that
  validates today.
- Measures in `measures.js` and the R in `rscript.js` must agree exactly. If you touch one, touch the other and
  check a reproduction (the flanker example is a good one: R and JS agree to the last digit).
- Keep secrets, Prolific IDs and anything identifying out of logs, the agent's tools and exports.

## The lab library, and when to turn a task into a block
Custom jsPsych code (`custom-jspsych@1`) is fine for one study. To share it, the lab head adds the step to the lab
library (MCP tool `library`, action `add`; entries live in the `library_entries` table, and the Library page lists
them). Unchanged library code counts as vetted. If a library task keeps being used (the Library page flags 3+ studies), make it a
proper block so it gets validation, simulation, QA, power analysis and pilot checks. Use `blocks/choice.js` as the
model. Checklist:

1. **`packages/core/src/blocks/<name>.js`** exporting `{ ref: "<name>@1", title, description, params, columns,
   expand, estSeconds, simulate, pilotChecks, reviewerNotes }` and, if it has per-participant values like a score,
   `summarize` and `summaries`.
   - `params`: a zod `strictObject` with defaults and `.describe()` text; `superRefine` for cross-field checks
     (e.g. every correct answer is one of the keys). Agents read this schema from the block catalog, so describe
     each field well.
   - `columns`: every column the runtime records, with type and meaning. Measures and filters can only use these.
   - `expand(params, rng)`: the trial list for one participant, deterministic for a seed.
   - `simulate(params, items, observer, rng)`: plausible rows with the same columns. Add any observer parameters
     to `drawObserver` in `simulate.js` and to `simulation.truth` in the schema.
   - `pilotChecks(stepId, params)`: the checks the AI proposes for a pilot (trial counts, accuracy bands, timeouts).
   - `reviewerNotes`: what a reviewer should look at for this block.
2. **Register it** in `blocks/index.js`.
3. **Renderer** in `runtime/src/blocks.js`: a function `(step, ctx) => timeline` added to `RENDERERS` under the
   same ref. Record rows with `ctx.record(row)`; escape any researcher text. Rebuild the runtime.
4. **R and prereg**: if the block needs special handling in `rscript.js` or `prereg.js` (most don't), add it.
5. **Tests** in `packages/core/test/`: validation of a good and a bad spec, QA passing, a scoring check. Then an
   example spec in `packages/core/examples/` and `node scripts/embed-examples.mjs`.
6. **Guide**: mention it in `apps/web/lib/guide.js` if agents should reach for it.
7. Click through a preview of the example in each condition before merging.

Block changes go through a pull request that the lab head reviews. Consider protecting `main` on GitHub
(Settings > Branches: require a pull request) so nothing reaches participants without that review.
