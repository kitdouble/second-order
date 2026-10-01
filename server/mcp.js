// The MCP endpoint: this is the product. Every capability is a tool here.
import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createInvite, db } from './db.js';
import { config } from './config.js';
import { requireMcpAuth } from './oauth.js';
import { closeLink, createLink, createStudy, describeStudy, exportData, listStudies, panelState, saveVersion, StudyError } from './studies.js';
import { CompileError } from './compile.js';
import { authoringGuide } from './guide.js';
import { addStimulus, createUploadLink, importFromUrl, listStimuli, removeStimulus } from './stimuli.js';
import { simulate } from './simulate.js';
import { checkLaunch, studyStatus } from './monitor.js';
import { createDownloadLink, deleteData, deletionLog } from './data.js';
import { MCP_APP_MIME, PANEL_URI, panelHtml, panelMeta, panelToolMeta } from './mcp-app.js';

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const userOf = (extra) => extra.authInfo.extra.user;

// Expected failures (bad study id, compile errors) go back to the model as tool errors it can fix.
function handled(handler) {
  return async (...callArgs) => {
    try {
      return await handler(...callArgs);
    } catch (err) {
      if (err instanceof CompileError) return { ...text(`Compile failed, nothing was saved:\n${err.message}`), isError: true };
      if (err instanceof StudyError) return { ...text(err.message), isError: true };
      throw err;
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
        'Never claim a study is collecting data unless get_study shows an open participant link with participants.',
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
    description: 'List your studies (admins see everyone\'s) with latest version and participant counts.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (extra) => text(listStudies(userOf(extra))));

  server.registerTool('create_study', {
    title: 'Create study',
    description: 'Create a new, empty study. Returns its id. Then write the experiment and save it with save_version.',
    inputSchema: {
      title: z.string().min(1).max(120).describe('Researcher-facing title (participants never see it)'),
      description: z.string().max(2000).optional().describe('What the study is about: design, conditions, measures'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handled(async (args, extra) => text(createStudy(userOf(extra), args))));

  server.registerTool('get_study', {
    title: 'Get study',
    description: 'A study\'s versions, participant links and counts, plus the code, packages and preview link of one version (latest by default).',
    inputSchema: {
      study_id: z.string().describe('Study id from list_studies or create_study'),
      version: z.number().int().positive().optional().describe('Version number to show; defaults to the latest'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handled(async ({ study_id, version }, extra) => text(describeStudy(userOf(extra), study_id, version))));

  server.registerTool('save_version', {
    title: 'Save experiment version',
    description:
      'Compile and save the complete experiment module as a new immutable version of the study, and return its preview link. ' +
      'Always send the whole module, not a diff. If compilation fails nothing is saved and the errors are returned. ' +
      'Follow get_authoring_guide.',
    inputSchema: {
      study_id: z.string(),
      code: z.string().min(1).max(500_000).describe('The full experiment module (ES module, jsPsych v8)'),
      notes: z.string().max(1000).optional().describe('What changed in this version, for the researcher'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handled(async ({ study_id, code, notes }, extra) => text(await saveVersion(userOf(extra), study_id, { code, notes }))));

  server.registerTool('create_participant_link', {
    title: 'Create participant link',
    description:
      'Create a link for real participants that always runs one fixed version. Returns the URL to paste into Prolific or SONA ' +
      '(with their placeholders already in it). Creating a link does not recruit anyone: the researcher launches the study on the platform. ' +
      'Only create one after the researcher has approved the version in preview.',
    inputSchema: {
      study_id: z.string(),
      version: z.number().int().positive().describe('The version participants will get'),
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
      'Collected trial data as CSV, one row per trial with run, version, participant and run_status (completed / stopped / incomplete) columns first. ' +
      'Rows are capped; for the full file, or to keep data out of the chat, use create_download_link. ' +
      'Test (preview) data is excluded unless include_test is true. Participant IDs are pseudonymous platform IDs.',
    inputSchema: {
      study_id: z.string(),
      version: z.number().int().positive().optional(),
      include_test: z.boolean().default(false),
      completed_only: z.boolean().default(false).describe('Only participants who reached the end'),
      max_rows: z.number().int().min(1).max(5000).default(2000),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handled(async ({ study_id, ...args }, extra) => {
    const result = exportData(userOf(extra), study_id, args);
    return text(`${result.runs.started} sessions (${result.runs.completed} completed), ${result.rows} rows${result.truncated ? ' (truncated: raise max_rows or filter by version)' : ''}.\n\n${result.csv}`);
  }));

  server.registerTool('simulate', {
    title: 'Simulate participants',
    description:
      'Run simulated participants through a saved version (jsPsych data-only simulation in a sandboxed simulated browser) and ' +
      'summarise the data: per-participant success/errors, columns, value counts (e.g. to check conditions and counterbalancing) and the ' +
      'first participant\'s rows. Use after every save_version, before showing the researcher the dashboard. Nothing is saved. ' +
      'Where supported, the researcher sees the results as a panel in the chat.',
    inputSchema: {
      study_id: z.string(),
      version: z.number().int().positive().optional().describe('Defaults to the latest'),
      participants: z.number().int().min(1).max(20).default(3),
      recruitment: z.enum(['prolific', 'sona', 'lab', 'none']).default('prolific').describe('Which version of the standard blocks to run'),
      simulation_options: z.record(z.string(), z.any()).optional().describe('Passed to jsPsych.simulate, e.g. {"default": {"data": {"rt": 600}}}'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: panelToolMeta,
  }, handled(async ({ study_id, ...args }, extra) => {
    const simulation = await simulate(userOf(extra), study_id, args);
    return {
      ...text(simulation),
      structuredContent: { view: 'simulation', simulation, study: panelState(userOf(extra), study_id, simulation.version) },
    };
  }));

  // The in-chat panel (an MCP App): hosts that support it (Claude, ChatGPT) show it in the conversation.
  server.registerResource('panel', PANEL_URI, {
    title: 'Second Order panel',
    description: 'In-chat dashboard, study overview and simulation results',
    mimeType: MCP_APP_MIME,
    _meta: panelMeta,
  }, async () => ({ contents: [{ uri: PANEL_URI, mimeType: MCP_APP_MIME, text: panelHtml, _meta: panelMeta }] }));

  server.registerTool('show_dashboard', {
    title: 'Show dashboard',
    description:
      'Show the researcher a version inside the chat where supported: its dashboard (timeline; run all, from any item or only one item; ' +
      'the recorded data with downloads; runs save nothing), the study\'s participant links and counts, versions and stimuli. ' +
      'The researcher can send feedback to the chat from it. Use after save_version + simulate. Always also give the dashboard_url, ' +
      'in case the panel does not appear.',
    inputSchema: {
      study_id: z.string(),
      version: z.number().int().positive().optional().describe('Defaults to the latest'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: panelToolMeta,
  }, handled(async ({ study_id, version }, extra) => {
    const study = panelState(userOf(extra), study_id, version);
    return {
      content: [{ type: 'text', text: `Dashboard for ${study.title}, version ${study.version}: ${study.dashboard_url}\nFull participant preview (saves test data): ${study.preview_url}` }],
      structuredContent: { view: 'dashboard', study },
    };
  }));

  /* ---------- Running a study ---------- */

  server.registerTool('study_status', {
    title: 'Study status',
    description:
      'How a study is going: per participant link, started / completed / in progress / abandoned / stopped early, completion rate, ' +
      'durations (median, quartiles), where participants who did not finish left off, errors from participants\' browsers (grouped, with ' +
      'trials and browsers), browsers used, recent sessions, and the same for preview (test) runs. Check it regularly while collecting data.',
    inputSchema: { study_id: z.string(), version: z.number().int().positive().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handled(async ({ study_id, version }, extra) => text(studyStatus(userOf(extra), study_id, { version }))));

  server.registerTool('check_launch', {
    title: 'Check launch readiness',
    description:
      'Before creating a participant link: simulates the version and checks consent and debrief, stated length against measured completion ' +
      'times, that someone has completed the preview, device check, preloading and stimulus size, balanced assignment, attention checks, ' +
      'columns the analysis needs, the completion URL and other open links. Returns pass / warn / fail per check. Fix every fail; go ' +
      'through warnings with the researcher.',
    inputSchema: {
      study_id: z.string(),
      version: z.number().int().positive().optional(),
      recruitment: z.enum(['prolific', 'sona', 'lab', 'none']).default('prolific'),
      completion_url: z.string().optional(),
      required_columns: z.array(z.string()).default([]).describe('Data columns the planned analysis needs, e.g. ["condition", "correct", "rt"]'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: panelToolMeta,
  }, handled(async ({ study_id, ...args }, extra) => {
    const check = await checkLaunch(userOf(extra), study_id, args);
    return { ...text(check), structuredContent: { view: 'check', check, study: panelState(userOf(extra), study_id, check.version) } };
  }));

  server.registerTool('create_download_link', {
    title: 'Create data download link',
    description:
      'A link (valid 1 hour) that downloads the full data set as CSV or JSON in the researcher\'s browser, with no row limit. The data never ' +
      'passes through the chat: use this when the researcher wants the data file, for large data sets, or when data should not be sent to the AI.',
    inputSchema: {
      study_id: z.string(),
      format: z.enum(['csv', 'json']).default('csv'),
      version: z.number().int().positive().optional(),
      include_test: z.boolean().default(false),
      completed_only: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handled(async ({ study_id, ...args }, extra) => text(createDownloadLink(userOf(extra), study_id, args))));

  server.registerTool('delete_participant_data', {
    title: 'Delete participant data',
    description:
      'Permanently delete data: one participant\'s sessions by platform ID (e.g. a withdrawal request), one session by run_id, or all test ' +
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
    description: 'A link (valid 1 hour) to a page where the researcher can drag in stimulus files from their computer. Use for files the researcher has; ask them to tell you when they are done, then list_stimuli and save a new version.',
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
    title: 'Remove stimulus',
    description: 'Remove a file from the study\'s current stimuli. Saved versions keep their copy.',
    inputSchema: { study_id: z.string(), name: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, handled(async ({ study_id, name }, extra) => text(removeStimulus(userOf(extra), study_id, name))));

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
