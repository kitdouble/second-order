// The MCP endpoint: this is the product. Every capability is a tool here.
import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createInvite, db } from './db.js';
import { config } from './config.js';
import { requireMcpAuth } from './oauth.js';
import { closeLink, createLink, createStudy, describeStudy, exportData, listMembers, listStudies, panelState, removeMember, shareStudy, StudyError } from './studies.js';
import { collectGarbage, deleteSavedVersion, restoreVersion, saveVersion, storageReport, updateExperiment } from './live.js';
import { CompileError } from './compile.js';
import { authoringGuide } from './guide.js';
import { addStimulus, createUploadLink, importFromUrl, listStimuli, removeStimulus } from './stimuli.js';
import { simulate } from './simulate.js';
import { checkLaunch, studyStatus } from './monitor.js';
import { qualityReport, setExclusionRules } from './quality.js';
import { getDocument, listDocuments, saveDocument } from './documents.js';
import { createDownloadLink, deleteData, deletionLog } from './data.js';
import { leaveFeedback, listFeedback, resolveFeedback } from './feedback.js';
import { MCP_APP_MIME, PANEL_URI, panelHtml, panelMeta, panelToolMeta } from './mcp-app.js';

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const userOf = (extra) => extra.authInfo.extra.user;

const REPORT_NUDGE =
  '\n\nThis looks like a Second Order problem rather than a mistake in the request: call leave_feedback with what you were ' +
  'trying to do and this error (if you have not already reported it), then carry on helping the researcher.';

// Expected failures (bad study id, compile errors) go back to the model as tool errors it can fix.
// Platform limits and unexpected errors also ask the model to report them with leave_feedback.
function handled(handler) {
  return async (...callArgs) => {
    try {
      return await handler(...callArgs);
    } catch (err) {
      if (err instanceof CompileError) return { ...text(`Compile failed, nothing was saved:\n${err.message}`), isError: true };
      if (err instanceof StudyError) return { ...text(err.message + (err.platform ? REPORT_NUDGE : '')), isError: true };
      console.error(err);
      return { ...text(`Second Order hit an internal error: ${err.message}${REPORT_NUDGE}`), isError: true };
    }
  };
}

// Tool callbacks get (args, extra), or just (extra) when the tool takes no input.
function adminOnly(handler) {
  return (...callArgs) =>
    userOf(callArgs.at(-1)).role === 'admin'
      ? handler(...callArgs)
      : { ...text('Only Second Order admins can do this.'), isError: true };
}

