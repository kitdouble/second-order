// The signed-in researcher's web dashboard (/): their studies, data downloads and sharing.
// Same access rules as the MCP tools, through the same functions in studies.js and data.js.
import { Router } from 'express';
import { z } from 'zod';
import { db } from './db.js';
import { requireUser } from './session.js';
import { dashboardUrl, iso, listMembers, listStudies, removeMember, shareStudy, StudyError } from './studies.js';
import { createDownloadLink } from './data.js';

export const web = Router();
web.use(requireUser);

// Changes must come as JSON, which a cross-site form can't send without a CORS preflight.
web.use((req, res, next) => {
  if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'Send JSON.' });
  next();
});

const handled = (fn) => (req, res) => {
  try {
    res.json(fn(req));
  } catch (err) {
    if (err instanceof StudyError) return res.status(400).json({ error: err.message });
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues.map((i) => i.message).join('; ') });
    throw err;
  }
};

// GET /api/studies: every study the user can see, with what the list needs to show and search.
web.get('/', handled((req) => {
  const extra = db.prepare(
    `SELECT s.id, s.description,
            (SELECT token FROM links l WHERE l.study_id = s.id AND l.kind = 'preview' ORDER BY created_at DESC LIMIT 1) AS preview,
            (SELECT MAX(created_at) FROM study_versions r WHERE r.study_id = s.id) AS updated,
            (SELECT MAX(started_at) FROM runs r WHERE r.study_id = s.id AND r.is_test = 0) AS last_run,
            (SELECT COUNT(*) FROM links l WHERE l.study_id = s.id AND l.kind = 'live' AND l.closed_at IS NULL) AS open_links,
            EXISTS (SELECT 1 FROM esm_studies e WHERE e.study_id = s.id) AS esm
     FROM studies s`
  ).all();
  const byId = new Map(extra.map((row) => [row.id, row]));
  return {
    studies: listStudies(req.user).map((s) => {
      const row = byId.get(s.id) ?? {};
      return {
        ...s,
        description: row.description ?? null,
        dashboard_url: row.preview ? dashboardUrl(row.preview) : null,
        updated: iso(row.updated),
        last_participant: iso(row.last_run),
        open_links: row.open_links ?? 0,
        esm: Boolean(row.esm),
      };
    }),
  };
}));

const downloadOptions = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  include_test: z.boolean().default(false),
  completed_only: z.boolean().default(false),
  exclusions: z.enum(['none', 'mark', 'drop']).default('none'),
});

// POST /api/studies/:id/download: a one-hour download link, which the page opens straight away.
web.post('/:id/download', handled((req) =>
  createDownloadLink(req.user, req.params.id, downloadOptions.parse(req.body ?? {}))));

web.get('/:id/members', handled((req) => ({ members: listMembers(req.user, req.params.id) })));

const share = z.object({ email: z.string().trim().email('Enter a valid email address.'), role: z.enum(['editor', 'viewer']) });

web.post('/:id/members', handled((req) => {
  shareStudy(req.user, req.params.id, share.parse(req.body ?? {}));
  return { members: listMembers(req.user, req.params.id) };
}));

web.post('/:id/members/remove', handled((req) => {
  const { email } = z.object({ email: z.string().trim().email() }).parse(req.body ?? {});
  removeMember(req.user, req.params.id, email);
  return { members: listMembers(req.user, req.params.id) };
}));
