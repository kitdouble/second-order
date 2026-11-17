// The upload page's API (main origin), also used directly by assistants with create_upload_url. The token is
// the credential: it names one study and expires after an hour.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from 'express';
import { extract } from './exports.js';
import { addFromDir, addFromStream, listStimuli, MAX_FILE_BYTES, openUploadLink } from './stimuli.js';
import { findStudy, StudyError } from './studies.js';

export const uploads = Router();

const expired = (res) => res.status(404).json({ error: 'This upload link has expired. Ask Claude or ChatGPT for a new one.' });

uploads.get('/:token', (req, res) => {
  const link = openUploadLink(req.params.token);
  if (!link) return expired(res);
  res.json({ study: link.study, expiresAt: link.expiresAt, maxMb: MAX_FILE_BYTES / 1024 / 1024, ...listStimuli(link.user, link.study.id) });
});

// PUT /api/uploads/:token/files?name=faces/f1.png with the raw file as the body.
uploads.put('/:token/files', async (req, res) => {
  const link = openUploadLink(req.params.token);
  if (!link) return expired(res);
  try {
    const study = findStudy(link.user, link.study.id, 'edit');
    res.json(await addFromStream(study, link.user, req.query.name, req));
  } catch (err) {
    if (err instanceof StudyError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// PUT /api/uploads/:token/zip?prefix=sounds with a zip as the body: every file in it becomes a stimulus.
uploads.put('/:token/zip', async (req, res) => {
  const link = openUploadLink(req.params.token);
  if (!link) return expired(res);
  const dir = mkdtempSync(join(tmpdir(), 'so-stimuli-'));
  try {
    const study = findStudy(link.user, link.study.id, 'edit');
    const paths = await extract(req, dir);
    res.json(await addFromDir(study, link.user, dir, paths, req.query.prefix));
  } catch (err) {
    if (err instanceof StudyError) return res.status(400).json({ error: err.message });
    throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
