import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import AuthLayout from './AuthLayout.jsx';

// Import a study export (.zip), opened from a link Claude or ChatGPT creates (import_study).
export default function Import({ token }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [state, setState] = useState({ status: 'idle' }); // idle | uploading | importing | done | failed
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);

  useEffect(() => { api(`/imports/${token}`).then(setInfo, (err) => setError(err.message)); }, [token]);

  const upload = (file) => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) return setState({ status: 'failed', message: 'Choose the .zip file from a Second Order study export.' });
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/imports/${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && setState({ status: 'uploading', progress: Math.round((e.loaded / e.total) * 100), name: file.name });
    xhr.upload.onload = () => setState({ status: 'importing', name: file.name });
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) setState({ status: 'done', result: data });
      else setState({ status: 'failed', message: data.error || `Import failed (${xhr.status})` });
    };
    xhr.onerror = () => setState({ status: 'failed', message: 'The upload was interrupted. Check your connection and try again.' });
    setState({ status: 'uploading', progress: 0, name: file.name });
    xhr.send(file);
  };

  if (!info) {
    return <AuthLayout subtitle={error ? null : 'Loading…'}>{error && <p className="error-message">{error}</p>}</AuthLayout>;
  }

  const busy = state.status === 'uploading' || state.status === 'importing';
  const result = state.result;
  return (
    <AuthLayout subtitle="Import a study">
      {state.status !== 'done' && (
        <>
          <p className="login-note">
            Drop a study export (.zip, up to {info.maxGb} GB) to make it a new study in your account, with its code, stimuli, saved
            versions and data.
          </p>
          <div
            className={`dropzone${dragging ? ' dragging' : ''}${busy ? ' busy' : ''}`}
            onClick={() => !busy && input.current.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); if (!busy) upload(e.dataTransfer.files[0]); }}
          >
            {state.status === 'uploading' ? `Uploading ${state.name}… ${state.progress}%`
              : state.status === 'importing' ? `Importing ${state.name}…`
                : 'Drop the export here or click to choose'}
            <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={(e) => { upload(e.target.files[0]); e.target.value = ''; }} />
          </div>
        </>
      )}
      {state.status === 'failed' && <p className="error-message">{state.message}</p>}
      {result && (
        <div className="import-result">
          <p className="login-note">
            Imported as <strong>{result.title}</strong> (<code>{result.study_id}</code>): {result.stimuli} stimulus file{result.stimuli === 1 ? '' : 's'},{' '}
            {result.saved_versions} saved version{result.saved_versions === 1 ? '' : 's'}, {result.sessions_imported} session{result.sessions_imported === 1 ? '' : 's'}{' '}
            and {result.trials_imported} trial rows.
          </p>
          {result.changed_since_export && (
            <p className="login-note">Changed since it was exported: {result.changed_since_export.join(', ')}.</p>
          )}
          {result.warnings?.map((w) => <p key={w} className="login-note">{w}</p>)}
          <p className="login-note">Tell Claude or ChatGPT it's done.</p>
        </div>
      )}
    </AuthLayout>
  );
}
