import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import AuthLayout from './AuthLayout.jsx';

// Drag-and-drop stimulus upload, opened from a link Claude or ChatGPT creates (create_upload_link).
export default function Upload({ token }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [folder, setFolder] = useState('');
  const [queue, setQueue] = useState([]); // { name, status, message }
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);

  const load = () => api(`/uploads/${token}`).then(setInfo, (err) => setError(err.message));
  useEffect(() => { load(); }, [token]);

  const upload = async (files) => {
    const prefix = folder.trim().replace(/^\/+|\/+$/g, '');
    const items = [...files].map((file) => ({ file, name: prefix ? `${prefix}/${file.name}` : file.name }));
    setQueue((q) => [...items.map(({ name }) => ({ name, status: 'waiting' })), ...q]);
    const update = (name, patch) => setQueue((q) => q.map((item) => (item.name === name ? { ...item, ...patch } : item)));

    for (const { file, name } of items) {
      update(name, { status: 'uploading' });
      try {
        const res = await fetch(`/api/uploads/${token}/files?name=${encodeURIComponent(name)}`, { method: 'PUT', body: file });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
        update(name, { status: 'done', message: data.replaced ? 'replaced' : 'added' });
      } catch (err) {
        update(name, { status: 'failed', message: err.message });
      }
    }
    load();
  };

  if (!info) {
    return <AuthLayout subtitle={error ? null : 'Loading…'}>{error && <p className="error-message">{error}</p>}</AuthLayout>;
  }

  return (
    <AuthLayout subtitle="Upload stimuli">
      <p className="login-note">
        Files for <strong>{info.study.title}</strong>. Images, audio, video, CSV, JSON or text, up to {info.maxMb} MB each.
        A file with the same name replaces the old one.
      </p>
      <label className="upload-folder">
        Folder (optional)
        <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="e.g. faces" />
      </label>
      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onClick={() => input.current.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files); }}
      >
        Drop files here or click to choose
        <input ref={input} type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      </div>
      {queue.length > 0 && (
        <ul className="upload-list">
          {queue.map((item) => (
            <li key={item.name} className={`upload-${item.status}`}>
              <span>{item.name}</span>
              <span>{item.status === 'done' ? item.message : item.status === 'failed' ? item.message : `${item.status}…`}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="login-note upload-summary">
        {info.files.length} file{info.files.length === 1 ? '' : 's'} in this study ({info.total_mb} MB). They're available to the
        experiment straight away; tell Claude or ChatGPT when you're done.
      </p>
    </AuthLayout>
  );
}