function buildServer() {
  const server = new McpServer(
    { name: 'second-order', title: 'Second Order', version: '0.1.0' },
    {
      instructions:
        'Second Order is an invite-only platform for building and running online behavioural experiments with jsPsych. ' +
        'All work happens through these tools; there is no researcher web interface. ' +
        'Call get_authoring_guide before writing or changing experiment code. ' +
        'This is a rebuilt Second Order (October 2026): experiments are jsPsych modules, not YAML specs. Tools from the earlier ' +
        'version (guide/block catalogue via get, edit_spec, check qa/simulate/preview, review, prolific) no longer exist; ignore any ' +
        'memory of them. Each study has one live experiment: update_experiment changes it immediately (open participant links ' +
        'included); save_version stores a snapshot only when the researcher asks. Workflow: get_authoring_guide, create_study, ' +
        'update_experiment, simulate, show_dashboard, check_launch, ' +
        'create_participant_link, study_status, quality_report, get_data. ' +
        'Never claim a study is collecting data unless get_study shows an open participant link with participants. ' +
        'Second Order is new: when a tool fails, behaves unexpectedly, is missing something you needed, or its description or the ' +
        'guide misled you, call leave_feedback with a short note for the maintainers (no participant data). Do this without asking, ' +
        'once per distinct issue, and carry on helping the researcher.',
    }
  );

  server.registerTool('whoami', {
    title: 'Who am I',
    description: 'Show the Second Order account this connection is signed in as.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (extra) => text(userOf(extra)));

  server.registerTool('list_users', {
    title: 'List users',
    description: 'Admin only. List everyone with a Second Order account, plus invites that have not been used yet.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, adminOnly(async () => {
    const users = db.prepare(
      `SELECT u.name, u.email, u.role, datetime(u.created_at / 1000, 'unixepoch') AS joined,
              (SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id) AS passkeys
       FROM users u ORDER BY u.created_at`
    ).all();
    const pendingInvites = db.prepare(
      `SELECT name, email, role, datetime(expires_at / 1000, 'unixepoch') AS expires
       FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at`
    ).all(Date.now());
    return text({ users, pendingInvites });
  }));

  server.registerTool('create_invite', {
    title: 'Create invite link',
    description:
      'Admin only. Create a single-use sign-up link (valid ' + config.inviteDays + ' days) for a person to join Second Order with a passkey. ' +
      'If the email already has an account, the link adds a passkey for a new device instead. ' +
      'Returns the link for the admin to send; nothing is emailed.',
    inputSchema: {
      name: z.string().min(1).describe('Full name of the person being invited'),
      email: z.string().email().describe('Their email address (their account identifier)'),
      admin: z.boolean().default(false).describe('Make them an admin. Only do this if explicitly asked.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, adminOnly(async ({ name, email, admin }, extra) => {
    const { url } = createInvite({ name, email, role: admin ? 'admin' : 'member', createdBy: userOf(extra).id });
    return text(`Invite for ${name} <${email}>${admin ? ' as admin' : ''}. Single use, expires in ${config.inviteDays} days:\n\n${url}`);
  }));

  /* ---------- Experiments ---------- */

  server.registerTool('get_authoring_guide', {
    title: 'Experiment authoring guide',
    description: 'How to write a Second Order experiment: the module contract, rules, workflow and the exact jsPsych packages available. Read before writing or editing experiment code.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => text(authoringGuide()));

  server.registerTool('list_studies', {
    title: 'List studies',
    description: 'List your studies and those shared with you (admins see everyone\'s), with your role and participant counts.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (extra) => text(listStudies(userOf(extra))));

  server.registerTool('create_study', {
    title: 'Create study',
    description: 'Create a new, empty study. Returns its id. Then write the experiment with update_experiment.',
    inputSchema: {
      title: z.string().min(1).max(120).describe('Researcher-facing title (participants never see it)'),
      description: z.string().max(2000).optional().describe('What the study is about: design, conditions, measures'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handled(async (args, extra) => text(createStudy(userOf(extra), args))));

  server.registerTool('get_study', {
    title: 'Get study',
    description: 'A study\'s live experiment (code, packages, stimuli, preview and dashboard links, revision), participant links and counts, and saved versions. With version, shows that saved version\'s code instead.',
    inputSchema: {
      study_id: z.string().describe('Study id from list_studies or create_study'),
      version: z.number().int().positive().optional().describe('A saved version to show the code of; omit for the live experiment'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handled(async ({ study_id, version }, extra) => text(describeStudy(userOf(extra), study_id, version))));

  server.registerTool('update_experiment', {
    title: 'Update experiment',
    description:
      'Compile the complete experiment module and make it the study\'s live experiment, immediately, for everyone: preview, dashboard ' +
      'and open participant links (people part-way through keep their page; a reload restarts them on the new one). Always send the ' +
      'whole module, not a diff. If compilation fails nothing changes and the errors are returned. Follow get_authoring_guide. ' +
      'Before a big change while participants are taking part, offer to save_version first.',
    inputSchema: {
      study_id: z.string(),
      code: z.string().min(1).max(500_000).describe('The full experiment module (ES module, jsPsych v8)'),
      notes: z.string().max(1000).optional().describe('What changed, for the record'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handled(async ({ study_id, code, notes }, extra) => text(await updateExperiment(userOf(extra), study_id, { code, notes }))));

  server.registerTool('save_version', {
    title: 'Save a version',
    description:
      'Only when the researcher asks: store a named snapshot of the live experiment (code and its stimulus files) in the study\'s ' +
      'version history, to go back to later with restore_version. Saved versions keep their files until deleted.',
    inputSchema: {
      study_id: z.string(),
      name: z.string().min(1).max(120).describe('e.g. "Pilot", "Before adding feedback"'),
      notes: z.string().max(1000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handled(async ({ study_id, ...args }, extra) => text(saveVersion(userOf(extra), study_id, args))));

  server.registerTool('restore_version', {
    title: 'Restore a saved version',
    description:
      'Make a saved version the live experiment again: its code and exactly its stimulus files, live immediately. Replaces the current ' +
      'experiment and files, so first offer to save the current one, and only proceed after the researcher confirms.',
    inputSchema: { study_id: z.string(), version: z.number().int().positive(), researcher_confirmed: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, handled(async ({ study_id, ...args }, extra) => text(await restoreVersion(userOf(extra), study_id, args))));

  server.registerTool('delete_version', {
    title: 'Delete a saved version',
    description: 'Owner only. Delete a saved version from the history, freeing stimulus files nothing else uses. Cannot be undone; confirm with the researcher first.',
    inputSchema: { study_id: z.string(), version: z.number().int().positive(), researcher_confirmed: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, handled(async ({ study_id, ...args }, extra) => text(deleteSavedVersion(userOf(extra), study_id, args))));

  server.registerTool('storage_report', {
    title: 'Storage report',
    description: 'How much stimulus storage the live experiment and each saved version use, and how much deleting a saved version would free.',
    inputSchema: { study_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handled(async ({ study_id }, extra) => text(storageReport(userOf(extra), study_id))));

  server.registerTool('create_participant_link', {
    title: 'Create participant link',
    description:
      'Create a link for real participants. It runs the study\'s live experiment, including later updates. Returns the URL to paste into Prolific or SONA ' +
      '(with their placeholders already in it). Creating a link does not recruit anyone: the researcher launches the study on the platform. ' +
      'Only create one after the researcher has tried the experiment and check_launch has no fails.',
    inputSchema: {
      study_id: z.string(),
      recruitment: z.enum(['prolific', 'sona', 'lab', 'none']).describe('Where participants come from; decides ID capture and the end redirect'),
      completion_url: z.string().optional().describe('Prolific: https://app.prolific.com/submissions/complete?cc=...  SONA: the completion URL with survey_code=XXXX. Not used otherwise.'),
      label: z.string().max(200).optional().describe('e.g. "Pilot" or "Main sample"'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handled(async ({ study_id, ...args }, extra) => text(createLink(userOf(extra), study_id, args))));

  server.registerTool('close_participant_link', {
    title: 'Close participant link',
    description: 'Stop a participant link from accepting new participants. People already part-way through can still finish. Cannot be undone.',
    inputSchema: { study_id: z.string(), url: z.string().describe('The participant link URL (or its token)') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, handled(async ({ study_id, url }, extra) => text(closeLink(userOf(extra), study_id, url))));

  server.registerTool('get_data', {
    title: 'Get data',
    description:
      'Collected trial data as CSV, one row per trial with run, revision (which code it ran), participant and run_status (completed / stopped / incomplete) columns first. ' +
      'Each call returns whole sessions up to max_rows; if next_offset is given, call again with offset set to it to get the next sessions, ' +
      'until you have them all. To fit more in, filter to the trials you need (e.g. filter {"task": "test"}) and list only the columns you need. ' +
      'For the full file, or to keep data out of the chat, use create_download_link. ' +
      'Test (preview) data is excluded unless include_test is true. Participant IDs are pseudonymous platform IDs.',
    inputSchema: {
      study_id: z.string(),
      include_test: z.boolean().default(false),
      completed_only: z.boolean().default(false).describe('Only participants who reached the end'),
      exclusions: z.enum(['none', 'mark', 'drop']).default('none').describe('Apply the study\'s exclusion rules (set_exclusion_rules)'),
      filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]))
        .optional().describe('Keep only trial rows whose data fields equal these values (a list means any of them), e.g. {"task": "test", "block": [1, 2]}'),
      columns: z.array(z.string()).max(200).optional().describe('Only these data columns (run_id and participant_id are always kept). Omit for all.'),
      offset: z.number().int().min(0).default(0).describe('Sessions to skip: the next_offset from the previous call'),
      max_rows: z.number().int().min(1).max(5000).default(2000),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handled(async ({ study_id, ...args }, extra) => {
    const { runs, rows, page, csv } = exportData(userOf(extra), study_id, args);
    const summary =
      `${runs.started} sessions (${runs.completed} completed) match. This page: sessions ${page.offset + 1}-${page.offset + page.sessions_in_page} ` +
      `of ${page.sessions_total}, ${rows} rows.` +
      (page.partial_session ? ' That session alone is over max_rows, so it was cut short: filter rows or raise max_rows to see all of it.' : '') +
      (page.next_offset !== null ? ` More sessions remain: call get_data again with offset ${page.next_offset} (same other arguments).` : ' That is all of them.');
    return text(`${summary}\n\n${csv}`);
  }));

  server.registerTool('create_download_link', {
    title: 'Create data download link',
    description:
      'A link (valid 1 hour) that downloads the full data set as CSV or JSON in the researcher\'s browser, with no row limit. The data never ' +
      'passes through the chat: use this when the researcher wants the data file, for large data sets, or when data should not be sent to the AI.',
    inputSchema: {
      study_id: z.string(),
      format: z.enum(['csv', 'json']).default('csv'),
      include_test: z.boolean().default(false),
      completed_only: z.boolean().default(false),
      exclusions: z.enum(['none', 'mark', 'drop']).default('none').describe('Apply the study\'s exclusion rules: mark adds excluded / exclusion_reasons columns, drop leaves excluded sessions out'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handled(async ({ study_id, ...args }, extra) => text(createDownloadLink(userOf(extra), study_id, args))));

  server.registerTool('delete_participant_data', {
    title: 'Delete participant data',
    description:
      'Owner only. Permanently delete data: one participant\'s sessions by platform ID (e.g. a withdrawal request), one session by run_id, or all test ' +
      '(preview) data. Cannot be undone. Only call when the researcher has explicitly asked for this specific deletion; confirm the ID with ' +
      'them first. The deletion is logged (who, when, why, how many sessions) without the data or the raw ID.',
    inputSchema: {
      study_id: z.string(),
      participant_id: z.string().optional().describe('Prolific PID or SONA id'),
      run_id: z.string().optional(),
      test_data: z.boolean().optional().describe('true to delete all preview (test) data'),
      reason: z.string().max(500).optional().describe('e.g. "Withdrawal request by email, 3 Oct"'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, handled(async ({ study_id, ...args }, extra) => text(deleteData(userOf(extra), study_id, args))));

  server.registerTool('list_deletions', {
    title: 'List deletions',
    description: 'The study\'s deletion log: when data was deleted, what scope, how many sessions and why.',
    inputSchema: { study_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handled(async ({ study_id }, extra) => text(deletionLog(userOf(extra), study_id))));

  /* ---------- Stimuli ---------- */

  server.registerTool('list_stimuli', {
    title: 'List stimuli',
    description: 'The study\'s current stimulus files (images, audio, video, CSV/JSON/text) by name, for use with stimulus("name") and stimuliIn("folder").',
    inputSchema: { study_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handled(async ({ study_id }, extra) => text(listStimuli(userOf(extra), study_id))));

  server.registerTool('create_upload_link', {
    title: 'Create upload link',
    description: 'A link (valid 1 hour) to a page where the researcher can drag in stimulus files from their computer. Use for files the researcher has; ask them to tell you when they are done, then list_stimuli. New files are live straight away.',
    inputSchema: { study_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handled(async ({ study_id }, extra) => text(createUploadLink(userOf(extra), study_id))));

  server.registerTool('add_stimulus', {
    title: 'Add stimulus',
    description: 'Add a small file you generated (e.g. an SVG, a CSV of trial items) as a stimulus. Up to about 5 MB. Replaces a file with the same name.',
    inputSchema: {
      study_id: z.string(),
      name: z.string().describe('File name, optionally in folders, e.g. "shapes/circle.svg"'),
      content: z.string().max(7_000_000),
      encoding: z.enum(['text', 'base64']).default('text'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, handled(async ({ study_id, ...args }, extra) => text(addStimulus(userOf(extra), study_id, args))));

  server.registerTool('import_stimulus_from_url', {
    title: 'Import stimulus from URL',
    description: 'Download a file from a public https URL into the study\'s stimuli (up to 100 MB). Check the licence allows research use.',
    inputSchema: {
      study_id: z.string(),
      url: z.string().url(),
      name: z.string().optional().describe('Name to store it under; defaults to the URL\'s file name'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, handled(async ({ study_id, ...args }, extra) => text(await importFromUrl(userOf(extra), study_id, args))));

  server.registerTool('remove_stimulus', {
    title: 'Remove stimuli',
    description:
      'Remove files from the study\'s stimuli: one name, a list of names, or a whole folder. The live experiment stops using them ' +
      'straight away, and they are deleted from the server unless a saved version keeps them.',
    inputSchema: {
      study_id: z.string(),
      name: z.string().optional(),
      names: z.array(z.string()).max(10_000).optional(),
      folder: z.string().optional().describe('Remove every file in this folder (and its subfolders), e.g. "iaps"'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, handled(async ({ study_id, ...which }, extra) => {
    const removed = removeStimulus(userOf(extra), study_id, which);
    return text({ ...removed, ...collectGarbage() });
  }));

  /* ---------- Feedback to the maintainers ---------- */

  server.registerTool('leave_feedback', {
    title: 'Leave feedback for the maintainers',
    description:
      'Leave a note for the people who build Second Order about the platform itself: a bug, a limitation you hit, a tool or ' +
      'option that was missing, or a description/guide that was wrong or unclear. Use it whenever you notice one, without asking ' +
      'the researcher, once per distinct issue. Be concrete: what you tried, what happened, what would have helped. ' +
      'Never include participant data or personal details. This is not for the researcher\'s study content.',
    inputSchema: {
      kind: z.enum(['bug', 'limitation', 'suggestion', 'docs']).describe('bug: something broke; limitation: it could not do what was needed; suggestion: an improvement; docs: a tool description or the guide was wrong or unclear'),
      summary: z.string().min(5).max(200).describe('One line, e.g. "simulate times out on experiments with video stimuli"'),
      details: z.string().max(4000).optional().describe('What you tried, what happened (error text), and what would have helped'),
      tool: z.string().max(60).optional().describe('The tool this is about, if any'),
      study_id: z.string().optional().describe('The study you were working on, if relevant'),
      client: z.string().max(60).optional().describe('Which assistant you are, e.g. "Claude" or "ChatGPT"'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handled(async (args, extra) => text(leaveFeedback(userOf(extra), args))));

  server.registerTool('list_feedback', {
    title: 'List feedback',
    description: 'Admin only. Notes assistants have left with leave_feedback, newest first, for deciding what to fix next.',
    inputSchema: {
      status: z.enum(['open', 'resolved', 'wontfix', 'all']).default('open'),
      limit: z.number().int().min(1).max(500).default(50),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, adminOnly(async (args) => text(listFeedback(args))));

  server.registerTool('resolve_feedback', {
    title: 'Resolve feedback',
    description: 'Admin only. Close feedback notes once fixed (resolved) or decided against (wontfix), with a short note on what was done.',
    inputSchema: {
      ids: z.array(z.string().regex(/^[0-9a-f-]{4,36}$/)).min(1).max(100).describe('Note ids from list_feedback'),
      status: z.enum(['resolved', 'wontfix', 'open']).default('resolved'),
      resolution: z.string().max(1000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, adminOnly(async (args, extra) => text(resolveFeedback(userOf(extra), args))));

  return server;
}

export const mcp = Router();

// Stateless Streamable HTTP: a fresh server + transport per request, no MCP sessions to keep.
mcp.post('/', requireMcpAuth, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

mcp.all('/', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});
