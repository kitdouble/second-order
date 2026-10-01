// The upload page's API (main origin). The upload link's token is the credential: it names one study
// and expires after an hour.
import { Router } from 'express';
import { addFromStream, listStimuli, MAX_FILE_BYTES, openUploadLink } from './stimuli.js';
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
    const study = findStudy(link.user, link.study.id);
    res.json(await addFromStream(study, link.user, req.query.name, req));
  } catch (err) {
    if (err instanceof StudyError) return res.status(400).json({ error: err.message });
    throw err;
  }
});
