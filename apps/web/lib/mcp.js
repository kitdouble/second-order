// MCP server: stateless JSON-RPC over Streamable HTTP (JSON responses only).
// Eleven tools, grouped by noun. Reads and writes never share a tool.
// Approve, deploy, resume and close do not exist here at all.
import * as S from "./studies.js";
import * as P from "./prolific-tools.js";
import { SERVER_INSTRUCTIONS, guideText, exampleSpecYaml } from "./guide.js";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = "0.1.0";

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export const TOOLS = [
  {
    name: "search",
    title: "Search the lab",
    description: 'Search studies, specs, saved analyses/notes and comments. Example: {"query": "confidence feedback"}.',
    inputSchema: { type: "object", properties: { query: str("Words to look for.") }, required: ["query"] },
    annotations: RO,
  },
  {
    name: "get",
    title: "Get an object",
    description:
      "Read one thing by kind. Kinds: guide (read first), block_catalog, example_spec, lab_standards, studies (list), " +
      'study (summary with versions and comments), spec (YAML at a hash; default current), review_queue, person (meeting prep; name optional), saved (analyses and notes). ' +
      'Examples: {"kind": "guide"}; {"kind": "spec", "study": "dots-feedback-mratio"}; {"kind": "person", "name": "Alex"}.',
    inputSchema: {
      type: "object",
      properties: {
        kind: str("What to get.", {
          enum: ["guide", "block_catalog", "example_spec", "lab_standards", "studies", "study", "spec", "review_queue", "person", "saved"],
        }),
        study: str("Study slug, for study/spec/saved."),
        hash: str("Version hash (or its first 12 characters), for spec."),
        name: str("Person's name, for person."),
      },
      required: ["kind"],
    },
    annotations: RO,
  },
  {
    name: "diff",
    title: "Compare versions",
    description:
      "Plain-language differences between two versions of a study's spec, split into design (major) and wording (minor). " +
      'Defaults to current vs its parent. Example: {"study": "dots-feedback-mratio"}.',
    inputSchema: {
      type: "object",
      properties: { study: str("Study slug."), from: str("Older hash (optional)."), to: str("Newer hash (optional).") },
      required: ["study"],
    },
    annotations: RO,
  },
  {
    name: "status",
    title: "Study status",
    description:
      "Live state of a study: lifecycle status, participants by condition (in progress, complete, included), exclusion counts, " +
      'stopping-rule checks (BF10 over time), pilot report, quality flags and open findings. Example: {"study": "dots-feedback-mratio"}.',
    inputSchema: { type: "object", properties: { study: str("Study slug.") }, required: ["study"] },
    annotations: RO,
  },
  {
    name: "get_data",
    title: "Get data",
    description:
      "Pseudonymised data as CSV (session ids only). kind participants: one row per person with measures and exclusion flags. " +
      "kind trials: one row per trial, paged with offset/limit. Returns a data_hash to cite when saving analyses. " +
      'Example: {"study": "dots-feedback-mratio", "kind": "participants"}.',
    inputSchema: {
      type: "object",
      properties: {
        study: str("Study slug."),
        phase: str("main or pilot.", { enum: ["main", "pilot"] }),
        kind: str("participants or trials.", { enum: ["participants", "trials"] }),
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 20000 },
      },
      required: ["study"],
    },
    annotations: RO,
  },
  {
    name: "report",
    title: "Generate a report",
    description:
      "Generated documents and stored reports. kind prereg (markdown preregistration from the spec), r_script (R that reproduces the " +
      "platform's measures, exclusions and Bayes factor; the R output is the result of record), drift (approved spec vs what ran), " +
      'qa, simulation, pilot. Example: {"study": "dots-feedback-mratio", "kind": "r_script"}.',
    inputSchema: {
      type: "object",
      properties: {
        study: str("Study slug."),
        kind: str("Report kind.", { enum: ["prereg", "r_script", "drift", "qa", "simulation", "pilot"] }),
        hash: str("Version (defaults to the approved version, else current)."),
      },
      required: ["study", "kind"],
    },
    annotations: RO,
  },
  {
    name: "edit_spec",
    title: "Save or fork a spec",
    description:
      "Create or change a study. action save: send the complete YAML; it is validated, saved as a new version (a draft), and errors come " +
      "back with paths. The slug inside the YAML picks the study. Pass base_hash (the hash you edited) to avoid overwriting someone else's change. " +
      "Saving voids any pending approval. action fork: copy a study to a new slug (e.g. Experiment 4 from Experiment 3). " +
      'Examples: {"action": "save", "yaml": "spec: \\"0.1\\"\\nstudy: ...", "base_hash": "3f2a9c1e5b7d", "message": "Add attention check"}; ' +
      '{"action": "fork", "from_study": "beetle-exp3", "new_slug": "beetle-exp4", "title": "Experiment 4: disclaimer"}.',
    inputSchema: {
      type: "object",
      properties: {
        action: str("save or fork.", { enum: ["save", "fork"] }),
        yaml: str("Full spec YAML (save)."),
        base_hash: str("Hash your edit started from (save)."),
        message: str("One line on what changed and why (save)."),
        from_study: str("Study to copy (fork)."),
        new_slug: str("New study slug (fork)."),
        title: str("New title (fork)."),
      },
      required: ["action"],
    },
    annotations: RW,
  },
  {
    name: "check",
    title: "Run checks",
    description:
      "Run checks on a version (default current). kind qa: plays a synthetic participant through every condition and checks the data " +
      "(required before review). kind simulate: synthetic participants for power, sequential stopping and parameter recovery (up to ~40 s; " +
      "fewer reps if the time runs out). kind preview: links to click through each condition (data kept separate). " +
      'Example: {"study": "dots-feedback-mratio", "kind": "simulate", "reps": 50}.',
    inputSchema: {
      type: "object",
      properties: {
        study: str("Study slug."),
        kind: str("qa, simulate or preview.", { enum: ["qa", "simulate", "preview"] }),
        hash: str("Version (defaults to current)."),
        reps: { type: "integer", minimum: 5, maximum: 500 },
        n_per_group: { type: "array", items: { type: "integer", minimum: 2, maximum: 1000 } },
      },
      required: ["study", "kind"],
    },
    annotations: RW,
  },
  {
    name: "review",
    title: "Review workflow",
    description:
      "action request: ask for approval of the current version (needs passing QA). action comment: add a comment or a finding " +
      "(severity blocker|concern|consider). action resolve: accept or dismiss a finding with a one-line reason. " +
      "action next_task: (Lab Reviewer) claim the next AI review task. action submit_findings: (Lab Reviewer) submit findings for a task. " +
      "You cannot approve; a person does that in the web app. " +
      'Examples: {"action": "request", "study": "s", "summary": "Pilot-ready; added attention check"}; ' +
      '{"action": "resolve", "study": "s", "comment_id": "…", "status": "dismissed", "resolution": "Scale direction is intentional"}.',
    inputSchema: {
      type: "object",
      properties: {
        action: str("What to do.", { enum: ["request", "comment", "resolve", "next_task", "submit_findings"] }),
        study: str("Study slug."),
        summary: str("For request: what changed and why."),
        body: str("For comment."),
        severity: str("For comment: makes it a finding.", { enum: ["blocker", "concern", "consider"] }),
        path: str("Spec path or step id the comment is about."),
        comment_id: str("For resolve."),
        status: str("For resolve.", { enum: ["accepted", "dismissed"] }),
        resolution: str("For resolve: one line on why."),
        task_id: str("For submit_findings."),
        findings: {
          type: "array",
          description: "For submit_findings.",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["blocker", "concern", "consider"] },
              path: { type: "string" },
              message: { type: "string" },
              suggestion: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["severity", "message"],
          },
        },
      },
      required: ["action"],
    },
    annotations: RW,
  },
  {
    name: "save",
    title: "Save analysis or note",
    description:
      "Store an analysis script (R or other), a note, or codes (e.g. suspicion-probe coding) against a study. For analyses, cite the " +
      "data_hash from get_data and set exploratory true for anything not in the preregistered plan. " +
      'Example: {"study": "s", "kind": "analysis", "title": "Prior sensitivity", "content": "…", "exploratory": true, "data_hash": "ab12…"}.',
    inputSchema: {
      type: "object",
      properties: {
        study: str("Study slug."),
        kind: str("analysis, note or codes.", { enum: ["analysis", "note", "codes"] }),
        title: str("Short title."),
        content: str("The content."),
        exploratory: { type: "boolean" },
        data_hash: str("From get_data."),
      },
      required: ["study", "kind", "content"],
    },
    annotations: RW,
  },
  {
    name: "prolific",
    title: "Prolific",
    description:
      "Operate the study's Prolific listing within the approved envelope. action status: places and state. action add_places: add places " +
      "(never beyond the approved max N; assignment balances conditions). action approve_submissions: approve submissions with a completed " +
      "session; everything else is left for a person (never rejects). action demographics: Prolific demographics joined to session ids. " +
      'Example: {"study": "s", "action": "add_places", "add": 12}.',
    inputSchema: {
      type: "object",
      properties: {
        study: str("Study slug."),
        action: str("What to do.", { enum: ["status", "add_places", "approve_submissions", "demographics"] }),
        add: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["study", "action"],
    },
    annotations: { ...RW, openWorldHint: true },
  },
];

