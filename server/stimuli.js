// Stimulus files (images, audio, video, small data files). Stored once by content hash in
// <data dir>/files; each study has a current set of names, and each version fixes the set it was saved with.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { db, hash, newToken, now } from './db.js';
import { config } from './config.js';
import { findStudy, iso, StudyError } from './studies.js';

export const FILES_DIR = resolve(dirname(config.dbPath), 'files');
mkdirSync(FILES_DIR, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS stimuli (
    study_id    TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,              -- path-like, e.g. faces/f1.png
    sha256      TEXT NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_by TEXT NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (study_id, name)
  );

  CREATE TABLE IF NOT EXISTS upload_links (
    token_hash  TEXT PRIMARY KEY,
    study_id    TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL
  );
`);

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_STUDY_BYTES = 1024 * 1024 * 1024;
const UPLOAD_LINK_MINUTES = 60;

export const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', bmp: 'image/bmp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  csv: 'text/csv', json: 'application/json', txt: 'text/plain',
};
export const extensionOf = (name) => name.split('.').pop().toLowerCase();

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,99}$/;

export function checkName(raw) {
  const name = String(raw ?? '').trim().replace(/^\/+/, '');
  if (!name || name.length > 200 || !name.split('/').every((s) => SEGMENT.test(s) && s !== '..')) {
    throw new StudyError(`"${raw}" isn't a valid stimulus name. Use letters, numbers, spaces, - _ . ( ) and / for folders, e.g. faces/f1.png`);
  }
  if (!(extensionOf(name) in MIME)) {
    throw new StudyError(`"${name}" has an unsupported type. Allowed: ${Object.keys(MIME).join(', ')}.`, { platform: true });
  }
  return name;
}

/* ---------- Storing files ---------- */

// Streams bytes to a temp file while hashing, then moves it into place under its hash.
async function storeStream(source) {
  const tmp = join(FILES_DIR, `.upload-${newToken()}`);
  const sha = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _enc, done) {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) return done(new StudyError(`Files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB.`, { platform: true }));
      sha.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(source, meter, createWriteStream(tmp));
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  const digest = sha.digest('hex');
  if (size === 0) {
    rmSync(tmp, { force: true });
    throw new StudyError('That file is empty.');
  }
  const target = join(FILES_DIR, digest);
  if (existsSync(target)) rmSync(tmp, { force: true });
  else renameSync(tmp, target);
  return { sha256: digest, size };
}

function storeBuffer(buffer) {
  if (buffer.length === 0) throw new StudyError('That file is empty.');
  if (buffer.length > MAX_FILE_BYTES) throw new StudyError(`Files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB.`, { platform: true });
  const digest = createHash('sha256').update(buffer).digest('hex');
  const target = join(FILES_DIR, digest);
  if (!existsSync(target)) writeFileSync(target, buffer);
  return { sha256: digest, size: buffer.length };
}

function record(study, user, name, { sha256, size }) {
  const others = db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM stimuli WHERE study_id = ? AND name != ?').get(study.id, name).total;
  if (others + size > MAX_STUDY_BYTES) throw new StudyError('This study has reached its 1 GB stimulus limit.', { platform: true });
  const replaced = db.prepare('SELECT 1 FROM stimuli WHERE study_id = ? AND name = ?').get(study.id, name);
  db.prepare('INSERT OR REPLACE INTO stimuli (study_id, name, sha256, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(study.id, name, sha256, size, user.id, now());
  return { name, size, type: MIME[extensionOf(name)], replaced: Boolean(replaced) };
}

/* ---------- Ways in ---------- */

export async function addFromStream(study, user, rawName, stream) {
  const name = checkName(rawName);
  return record(study, user, name, await storeStream(stream));
}

export function addStimulus(user, studyId, { name: rawName, content, encoding }) {
  const study = findStudy(user, studyId, 'edit');
  const name = checkName(rawName);
  const buffer = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
  return record(study, user, name, storeBuffer(buffer));
}

// Only public internet addresses: never the server itself or private networks.
function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224);
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPublicAddress(v6.slice(7));
  return !(v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') ||
    v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff'));
}

// The address check runs at connect time (custom lookup), so DNS can't be switched after the check.
const safeLookup = (hostname, options, callback) => {
  lookup(hostname, { all: true }).then((addresses) => {
    const ok = addresses.find((a) => isPublicAddress(a.address));
    if (!ok || addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(new StudyError(`${hostname} is not a public address.`));
    }
    if (options.all) callback(null, [ok]);
    else callback(null, ok.address, ok.family);
  }, callback);
};

