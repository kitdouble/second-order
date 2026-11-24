// ESM pages for people without an account, on the main origin. Each secret is the only credential (no cookies
// are read), and each call acts as the account behind the link.
//
//   /esm-edit/<secret>   edit or owner link: change one ESM study's settings and make codes. Collaborator links
//                        (create_esm_edit_link) act as the researcher who made them; owner links belong to
//                        self-service studies and can also see participants and delete the study.
//   /esm/new             self-service sign-up with the shared key: a Qualtrics-only ESM study and its owner link
//                        (at the root of the ESM site when ESM_ORIGIN is set; /esm/new then redirects there).
//   /api/esm-edit/<secret>…, /api/esm-signup   what the pages call.
import express, { Router } from 'express';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  createCodes, createSelfServiceStudy, deleteSelfService, editLinkAccess, esmSettings, esmStatus, intakeSetup,
  noteEditLinkUse, scheduleInput, setSchedule, signupOpen,
} from './esm.js';
import { StudyError } from './studies.js';
import { reportFromPage } from './feedback.js';
import { config } from './config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function page(entry) {
  const built = await build({
    entryPoints: [resolve(root, entry)],
    bundle: true, write: false, minify: true, format: 'iife', target: ['es2020'], outdir: 'out', logLevel: 'silent',
  });
  const js = built.outputFiles.find((f) => f.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script');
  const css = built.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
  const scriptHash = createHash('sha256').update(js).digest('base64');
  return {
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>ESM settings</title>
<style>${css}</style>
</head>
<body>
<div id="root"><div class="pad">Loading…</div></div>
<script>${js}</script>
</body>
</html>`,
    headers: {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', // secrets are in URLs
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; ` +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  };
}

const editPage = await page('server/esm-edit/page.js');
const signupPage = await page('server/esm-edit/signup.js');

// Per-address limits: unknown link secrets and wrong sign-up keys (guessing), and studies set up.
const limits = { misses: new Map(), badKeys: new Map(), signups: new Map(), reports: new Map() };
setInterval(() => { limits.misses.clear(); limits.badKeys.clear(); limits.reports.clear(); }, 60 * 60 * 1000).unref();
setInterval(() => limits.signups.clear(), 24 * 60 * 60 * 1000).unref();
const over = (map, ip, max) => (map.get(ip) ?? 0) >= max;
const bump = (map, ip) => map.set(ip, (map.get(ip) ?? 0) + 1);

const codesInput = z.object({
  count: z.number().int().min(1).max(500),
  test: z.boolean().default(false),
  label: z.string().max(120).optional(),
}).strict();
const settingsInput = z.object(scheduleInput).strict();
const signupInput = z.object({
  key: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(200),
  institution: z.string().trim().max(150).optional(),
  app_title: z.string().trim().min(1).max(80),
  survey_url: z.string().trim().min(1).max(500),
}).strict();

const reportInput = z.object({
  summary: z.string().trim().min(1).max(200),
  details: z.string().max(4000).optional(),
  contact: z.union([z.string().trim().email().max(200), z.literal('')]).optional(),
}).strict();

// Report a problem: at most 5 an hour from one address.
function report(req, res, next, { studyId = null, page }) {
  res.set('Cache-Control', 'no-store');
  if (over(limits.reports, req.ip, 5)) return res.status(429).json({ error: 'Too many reports from here in the last hour. Please try again later.' });
  try {
    const input = parsed(reportInput, req.body);
    bump(limits.reports, req.ip);
    res.json(reportFromPage({ ...input, studyId, page, userAgent: req.get('user-agent') }));
  } catch (err) {
    if (err instanceof StudyError) return res.status(400).json({ error: err.message });
    next(err);
  }
}

const short = (v) => (v == null || v === '' ? 'none' : String(v).length > 40 ? `${String(v).slice(0, 40)}…` : String(v));

const parsed = (schema, body) => {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new StudyError(result.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '));
  }
  return result.data;
};

const handle = (fn) => (req, res, next) => {
  try {
    res.json(fn(req));
  } catch (err) {
    if (err instanceof StudyError) return res.status(400).json({ error: err.message });
    next(err);
  }
};

export const esmEdit = Router();

esmEdit.get('/esm-edit/:token', (_req, res) => res.set(editPage.headers).type('html').send(editPage.html));
// With an ESM site (ESM_ORIGIN), the sign-up page lives at its root; the old address sends people there.
esmEdit.get('/esm/new', (req, res) => (config.esmOrigin && req.get('host') !== new URL(config.esmOrigin).host
  ? res.redirect(302, config.esmOrigin)
  : res.set(signupPage.headers).type('html').send(signupPage.html)));