export function toolsFor(user) {
  return TOOLS.filter((t) => !(t.name === "prolific" && user.tier === "supervised"));
}

const need = (args, ...keys) => {
  for (const k of keys) if (args[k] === undefined || args[k] === null || args[k] === "") throw new S.ServiceError(`Missing "${k}".`);
};

async function call(name, a, actor, base) {
  switch (name) {
    case "search":
      need(a, "query");
      return S.search(actor, a.query);
    case "get":
      need(a, "kind");
      switch (a.kind) {
        case "guide":
          return { guide: guideText() };
        case "block_catalog":
          return { blocks: S.catalog() };
        case "example_spec":
          return { yaml: exampleSpecYaml };
        case "lab_standards":
          return { lab_standards: (await S.getLabStandards()) || "(none written yet)" };
        case "studies":
          return { studies: await S.listStudies(actor) };
        case "study": {
          need(a, "study");
          const [status, versions, comments] = await Promise.all([
            S.studyStatus(actor, a.study),
            S.listVersions(actor, a.study),
            S.listComments(actor, a.study),
          ]);
          return { ...status, versions: versions.slice(0, 10), comments: comments.slice(0, 30) };
        }
        case "spec":
          need(a, "study");
          return S.getSpec(actor, a.study, a.hash ?? null);
        case "review_queue":
          return { reviews: await S.reviewQueue(actor) };
        case "person":
          return S.personSummary(actor, a.name ?? null);
        case "saved":
          need(a, "study");
          return { items: await S.listSaved(actor, a.study) };
        default:
          throw new S.ServiceError(`Unknown kind "${a.kind}".`);
      }
    case "diff":
      need(a, "study");
      return S.diffVersions(actor, a.study, a.from ?? null, a.to ?? null);
    case "status":
      need(a, "study");
      return S.studyStatus(actor, a.study);
    case "get_data":
      need(a, "study");
      return S.getData(actor, a.study, { phase: a.phase ?? "main", kind: a.kind ?? "participants", offset: a.offset ?? 0, limit: a.limit ?? 5000 });
    case "report":
      need(a, "study", "kind");
      return S.report(actor, a.study, a.kind, { hash: a.hash ?? null });
    case "edit_spec":
      need(a, "action");
      if (a.action === "save") {
        need(a, "yaml");
        return S.saveSpec(actor, { yaml: a.yaml, baseHash: a.base_hash ?? null, message: a.message ?? null });
      }
      if (a.action === "fork") {
        need(a, "from_study", "new_slug");
        return S.forkStudy(actor, a.from_study, a.new_slug, a.title ?? null);
      }
      throw new S.ServiceError('action must be "save" or "fork".');
    case "check":
      need(a, "study", "kind");
      if (a.kind === "qa") return S.runQa(actor, a.study, a.hash ?? null);
      if (a.kind === "simulate") return S.runSimulation(actor, a.study, { hash: a.hash ?? null, reps: a.reps ?? null, n_per_group: a.n_per_group ?? null });
      if (a.kind === "preview") return S.makePreview(actor, a.study, base, a.hash ?? null);
      throw new S.ServiceError('kind must be "qa", "simulate" or "preview".');
    case "review":
      need(a, "action");
      if (a.action === "request") {
        need(a, "study");
        return S.requestReview(actor, a.study, a.summary ?? null);
      }
      if (a.action === "comment") {
        need(a, "study", "body");
        return S.addComment(actor, a.study, { body: a.body, severity: a.severity ?? null, path: a.path ?? null });
      }
      if (a.action === "resolve") {
        need(a, "study", "comment_id", "status", "resolution");
        return S.resolveComment(actor, a.study, a.comment_id, { status: a.status, resolution: a.resolution });
      }
      if (a.action === "next_task") return S.nextAiTask(actor);
      if (a.action === "submit_findings") {
        need(a, "task_id");
        return S.submitAiFindings(actor, a.task_id, a.findings ?? []);
      }
      throw new S.ServiceError("Unknown review action.");
    case "save":
      need(a, "study", "kind", "content");
      return S.saveItem(actor, a.study, a);
    case "prolific":
      need(a, "study", "action");
      if (actor.user.tier === "supervised") throw new S.ServiceError("Not available to supervised accounts.", 403);
      if (a.action === "status") return P.prolificStatus(actor, a.study);
      if (a.action === "add_places") {
        need(a, "add");
        return P.addPlaces(actor, a.study, a.add);
      }
      if (a.action === "approve_submissions") return P.approveSubmissions(actor, a.study);
      if (a.action === "demographics") return P.demographics(actor, a.study);
      throw new S.ServiceError("Unknown prolific action.");
    default:
      throw new S.ServiceError(`Unknown tool "${name}".`);
  }
}

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Handles one JSON-RPC message. Returns a response object, or null for notifications. */
export async function handleRpc(msg, actor, base) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid request.");
  const isNotification = msg.id === undefined || msg.id === null;
  const { id, method, params = {} } = msg;
  if (isNotification) return null;

  if (method === "initialize") {
    const requested = params.protocolVersion;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "second-order", title: "Second Order", version: VERSION },
        instructions: SERVER_INSTRUCTIONS,
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: toolsFor(actor.user) } };
  if (method === "tools/call") {
    const name = params.name;
    if (!toolsFor(actor.user).some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool "${name}".`);
    try {
      const result = await call(name, params.arguments ?? {}, actor, base);
      const text = JSON.stringify(result, null, 2);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: text.length > 400000 ? text.slice(0, 400000) + "\n…(truncated; use offset/limit)" : text }],
          isError: false,
        },
      };
    } catch (e) {
      const message = e instanceof S.ServiceError ? e.message : "Server error. The problem has been logged.";
      if (!(e instanceof S.ServiceError)) console.error(e);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: message }], isError: true } };
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