function download(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new StudyError('That is not a valid URL.'));
    }
    if (parsed.protocol !== 'https:') return reject(new StudyError('Only https:// URLs can be imported.'));
    // IP literals skip the DNS lookup below, so check them here.
    const literal = parsed.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !isPublicAddress(literal)) return reject(new StudyError(`${parsed.hostname} is not a public address.`));
    const req = request(parsed, { lookup: safeLookup, timeout: 30_000, headers: { 'user-agent': 'SecondOrder/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (!redirectsLeft) return reject(new StudyError('Too many redirects.'));
        return resolve(download(new URL(res.headers.location, parsed).href, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new StudyError(`Download failed: HTTP ${res.statusCode}.`));
      }
      if (Number(res.headers['content-length']) > MAX_FILE_BYTES) {
        res.destroy();
        return reject(new StudyError(`Files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB.`, { platform: true }));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new StudyError('Download timed out.')));
    req.on('error', (err) => reject(err instanceof StudyError ? err : new StudyError(`Download failed: ${err.message}`)));
    req.end();
  });
}

export async function importFromUrl(user, studyId, { url, name }) {
  const study = findStudy(user, studyId, 'edit');
  const finalName = checkName(name || decodeURIComponent(new URL(url).pathname.split('/').pop() || ''));
  const res = await download(url);
  return record(study, user, finalName, await storeStream(res));
}

/* ---------- Reading and removing ---------- */

export function listStimuli(user, studyId) {
  const study = findStudy(user, studyId);
  const files = db.prepare('SELECT name, size, created_at FROM stimuli WHERE study_id = ? ORDER BY name').all(study.id);
  return {
    files: files.map((f) => ({ name: f.name, type: MIME[extensionOf(f.name)], size_kb: Math.ceil(f.size / 1024), uploaded: iso(f.created_at) })),
    total_mb: Math.round(files.reduce((sum, f) => sum + f.size, 0) / 1024 / 102.4) / 10,
    note: 'The live experiment uses these files (it rebuilds automatically after changes).',
  };
}

export function removeStimulus(user, studyId, { name, names, folder }) {
  const study = findStudy(user, studyId, 'edit');
  const list = [...(name ? [name] : []), ...(names ?? [])].map(String);
  if (!list.length && !folder) throw new StudyError('Give a name, a list of names, or a folder.');
  let removed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const one = db.prepare('DELETE FROM stimuli WHERE study_id = ? AND name = ?');
    for (const n of list) removed += one.run(study.id, n).changes;
    if (folder) {
      const prefix = `${String(folder).replace(/^\/+|\/+$/g, '')}/`;
      removed += db.prepare("DELETE FROM stimuli WHERE study_id = ? AND substr(name, 1, ?) = ?").run(study.id, prefix.length, prefix).changes;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (!removed) throw new StudyError('No matching stimuli in this study.');
  return { removed, remaining: db.prepare('SELECT COUNT(*) AS n FROM stimuli WHERE study_id = ?').get(study.id).n };
}

/** The study's current {name: sha256} files, which the live experiment is built with. */
export function currentManifest(studyId) {
  return Object.fromEntries(db.prepare('SELECT name, sha256 FROM stimuli WHERE study_id = ?').all(studyId).map((r) => [r.name, r.sha256]));
}

/** Public URL path of a stored file on the participant origin. */
export const fileUrl = (name, sha256) => `/f/${sha256}.${extensionOf(name)}`;

/* ---------- Upload links (a page in the browser for dragging files in) ---------- */

export function createUploadLink(user, studyId) {
  const study = findStudy(user, studyId, 'edit');
  const token = newToken();
  db.prepare('INSERT INTO upload_links (token_hash, study_id, user_id, expires_at) VALUES (?, ?, ?, ?)')
    .run(hash(token), study.id, user.id, now() + UPLOAD_LINK_MINUTES * 60 * 1000);
  return {
    url: `${config.origin}/upload/${token}`,
    expires_in_minutes: UPLOAD_LINK_MINUTES,
    note: 'Give this link to the researcher to drag files in. Anyone with the link can upload to this study until it expires.',
  };
}

export function openUploadLink(token) {
  const row = db.prepare(
    `SELECT l.*, s.title, u.id AS uid, u.email, u.name AS uname, u.role FROM upload_links l
     JOIN studies s ON s.id = l.study_id JOIN users u ON u.id = l.user_id
     WHERE l.token_hash = ? AND l.expires_at > ?`
  ).get(hash(String(token)), now());
  if (!row) return null;
  return {
    study: { id: row.study_id, title: row.title },
    user: { id: row.uid, email: row.email, name: row.uname, role: row.role },
    expiresAt: row.expires_at,
  };
}
