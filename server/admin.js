// The admin dashboard (/admin): users and the storage they use, invites, feedback and self-service ESM studies.
// The same operations as the admin-only MCP tools, for people signed in on the site with an admin account.
import { Router } from 'express';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { createInvite, db, now, SELF_SERVICE_EMAIL } from './db.js';
import { requireUser } from './session.js';
import { iso, StudyError } from './studies.js';
import { FILES_DIR } from './stimuli.js';
import { listFeedback, resolveFeedback } from './feedback.js';
import { listSelfService, reissueOwnerLink } from './esm.js';

export const admin = Router();
admin.use(requireUser);
admin.use((req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only Second Order admins can see this.' });
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

const fileSize = (path) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/* ---------- Storage ---------- */

// Per study: trial data (runs.bytes), experiment code and builds (live revisions and saved versions), and the
// stimulus files it refers to. Files are stored once by content, so a user's total counts each file once even when
// several of their studies use it, and the server total counts each file once overall.
function storageByStudy() {
  const studies = db.prepare(
    `SELECT s.id, s.title, s.owner_id, s.created_at,
            (SELECT COALESCE(SUM(bytes), 0) FROM runs r WHERE r.study_id = s.id) AS data_bytes,
            (SELECT COUNT(*) FROM runs r WHERE r.study_id = s.id AND r.is_test = 0) AS participants,
            (SELECT COALESCE(SUM(LENGTH(code) + LENGTH(bundle_js) + LENGTH(bundle_css)), 0) FROM study_versions v WHERE v.study_id = s.id) AS build_bytes,
            (SELECT COALESCE(SUM(LENGTH(code)), 0) FROM saved_versions v WHERE v.study_id = s.id) AS saved_bytes
     FROM studies s`
  ).all();
  const sizes = new Map(db.prepare('SELECT sha256, MAX(size) AS size FROM stimuli GROUP BY sha256').all().map((r) => [r.sha256, r.size]));
  const sizeOf = (sha) => {
    if (!sizes.has(sha)) sizes.set(sha, fileSize(join(FILES_DIR, sha)));
    return sizes.get(sha);
  };
  const shas = new Map(studies.map((s) => [s.id, new Set()]));
  for (const r of db.prepare('SELECT study_id, sha256 FROM stimuli').all()) shas.get(r.study_id)?.add(r.sha256);
  for (const v of db.prepare('SELECT study_id, stimuli FROM saved_versions').all()) {
    for (const sha of Object.values(JSON.parse(v.stimuli))) shas.get(v.study_id)?.add(sha);
  }
  return studies.map((s) => {
    const files = shas.get(s.id);
    return {
      ...s,
      code_bytes: s.build_bytes + s.saved_bytes,
      files,
      file_bytes: [...files].reduce((sum, sha) => sum + sizeOf(sha), 0),
      sizeOf,
    };
  });
}

function serverStorage() {
  let filesBytes = 0;
  let files = 0;
  try {
    for (const name of readdirSync(FILES_DIR)) {
      filesBytes += fileSize(join(FILES_DIR, name));
      files += 1;
    }
  } catch { /* no files yet */ }
  const dbBytes = ['', '-wal', '-shm'].reduce((sum, suffix) => sum + fileSize(config.dbPath + suffix), 0);
  return { database_bytes: dbBytes, files_bytes: filesBytes, files, total_bytes: dbBytes + filesBytes };
}

/* ---------- Overview and users ---------- */

admin.get('/overview', handled(() => {
  const studies = storageByStudy();
  const byOwner = new Map();
  for (const s of studies) {
    if (!byOwner.has(s.owner_id)) byOwner.set(s.owner_id, []);
    byOwner.get(s.owner_id).push(s);
  }

  const users = db.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.lab_member, u.created_at,
            (SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id) AS passkeys,
            (SELECT MAX(last_used_at) FROM credentials c WHERE c.user_id = u.id) AS last_sign_in,
            (SELECT COUNT(*) FROM study_members m WHERE m.user_id = u.id) AS shared_with
     FROM users u WHERE u.email != ? ORDER BY u.created_at`
  ).all(SELF_SERVICE_EMAIL).map((u) => {
    const own = (byOwner.get(u.id) ?? []).sort((a, b) => b.created_at - a.created_at);
    const files = new Set(own.flatMap((s) => [...s.files]));
    const sizeOf = own[0]?.sizeOf ?? (() => 0);
    const storage = {
      data_bytes: own.reduce((sum, s) => sum + s.data_bytes, 0),
      code_bytes: own.reduce((sum, s) => sum + s.code_bytes, 0),
      file_bytes: [...files].reduce((sum, sha) => sum + sizeOf(sha), 0),
      files: files.size,
    };
    storage.total_bytes = storage.data_bytes + storage.code_bytes + storage.file_bytes;
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      admin: u.role === 'admin',
      lab_member: Boolean(u.lab_member),
      joined: iso(u.created_at),
      last_sign_in: iso(u.last_sign_in),
      passkeys: u.passkeys,
      shared_with: u.shared_with,
      participants: own.reduce((sum, s) => sum + s.participants, 0),
      storage,
      studies: own.map((s) => ({
        id: s.id,
        title: s.title,
        created: iso(s.created_at),
        participants: s.participants,
        data_bytes: s.data_bytes,
        code_bytes: s.code_bytes,
        file_bytes: s.file_bytes,
        files: s.files.size,
      })),
    };
  });

  const selfServiceUser = db.prepare('SELECT id FROM users WHERE email = ?').get(SELF_SERVICE_EMAIL)?.id;
  const selfService = (byOwner.get(selfServiceUser) ?? []);
  const feedback = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM feedback GROUP BY status').all().map((r) => [r.status, r.n]));
  return {
    totals: {
      users: users.length,
      admins: users.filter((u) => u.admin).length,
      studies: studies.length,
      participants: studies.reduce((sum, s) => sum + s.participants, 0),
      data_bytes: studies.reduce((sum, s) => sum + s.data_bytes, 0),
      self_service_studies: selfService.length,
      open_feedback: feedback.open ?? 0,
    },
    server: serverStorage(),
    users,
    invites: pendingInvites(),
  };
}));

const userChange = z.object({ lab_member: z.boolean().optional(), admin: z.boolean().optional() });

admin.post('/users/:id', handled((req) => {
  const change = userChange.parse(req.body ?? {});
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND email != ?').get(req.params.id, SELF_SERVICE_EMAIL);
  if (!target) throw new StudyError('No such user.');
  if (change.admin === false && target.role === 'admin') {
    if (target.id === req.user.id) throw new StudyError('You can\'t remove your own admin access. Ask another admin.');
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
    if (admins <= 1) throw new StudyError('Second Order needs at least one admin.');
  }
  if (change.lab_member !== undefined) db.prepare('UPDATE users SET lab_member = ? WHERE id = ?').run(change.lab_member ? 1 : 0, target.id);
  if (change.admin !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(change.admin ? 'admin' : 'member', target.id);
  return { ok: true };
}));

// Signs the user out everywhere: their site sessions and the assistants' connector tokens.
admin.post('/users/:id/sign-out', handled((req) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!target) throw new StudyError('No such user.');
  const sessions = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id).changes;
  const tokens = db.prepare('DELETE FROM oauth_tokens WHERE user_id = ?').run(target.id).changes;
  return { sessions, tokens };
}));

/* ---------- Invites ---------- */

function pendingInvites() {
  return db.prepare(
    `SELECT i.token_hash, i.name, i.email, i.role, i.lab_member, i.created_at, i.expires_at, u.name AS created_by
     FROM invites i LEFT JOIN users u ON u.id = i.created_by
     WHERE i.used_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`
  ).all(now()).map((i) => ({
    id: i.token_hash.slice(0, 16),
    name: i.name || null,
    email: i.email || null,
    admin: i.role === 'admin',
    lab_member: Boolean(i.lab_member),
    created: iso(i.created_at),
    expires: iso(i.expires_at),
    created_by: i.created_by,
  }));
}

const invite = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.union([z.string().trim().email('Enter a valid email address, or leave it empty.'), z.literal('')]).optional(),
  admin: z.boolean().default(false),
  lab_member: z.boolean().default(true),
});

admin.post('/invites', handled((req) => {
  const { name, email, admin: isAdmin, lab_member } = invite.parse(req.body ?? {});
  let created;
  try {
    created = createInvite({ name, email, role: isAdmin ? 'admin' : 'member', labMember: lab_member, createdBy: req.user.id });
  } catch (err) {
    throw new StudyError(err.message);
  }
  return { url: created.url, expires_in_days: config.inviteDays, invites: pendingInvites() };
}));

admin.post('/invites/revoke', handled((req) => {
  const { id } = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }).parse(req.body ?? {});
  const { changes } = db.prepare("DELETE FROM invites WHERE substr(token_hash, 1, 16) = ? AND used_at IS NULL").run(id);
  if (!changes) throw new StudyError('That invite was already used or has expired.');
  return { invites: pendingInvites() };
}));

/* ---------- Feedback ---------- */

admin.get('/feedback', handled((req) => {
  const status = z.enum(['open', 'resolved', 'wontfix', 'all']).catch('open').parse(req.query.status);
  return listFeedback({ status, limit: 200 });
}));

const resolution = z.object({
  ids: z.array(z.string().regex(/^[0-9a-f-]{4,36}$/)).min(1).max(100),
  status: z.enum(['resolved', 'wontfix', 'open']),
  resolution: z.string().trim().max(1000).optional(),
});

admin.post('/feedback', handled((req) => resolveFeedback(req.user, resolution.parse(req.body ?? {}))));

/* ---------- Self-service ESM ---------- */

admin.get('/self-service', handled(() => listSelfService()));

admin.post('/self-service/:id/owner-link', handled((req) => reissueOwnerLink(req.params.id)));