/* ---------- Self-service sign-up ---------- */

esmEdit.get('/api/esm-signup', (_req, res) => res.set('Cache-Control', 'no-store').json({ open: signupOpen() }));

esmEdit.post('/api/esm-report', (req, res, next) => report(req, res, next, { page: 'sign-up page (no study)' }));

esmEdit.post('/api/esm-signup', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (over(limits.badKeys, req.ip, 10)) return res.status(429).json({ error: 'Too many attempts with a wrong key. Try again in an hour.' });
  if (over(limits.signups, req.ip, 10)) return res.status(429).json({ error: 'Too many studies set up from here today. Try again tomorrow.' });
  try {
    const input = parsed(signupInput, req.body);
    const created = createSelfServiceStudy(input);
    bump(limits.signups, req.ip);
    res.json(created);
  } catch (err) {
    if (err instanceof StudyError) {
      if (err.badKey) bump(limits.badKeys, req.ip);
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

/* ---------- Edit and owner links ---------- */

esmEdit.use('/api/esm-edit/:token', (req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  if (over(limits.misses, req.ip, 30)) return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
  try {
    const access = editLinkAccess(req.params.token);
    if (!access) {
      bump(limits.misses, req.ip);
      return res.status(404).json({ error: 'This link is not valid. Check that it was copied whole.' });
    }
    req.esmEdit = access;
    next();
  } catch (err) {
    if (err instanceof StudyError) return res.status(410).json({ error: err.message });
    next(err);
  }
});

const ownerOnly = (req) => {
  if (req.esmEdit.link.kind !== 'owner') throw new StudyError('Only the study\'s owner link can do this.');
};

esmEdit.get('/api/esm-edit/:token', handle((req) => {
  const { link, user, study } = req.esmEdit;
  return {
    kind: link.kind,
    study: { title: link.kind === 'owner' ? esmSettings(user, study.id).app_title : study.title },
    shared_by: user.name,
    label: link.label,
    expires: new Date(link.expires_at).toISOString(),
    settings: esmSettings(user, study.id, { viaLink: true }),
  };
}));

esmEdit.post('/api/esm-edit/:token/settings', handle((req) => {
  const { link, user, study } = req.esmEdit;
  const changes = parsed(settingsInput, req.body);
  const result = setSchedule(user, study.id, changes);
  noteEditLinkUse(link.id, `saved ${Object.entries(changes).map(([k, v]) => `${k}: ${short(v)}`).join(', ')}`);
  return { result, settings: esmSettings(user, study.id, { viaLink: true }) };
}));

esmEdit.post('/api/esm-edit/:token/codes', handle((req) => {
  const { link, user, study } = req.esmEdit;
  const args = parsed(codesInput, req.body);
  const result = createCodes(user, study.id, args);
  noteEditLinkUse(link.id, `made ${result.codes.length} ${args.test ? 'test ' : ''}code${result.codes.length === 1 ? '' : 's'}${args.label ? ` (${short(args.label)})` : ''}`);
  return { result, settings: esmSettings(user, study.id, { viaLink: true }) };
}));

esmEdit.post('/api/esm-edit/:token/report', (req, res, next) =>
  report(req, res, next, { studyId: req.esmEdit.study.id, page: req.esmEdit.link.kind === 'owner' ? 'owner link' : `edit link (${req.esmEdit.link.label})` }));

esmEdit.get('/api/esm-edit/:token/intake', handle((req) => {
  const { link, user, study } = req.esmEdit;
  const result = intakeSetup(user, study.id);
  noteEditLinkUse(link.id, 'opened the intake survey setup');
  return result;
}));

esmEdit.get('/api/esm-edit/:token/status', handle((req) => {
  ownerOnly(req);
  const { user, study } = req.esmEdit;
  return esmStatus(user, study.id, { include_test: true });
}));

esmEdit.post('/api/esm-edit/:token/delete', handle((req) => {
  ownerOnly(req);
  if (req.body?.confirm !== true) throw new StudyError('Send confirm: true to delete.');
  return deleteSelfService(req.esmEdit.study.id);
}));

/* ---------- The ESM site (ESM_ORIGIN, e.g. esm.2ndorder.live) ---------- */

// Only these pages and their API: no accounts, MCP or experiments on this host.
export const esmSite = Router();
esmSite.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
  next();
});
esmSite.use(express.json({ limit: '64kb' }));
esmSite.get('/', (_req, res) => res.set(signupPage.headers).type('html').send(signupPage.html));
esmSite.use(esmEdit);
esmSite.use((_req, res) => res.status(404).type('text').send('Not found'));
