// ESM edit links on the main origin: /esm-edit/<secret> is a page where someone without an account changes one
// ESM study's settings and makes codes (create_esm_edit_link), and /api/esm-edit/<secret> is what it calls. The
// secret is the only credential (no cookies are read), and each call acts as the researcher who made the link.
import { Router } from 'express';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createCodes, editLinkAccess, esmSettings, noteEditLinkUse, scheduleInput, setSchedule } from './esm.js';
import { StudyError } from './studies.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = await build({
  entryPoints: [resolve(root, 'server/esm-edit/page.js')],
  bundle: true, write: false, minify: true, format: 'iife', target: ['es2020'], outdir: 'out', logLevel: 'silent',
});
const js = built.outputFiles.find((f) => f.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script');
const css = built.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
const scriptHash = createHash('sha256').update(js).digest('base64');

const pageHtml = `<!doctype html>
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
</html>`;

const PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer', // the secret is in the URL
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; ` +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

// Guessing secrets: at most 30 unknown ones per address per hour.
const misses = new Map();
setInterval(() => misses.clear(), 60 * 60 * 1000).unref();

const codesInput = z.object({
  count: z.number().int().min(1).max(500),
  test: z.boolean().default(false),
  label: z.string().max(120).optional(),
}).strict();
const settingsInput = z.object(scheduleInput).strict();

const short = (v) => (v == null || v === '' ? 'none' : String(v).length > 40 ? `${String(v).slice(0, 40)}…` : String(v));

export const esmEdit = Router();

esmEdit.get('/esm-edit/:token', (_req, res) => {
  res.set(PAGE_HEADERS).type('html').send(pageHtml);
});

esmEdit.use('/api/esm-edit/:token', (req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  if ((misses.get(req.ip) ?? 0) >= 30) return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
  try {
    const access = editLinkAccess(req.params.token);
    if (!access) {
      misses.set(req.ip, (misses.get(req.ip) ?? 0) + 1);
      return res.status(404).json({ error: 'This edit link is not valid. Check that it was copied whole.' });
    }
    req.esmEdit = access;
    next();
  } catch (err) {
    if (err instanceof StudyError) return res.status(410).json({ error: err.message });
    next(err);
  }
});

const handle = (fn) => (req, res, next) => {
  try {
    res.json(fn(req));
  } catch (err) {
    if (err instanceof StudyError) return res.status(400).json({ error: err.message });
    next(err);
  }
};

const parsed = (schema, body) => {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw new StudyError(result.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '));
  return result.data;
};

esmEdit.get('/api/esm-edit/:token', handle((req) => {
  const { link, user, study } = req.esmEdit;
  return {
    study: { title: study.title },
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
