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
        'This is a rebuilt Second Order (October 2026): experiments are jsPsych modules, not YAML specs. Tools from the earlier ' +
        'version (guide/block catalogue via get, edit_spec, check qa/simulate/preview, review, prolific) no longer exist; ignore any ' +
        'memory of them. Each study has one live experiment: update_experiment changes it immediately (open participant links ' +
        'included); save_version stores a snapshot only when the researcher asks. Workflow: get_authoring_guide, create_study, ' +
        'update_experiment, simulate, show_dashboard, check_launch, ' +
        'create_participant_link, study_status, quality_report, get_data. ' +
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
      'Rows are capped; for the full file, or to keep data out of the chat, use create_download_link. ' +
      'Test (preview) data is excluded unless include_test is true. Participant IDs are pseudonymous platform IDs.',
    inputSchema: {
      study_id: z.string(),
      include_test: z.boolean().default(false),
      completed_only: z.boolean().default(false).describe('Only participants who reached the end'),
      exclusions: z.enum(['none', 'mark', 'drop']).default('none').describe('Apply the study\'s exclusion rules (set_exclusion_rules)'),
      max_rows: z.number().int().min(1).max(5000).default(2000),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handled(async ({ study_id, ...args }, extra) => {
    const result = exportData(userOf(extra), study_id, args);
    return text(`${result.runs.started} sessions (${result.runs.completed} completed), ${result.rows} rows${result.truncated ? ' (truncated: raise max_rows, or use create_download_link)' : ''}.\n\n${result.csv}`);
  }));

  server.registerTool('simulate', {
    title: 'Simulate participants',
    description:
      'Run simulated participants through the live experiment (jsPsych data-only simulation in a sandboxed simulated browser) and ' +
      'summarise the data: per-participant success/errors, columns, value counts (e.g. to check conditions and counterbalancing) and the ' +
      'first participant\'s rows. Use after every update_experiment, before showing the researcher the dashboard. Nothing is saved. ' +
      'Where supported, the researcher sees the results as a panel in the chat.',
    inputSchema: {
      study_id: z.string(),
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
      structuredContent: { view: 'simulation', simulation, study: panelState(userOf(extra), study_id) },
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
      'Show the researcher the live experiment inside the chat where supported: its dashboard (timeline; run all, from any item or only one item; ' +
      'the recorded data with downloads; runs save nothing), the study\'s participant links and counts, saved versions and stimuli. ' +
      'The researcher can send feedback to the chat from it. Use after update_experiment + simulate. Always also give the dashboard_url, ' +
      'in case the panel does not appear.',
    inputSchema: { study_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: panelToolMeta,
  }, handled(async ({ study_id }, extra) => {
    const study = panelState(userOf(extra), study_id);
    return {
      content: [{ type: 'text', text: `Dashboard for ${study.title} (live, revision ${study.revision}): ${study.dashboard_url}\nFull participant preview (saves test data): ${study.preview_url}` }],
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
    inputSchema: { study_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handled(async ({ study_id }, extra) => text(studyStatus(userOf(extra), study_id))));

  server.registerTool('check_launch', {
    title: 'Check launch readiness',
    description:
      'Before creating a participant link: simulates the live experiment and checks consent and debrief, stated length against measured completion ' +
      'times, that someone has completed the preview, device check, preloading and stimulus size, balanced assignment, attention checks, ' +
      'columns the analysis needs, the completion URL and other open links. Returns pass / warn / fail per check. Fix every fail; go ' +
      'through warnings with the researcher.',
    inputSchema: {
      study_id: z.string(),
      recruitment: z.enum(['prolific', 'sona', 'lab', 'none']).default('prolific'),
      completion_url: z.string().optional(),
      required_columns: z.array(z.string()).default([]).describe('Data columns the planned analysis needs, e.g. ["condition", "correct", "rt"]'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: panelToolMeta,
  }, handled(async ({ study_id, ...args }, extra) => {
    const check = await checkLaunch(userOf(extra), study_id, args);
    return { ...text(check), structuredContent: { view: 'check', check, study: panelState(userOf(extra), study_id) } };
  }));

  server.registerTool('quality_report', {
    title: 'Data quality report',
    description:
      'After a pilot (or any time): sessions, completion, median length against the length in consent and the Prolific pay per hour it ' +
      'works out to, where people dropped out, each session\'s duration, share of too-fast responses and attention checks passed, which ' +
      'sessions the study\'s exclusion rules exclude and why, and response distributions of the kept participants. Shown in the panel. ' +
      'Never deletes anything.',
    inputSchema: {
      study_id: z.string(),
      include_test: z.boolean().default(false).describe('Include preview (test) sessions, e.g. before any real pilot'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: panelToolMeta,
  }, handled(async ({ study_id, ...args }, extra) => {
    const quality = qualityReport(userOf(extra), study_id, args);
    return { ...text(quality), structuredContent: { view: 'quality', quality, study: panelState(userOf(extra), study_id) } };
  }));

  server.registerTool('set_exclusion_rules', {
    title: 'Set exclusion rules',
    description:
      'Set the study\'s exclusion rules, decided once (ideally after the pilot, before the main sample) and applied the same way by ' +
      'quality_report, get_data and create_download_link. Only set rules the researcher has agreed to (ideally as preregistered). ' +
      'Rules given are merged into the existing ones.',
    inputSchema: {
      study_id: z.string(),
      require_completed: z.boolean().optional().describe('Exclude incomplete and stopped-early sessions (default true)'),
      min_minutes: z.number().positive().nullable().optional().describe('Exclude sessions faster than this'),
      fast_rt_ms: z.number().int().positive().optional().describe('A response quicker than this counts as too fast (default 200)'),
      max_fast_share: z.number().min(0).max(1).nullable().optional().describe('Exclude if more than this share of responses are too fast'),
      attention: z.union([z.literal('all'), z.number().int().nonnegative()]).nullable().optional()
        .describe('"all": every attention check passed; a number: at least that many. Attention checks are trials named "attention…" that record correct.'),
      exclude_participants: z.array(z.string()).optional().describe('Platform IDs to exclude by hand (replaces the list)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, handled(async ({ study_id, ...rules }, extra) => text(setExclusionRules(userOf(extra), study_id,
    Object.fromEntries(Object.entries(rules).filter(([, v]) => v !== undefined))))));

  /* ---------- Consent and debrief library ---------- */

  server.registerTool('list_documents', {
    title: 'List consent and debrief documents',
    description: 'The lab\'s ethics documents (e.g. "hrec-2022-796"): which consent and debrief texts exist for which recruitment, with their labels.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => text(listDocuments()));

  server.registerTool('get_document', {
    title: 'Get consent or debrief text',
    description: 'The HTML of a consent or debrief text (latest version, or an earlier one) and its history. Placeholders: {{minutes}}, {{payment}}, {{credit}}, {{logo}}.',
    inputSchema: {
      document: z.string(), kind: z.enum(['consent', 'debrief']), recruitment: z.enum(['prolific', 'sona', 'lab', 'any']),
      version: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handled(async (args) => text(getDocument(args))));

  server.registerTool('save_document', {
    title: 'Save consent or debrief text',
    description:
      'Add a new version of a consent or debrief text, or a new document for another protocol. These texts are ethics-approved: only call ' +
      'this when the researcher has explicitly asked for this change, after showing them the exact new wording (or the precise changes) ' +
      'and getting their explicit confirmation, and set researcher_confirmed only then. Never change wording on your own initiative or ' +
      'to fix style. Give each new text its own form_label (approved version and date), which is recorded in the data. Live experiments ' +
      'using the document pick it up straight away (they rebuild on next load).',
    inputSchema: {
      document: z.string().describe('Document id, e.g. "hrec-2022-796" or a new one like "hrec-2025-123"'),
      kind: z.enum(['consent', 'debrief']),
      recruitment: z.enum(['prolific', 'sona', 'lab', 'any']).describe('Who sees this text; "any" applies where there is no specific one'),
      title: z.string().max(200).optional(),
      form_label: z.string().min(3).max(200).describe('Recorded in the data as consent_form / debrief_form, e.g. "2025/123 Lab v2 (1 Oct 2026)"'),
      html: z.string().min(20).max(200_000).describe('Full text as HTML; use the pis-* classes of the existing texts for the same layout'),
      change_note: z.string().max(1000).optional().describe('What changed and why, e.g. "Amendment approved 30 Sep 2026: added researcher"'),
      researcher_confirmed: z.boolean().describe('true only after the researcher explicitly confirmed this exact wording'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, handled(async (args, extra) => text(saveDocument(userOf(extra), args))));

  /* ---------- Collaborators ---------- */

  server.registerTool('share_study', {
    title: 'Share study',
    description: 'Owner only. Give another Second Order account access to a study: "editor" (change the experiment, links, stimuli, rules) or ' +
      '"viewer" (read, simulate and see data). Sharing again changes their role. They need an account (an admin can create_invite).',
    inputSchema: { study_id: z.string(), email: z.string().email(), role: z.enum(['editor', 'viewer']) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, handled(async ({ study_id, ...args }, extra) => text(shareStudy(userOf(extra), study_id, args))));

  server.registerTool('list_members', {
    title: 'List study members',
    description: 'Who has access to a study and with what role.',
    inputSchema: { study_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handled(async ({ study_id }, extra) => text(listMembers(userOf(extra), study_id))));

  server.registerTool('remove_member', {
    title: 'Remove study member',
    description: 'Owner only. Remove someone\'s access to a study.',
    inputSchema: { study_id: z.string(), email: z.string().email() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, handled(async ({ study_id, email }, extra) => text(removeMember(userOf(extra), study_id, email))));

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
