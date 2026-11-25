import { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

// The signed-in researcher's dashboard: their studies (with links to each study's dashboard), data downloads
// and sharing. Building and changing experiments still happens through Claude or ChatGPT.
export default function Home({ user }) {
  const [studies, setStudies] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all');
  const [open, setOpen] = useState(null); // { id, panel: 'download' | 'share' }

  const load = () => api('/studies').then(({ studies }) => setStudies(studies), (err) => setError(err.message));
  useEffect(() => { load(); }, []);

  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.replace('/login');
  };

  const shown = useMemo(() => {
    if (!studies) return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return studies.filter((s) => {
      if (scope === 'mine' && s.your_role !== 'owner') return false;
      if (scope === 'shared' && s.your_role === 'owner') return false;
      const haystack = `${s.title} ${s.id} ${s.description ?? ''} ${s.owner}`.toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }, [studies, query, scope]);

  const toggle = (id, panel) => setOpen((cur) => (cur?.id === id && cur.panel === panel ? null : { id, panel }));

  return (
    <div className="dash-container">
      <header className="about-header">
        <a href="/" className="about-brand">
          <img src="/logo.png" alt="" />
          Second Order
        </a>
        <div className="dash-user">
          <span>{user.name}</span>
          <button className="sign-out-button" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <main className="dash-main">
        <div className="dash-title">
          <h1>Your studies</h1>
          {studies && <span className="dash-count">{studies.length}</span>}
        </div>

        <div className="dash-toolbar">
          <input
            type="search"
            className="dash-search"
            placeholder="Search by title, id, description or owner"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search studies"
          />
          <div className="dash-scope" role="group" aria-label="Show">
            {[['all', 'All'], ['mine', 'Mine'], ['shared', 'Shared with me']].map(([value, label]) => (
              <button key={value} className={scope === value ? 'active' : ''} onClick={() => setScope(value)}>{label}</button>
            ))}
          </div>
        </div>

        {error && <p className="error-message">{error}</p>}
        {!studies && !error && <p className="dash-empty">Loading studies</p>}
        {studies && !studies.length && (
          <p className="dash-empty">No studies yet. Ask Claude or ChatGPT to create one (see Connect an assistant below).</p>
        )}
        {studies?.length > 0 && !shown.length && <p className="dash-empty">No studies match.</p>}

        <ul className="dash-list">
          {shown.map((s) => (
            <li key={s.id} className="dash-study">
              <div className="dash-study-head">
                <div className="dash-study-info">
                  <h2>{s.title}</h2>
                  <p className="dash-meta">
                    <code>{s.id}</code>
                    <span className={`dash-role role-${s.your_role}`}>{s.your_role}</span>
                    {s.your_role !== 'owner' && <span>by {s.owner}</span>}
                    {s.esm && <span className="dash-tag">ESM</span>}
                    {s.follow_up_of && <span>follow-up of <code>{s.follow_up_of}</code></span>}
                  </p>
                  {s.description && <p className="dash-desc">{s.description}</p>}
                  <p className="dash-stats">
                    <span><strong>{s.participants}</strong> participants</span>
                    <span><strong>{s.completed}</strong> completed</span>
                    <span><strong>{s.open_links}</strong> open link{s.open_links === 1 ? '' : 's'}</span>
                    {s.latest_version && <span>revision {s.latest_version}</span>}
                    <span>{s.updated ? `updated ${when(s.updated)}` : `created ${when(s.created_at)}`}</span>
                    {s.last_participant && <span>last participant {when(s.last_participant)}</span>}
                  </p>
                </div>
                <div className="dash-actions">
                  {s.dashboard_url
                    ? <a className="dash-button primary" href={s.dashboard_url} target="_blank" rel="noopener noreferrer">Dashboard</a>
                    : <span className="dash-button disabled" title="No experiment yet">Dashboard</span>}
                  <button className={`dash-button ${open?.id === s.id && open.panel === 'download' ? 'active' : ''}`} onClick={() => toggle(s.id, 'download')}>Download data</button>
                  <button className={`dash-button ${open?.id === s.id && open.panel === 'share' ? 'active' : ''}`} onClick={() => toggle(s.id, 'share')}>Sharing</button>
                </div>
              </div>
              {open?.id === s.id && open.panel === 'download' && <DownloadPanel study={s} />}
              {open?.id === s.id && open.panel === 'share' && <SharePanel study={s} you={user} />}
            </li>
          ))}
        </ul>

        <ConnectSection defaultOpen={studies?.length === 0} />
      </main>

      <footer className="about-footer">
        <a href="/about">About</a> · &copy; {new Date().getFullYear()} Kit Double. All Rights Reserved.
      </footer>
    </div>
  );
}

function when(isoString) {
  const d = new Date(isoString);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function DownloadPanel({ study }) {
  const [options, setOptions] = useState({ format: 'csv', completed_only: false, include_test: false, exclusions: 'none' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key) => (e) => setOptions((o) => ({ ...o, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const download = async () => {
    setBusy(true);
    setError('');
    try {
      const { url } = await api(`/studies/${encodeURIComponent(study.id)}/download`, { method: 'POST', body: options });
      window.location.assign(url); // served as an attachment, so the page stays
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dash-panel">
      <div className="dash-form">
        <label>
          Format
          <select value={options.format} onChange={set('format')}>
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </label>
        <label>
          Exclusion rules
          <select value={options.exclusions} onChange={set('exclusions')}>
            <option value="none">Ignore</option>
            <option value="mark">Mark excluded sessions</option>
            <option value="drop">Leave excluded sessions out</option>
          </select>
        </label>
        <label className="dash-check">
          <input type="checkbox" checked={options.completed_only} onChange={set('completed_only')} />
          Completed sessions only
        </label>
        <label className="dash-check">
          <input type="checkbox" checked={options.include_test} onChange={set('include_test')} />
          Include test (preview) sessions
        </label>
      </div>
      <div className="dash-panel-foot">
        <span className="dash-hint">One row per trial, every session, no row limit.</span>
        <button className="dash-button primary" onClick={download} disabled={busy}>{busy ? 'Preparing' : `Download ${options.format.toUpperCase()}`}</button>
      </div>
      {error && <p className="error-message">{error}</p>}
    </div>
  );
}

function SharePanel({ study, you }) {
  const [members, setMembers] = useState(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canManage = study.your_role === 'owner';
  const base = `/studies/${encodeURIComponent(study.id)}/members`;

  useEffect(() => {
    api(base).then(({ members }) => setMembers(members), (err) => setError(err.message));
  }, [base]);

  const run = async (path, body) => {
    setBusy(true);
    setError('');
    try {
      const { members } = await api(path, { method: 'POST', body });
      setMembers(members);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e) => {
    e.preventDefault();
    if (await run(base, { email, role })) setEmail('');
  };

  const remove = (m) => {
    if (window.confirm(`Remove ${m.name}'s access to "${study.title}"?`)) run(`${base}/remove`, { email: m.email });
  };

  return (
    <div className="dash-panel">
      {!members && !error && <p className="dash-hint">Loading</p>}
      {members && (
        <ul className="dash-members">
          {members.map((m) => (
            <li key={m.email}>
              <span className="dash-member-name">
                {m.name}{m.email === you.email && ' (you)'}
                <small>{m.email}</small>
              </span>
              {canManage && m.role !== 'owner' ? (
                <span className="dash-member-actions">
                  <select value={m.role} disabled={busy} onChange={(e) => run(base, { email: m.email, role: e.target.value })} aria-label={`Role for ${m.name}`}>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button className="dash-link" disabled={busy} onClick={() => remove(m)}>Remove</button>
                </span>
              ) : (
                <span className={`dash-role role-${m.role}`}>{m.role}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form className="dash-share-form" onSubmit={add}>
          <input type="email" required placeholder="colleague@university.edu" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
          <button className="dash-button primary" disabled={busy}>Share</button>
        </form>
      ) : (
        <p className="dash-hint">Only the owner can change who has access.</p>
      )}
      {canManage && (
        <p className="dash-hint">
          Viewers can see the study, simulate it and download data. Editors can also change the experiment, links and stimuli.
          They need a Second Order account.
        </p>
      )}
      {error && <p className="error-message">{error}</p>}
    </div>
  );
}

function ConnectSection({ defaultOpen }) {
  const mcpUrl = `${window.location.origin}/mcp`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(mcpUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <details className="dash-connect" open={defaultOpen || undefined}>
      <summary>Connect an assistant</summary>
      <p className="login-note">
        Experiments are built and run through Claude or ChatGPT. Add Second Order as a custom connector with this URL,
        then sign in with your passkey when asked.
      </p>
      <div className="dash-connect-row">
        <code className="connector-url">{mcpUrl}</code>
        <button onClick={copy} className="dash-button primary">{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <ul className="connect-steps">
        <li><strong>Claude:</strong> Settings → Connectors → Add custom connector.</li>
        <li><strong>ChatGPT:</strong> Settings → Security and login → turn on Developer mode, then add an app with this URL.</li>
      </ul>
    </details>
  );
}
