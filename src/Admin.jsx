import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import DashLayout from './DashLayout.jsx';

// Admins only (the API checks too): users and their storage, invites, feedback and self-service ESM studies.
const TABS = [['users', 'Users'], ['invites', 'Invites'], ['feedback', 'Feedback'], ['esm', 'Self-service ESM']];

function bytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'never');

export default function Admin({ user }) {
  const [tab, setTab] = useState(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return TABS.some(([k]) => k === t) ? t : 'users';
  });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = () => api('/admin/overview').then(setData, (err) => setError(err.message));
  useEffect(() => { load(); }, []);

  const pick = (key) => {
    setTab(key);
    window.history.replaceState(null, '', key === 'users' ? '/admin' : `/admin?tab=${key}`);
  };

  const t = data?.totals;
  return (
    <DashLayout user={user}>
      <div className="dash-title">
        <h1>Admin</h1>
      </div>
      {error && <p className="error-message">{error}</p>}

      {data && (
        <div className="admin-tiles">
          <Tile label="Users" value={t.users} note={`${t.admins} admin${t.admins === 1 ? '' : 's'}`} />
          <Tile label="Studies" value={t.studies} note={t.self_service_studies ? `${t.self_service_studies} self-service` : null} />
          <Tile label="Participants" value={t.participants.toLocaleString()} note={`${bytes(t.data_bytes)} of data`} />
          <Tile label="Storage used" value={bytes(data.server.total_bytes)} note={`database ${bytes(data.server.database_bytes)}, files ${bytes(data.server.files_bytes)}`} />
          <Tile label="Open feedback" value={t.open_feedback} />
        </div>
      )}

      <div className="dash-scope admin-tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => pick(key)}>{label}</button>
        ))}
      </div>

      {!data && !error && <p className="dash-empty">Loading</p>}
      {data && tab === 'users' && <Users data={data} you={user} reload={load} />}
      {data && tab === 'invites' && <Invites invites={data.invites} reload={load} />}
      {tab === 'feedback' && <Feedback onChange={load} />}
      {tab === 'esm' && <SelfService />}
    </DashLayout>
  );
}

function Tile({ label, value, note }) {
  return (
    <div className="admin-tile">
      <span className="admin-tile-label">{label}</span>
      <span className="admin-tile-value">{value}</span>
      {note && <span className="admin-tile-note">{note}</span>}
    </div>
  );
}

/* ---------- Users ---------- */

const SORTS = {
  storage: (a, b) => b.storage.total_bytes - a.storage.total_bytes,
  name: (a, b) => a.name.localeCompare(b.name),
  joined: (a, b) => b.joined.localeCompare(a.joined),
  active: (a, b) => (b.last_sign_in ?? '').localeCompare(a.last_sign_in ?? ''),
};

function Users({ data, you, reload }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('storage');
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const max = Math.max(1, ...data.users.map((u) => u.storage.total_bytes));

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return data.users
      .filter((u) => words.every((w) => `${u.name} ${u.email}`.toLowerCase().includes(w)))
      .sort(SORTS[sort]);
  }, [data.users, query, sort]);

  const act = async (path, body, done) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api(path, { method: 'POST', body });
      if (done) setMessage(done(result));
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const setFlag = (u, field, value) => {
    if (field === 'admin' && !window.confirm(value ? `Make ${u.name} an admin? They will see every study and all of this page.` : `Remove ${u.name}'s admin access?`)) return;
    act(`/admin/users/${u.id}`, { [field]: value });
  };

  const signOut = (u) => {
    if (!window.confirm(`Sign ${u.name} out everywhere? Their browser sessions end and Claude or ChatGPT will ask them to sign in again.`)) return;
    act(`/admin/users/${u.id}/sign-out`, {}, (r) => `Signed ${u.name} out (${r.sessions} browser session${r.sessions === 1 ? '' : 's'}, ${r.tokens} connector token${r.tokens === 1 ? '' : 's'}).`);
  };

  const newPasskey = (u) => act('/admin/invites', { email: u.email, name: u.name },
    (r) => <>Passkey link for {u.name} (new device or recovery), valid {r.expires_in_days} days: <CopyText text={r.url} /></>);

  return (
    <section className="admin-section">
      <div className="dash-toolbar">
        <input type="search" className="dash-search" placeholder="Search users by name or email" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search users" />
        <label className="admin-sort">
          Sort by
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="storage">Storage</option>
            <option value="name">Name</option>
            <option value="joined">Newest</option>
            <option value="active">Last sign-in</option>
          </select>
        </label>
      </div>
      {message && <p className="admin-message">{message}</p>}
      {error && <p className="error-message">{error}</p>}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>User</th>
              <th className="wide">Access</th>
              <th className="num wide">Studies</th>
              <th className="num wide">Participants</th>
              <th>Storage</th>
              <th className="wide">Last sign-in</th>
              <th aria-label="Details" />
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <Fragment key={u.id}>
                <tr className={expanded === u.id ? 'open' : ''}>
                  <td>
                    <span className="admin-name">{u.name}{u.id === you.id && ' (you)'}</span>
                    <small>{u.email}</small>
                  </td>
                  <td className="wide">
                    <span className="admin-badges">
                      {u.admin && <span className="dash-role role-owner">admin</span>}
                      <span className="dash-role">{u.lab_member ? 'lab' : 'outside'}</span>
                    </span>
                  </td>
                  <td className="num wide">{u.studies.length}</td>
                  <td className="num wide">{u.participants.toLocaleString()}</td>
                  <td className="admin-storage">
                    <span>{bytes(u.storage.total_bytes)}</span>
                    <span className="admin-bar" aria-hidden="true">
                      <span className="bar-data" style={{ width: `${(u.storage.data_bytes / max) * 100}%` }} />
                      <span className="bar-files" style={{ width: `${(u.storage.file_bytes / max) * 100}%` }} />
                      <span className="bar-code" style={{ width: `${(u.storage.code_bytes / max) * 100}%` }} />
                    </span>
                  </td>
                  <td className="wide">{day(u.last_sign_in)}</td>
                  <td>
                    <button className="dash-link" onClick={() => setExpanded(expanded === u.id ? null : u.id)} aria-expanded={expanded === u.id}>
                      {expanded === u.id ? 'Close' : 'Manage'}
                    </button>
                  </td>
                </tr>
                {expanded === u.id && (
                  <tr className="admin-detail">
                    <td colSpan={7}>
                      <UserDetail u={u} you={you} busy={busy} setFlag={setFlag} signOut={signOut} newPasskey={newPasskey} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dash-hint admin-legend">
        <span><i className="bar-data" /> participant data</span>
        <span><i className="bar-files" /> stimulus files</span>
        <span><i className="bar-code" /> experiment code and builds</span>
        Storage is counted against each study's owner. Stimulus files are stored once, so a file several studies use is counted once per user.
      </p>
    </section>
  );
}

function UserDetail({ u, you, busy, setFlag, signOut, newPasskey }) {
  return (
    <div className="admin-detail-body">
      <div className="admin-facts">
        <span>Joined {day(u.joined)}</span>
        <span>Last sign-in {day(u.last_sign_in)}</span>
        <span>{u.studies.length} stud{u.studies.length === 1 ? 'y' : 'ies'}, {u.participants.toLocaleString()} participants</span>
        <span>{u.passkeys} passkey{u.passkeys === 1 ? '' : 's'}</span>
        <span>Member of {u.shared_with} shared stud{u.shared_with === 1 ? 'y' : 'ies'}</span>
        <span>Data {bytes(u.storage.data_bytes)}</span>
        <span>Files {bytes(u.storage.file_bytes)} ({u.storage.files})</span>
        <span>Code {bytes(u.storage.code_bytes)}</span>
      </div>

      <div className="admin-controls">
        <label className="dash-check">
          <input type="checkbox" checked={u.lab_member} disabled={busy} onChange={(e) => setFlag(u, 'lab_member', e.target.checked)} />
          Lab member (can use Prolific and the lab's default protocol)
        </label>
        <label className="dash-check">
          <input type="checkbox" checked={u.admin} disabled={busy || u.id === you.id} onChange={(e) => setFlag(u, 'admin', e.target.checked)} />
          Admin{u.id === you.id && ' (you can\'t remove your own)'}
        </label>
        <div className="admin-buttons">
          <button className="dash-button" disabled={busy} onClick={() => newPasskey(u)}>New passkey link</button>
          <button className="dash-button" disabled={busy} onClick={() => signOut(u)}>Sign out everywhere</button>
        </div>
      </div>

      {u.studies.length > 0 ? (
        <table className="admin-subtable">
          <thead>
            <tr><th>Study</th><th className="num wide">Participants</th><th className="num">Data</th><th className="num">Files</th><th className="num wide">Code</th></tr>
          </thead>
          <tbody>
            {u.studies.map((s) => (
              <tr key={s.id}>
                <td>{s.title}<small><code>{s.id}</code> · {day(s.created)}</small></td>
                <td className="num wide">{s.participants.toLocaleString()}</td>
                <td className="num">{bytes(s.data_bytes)}</td>
                <td className="num">{bytes(s.file_bytes)}</td>
                <td className="num wide">{bytes(s.code_bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="dash-hint">No studies of their own.</p>
      )}
    </div>
  );
}

function CopyText({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="admin-copy">
      <code>{text}</code>
      <button className="dash-link" onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}>{copied ? 'Copied' : 'Copy'}</button>
    </span>
  );
}

/* ---------- Invites ---------- */

function Invites({ invites, reload }) {
  const [form, setForm] = useState({ name: '', email: '', admin: false, lab_member: true });
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const run = async (path, body) => {
    setBusy(true);
    setError('');
    try {
      const result = await api(path, { method: 'POST', body });
      await reload();
      return result;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const create = async (e) => {
    e.preventDefault();
    if (form.admin && !window.confirm('This invite makes the person an admin. Continue?')) return;
    const result = await run('/admin/invites', form);
    if (result) {
      setCreated(result);
      setForm({ name: '', email: '', admin: false, lab_member: true });
    }
  };

  const revoke = (i) => {
    if (window.confirm(`Revoke the invite${i.email ? ` for ${i.email}` : ''}? The link stops working.`)) run('/admin/invites/revoke', { id: i.id });
  };

  return (
    <section className="admin-section">
      <form className="dash-panel" onSubmit={create}>
        <h2 className="admin-h2">New invite link</h2>
        <p className="dash-hint">
          Single use. Leave name and email empty and the person enters their own when they set up a passkey. An email that already has an
          account adds a passkey for a new device instead. Nothing is emailed: send the link yourself.
        </p>
        <div className="dash-form">
          <label>Name (optional)<input value={form.name} onChange={set('name')} /></label>
          <label>Email (optional)<input type="email" value={form.email} onChange={set('email')} /></label>
          <label className="dash-check"><input type="checkbox" checked={form.lab_member} onChange={set('lab_member')} />Lab member</label>
          <label className="dash-check"><input type="checkbox" checked={form.admin} onChange={set('admin')} />Admin</label>
        </div>
        <div className="dash-panel-foot">
          <span />
          <button className="dash-button primary" disabled={busy}>Create invite</button>
        </div>
        {created && <p className="admin-message">Valid {created.expires_in_days} days: <CopyText text={created.url} /></p>}
        {error && <p className="error-message">{error}</p>}
      </form>

      <h2 className="admin-h2">Pending invites</h2>
      {invites.length ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>For</th><th className="wide">Access</th><th className="wide">Created</th><th>Expires</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {invites.map((i) => (
                <tr key={i.id}>
                  <td><span className="admin-name">{i.name || 'Anyone with the link'}</span>{i.email && <small>{i.email}</small>}</td>
                  <td className="wide"><span className="admin-badges">{i.admin && <span className="dash-role role-owner">admin</span>}<span className="dash-role">{i.lab_member ? 'lab' : 'outside'}</span></span></td>
                  <td className="wide">{day(i.created)}{i.created_by && <small>by {i.created_by}</small>}</td>
                  <td>{day(i.expires)}</td>
                  <td><button className="dash-link" disabled={busy} onClick={() => revoke(i)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="dash-hint">No unused invites. (Links can't be shown again after they are made; revoke and make a new one if one is lost.)</p>
      )}
    </section>
  );
}

/* ---------- Feedback ---------- */

function Feedback({ onChange }) {
  const [status, setStatus] = useState('open');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api(`/admin/feedback?status=${status}`).then(setData, (err) => setError(err.message));
  useEffect(() => { setData(null); load(); }, [status]);

  const close = async (note, newStatus) => {
    const resolution = newStatus === 'open' ? undefined : window.prompt(newStatus === 'resolved' ? 'What was done? (optional)' : 'Why not? (optional)');
    if (resolution === null) return;
    setBusy(true);
    setError('');
    try {
      await api('/admin/feedback', { method: 'POST', body: { ids: [note.id], status: newStatus, ...(resolution && { resolution }) } });
      await Promise.all([load(), onChange()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const counts = data?.counts ?? {};
  return (
    <section className="admin-section">
      <div className="dash-scope admin-tabs" role="group" aria-label="Status">
        {[['open', 'Open'], ['resolved', 'Resolved'], ['wontfix', 'Won\'t fix'], ['all', 'All']].map(([key, label]) => (
          <button key={key} className={status === key ? 'active' : ''} onClick={() => setStatus(key)}>
            {label}{key !== 'all' && counts[key] ? ` (${counts[key]})` : ''}
          </button>
        ))}
      </div>
      {error && <p className="error-message">{error}</p>}
      {!data && !error && <p className="dash-empty">Loading</p>}
      {data && !data.notes.length && <p className="dash-empty">Nothing here.</p>}
      <ul className="admin-notes">
        {data?.notes.map((n) => (
          <li key={n.id}>
            <div className="dash-meta">
              <span className="dash-tag">{n.kind}</span>
              {n.status !== 'open' && <span className="dash-role">{n.status}</span>}
              <span>{n.created} UTC</span>
              <span>from {n.from_user}{n.client && ` via ${n.client}`}</span>
              {n.tool && <code>{n.tool}</code>}
              {n.study_id && <span>study <code>{n.study_id}</code></span>}
              <code>{n.id}</code>
            </div>
            <p className="admin-note-summary">{n.summary}</p>
            {n.details && <p className="admin-note-details">{n.details}</p>}
            {n.reply_to && <p className="dash-hint">Reply to: {n.reply_to}</p>}
            {n.resolution && <p className="dash-hint">Resolution: {n.resolution}</p>}
            <div className="admin-buttons">
              {n.status === 'open' ? (
                <>
                  <button className="dash-button" disabled={busy} onClick={() => close(n, 'resolved')}>Resolved</button>
                  <button className="dash-button" disabled={busy} onClick={() => close(n, 'wontfix')}>Won't fix</button>
                </>
              ) : (
                <button className="dash-button" disabled={busy} onClick={() => close(n, 'open')}>Reopen</button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------- Self-service ESM ---------- */

function SelfService() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [links, setLinks] = useState({});

  useEffect(() => { api('/admin/self-service').then(setData, (err) => setError(err.message)); }, []);

  const reissue = async (s) => {
    if (!window.confirm(`Make a new owner link for "${s.app_title}"? The old link stops working. Check the request came from ${s.contact.email}.`)) return;
    try {
      const r = await api(`/admin/self-service/${encodeURIComponent(s.study_id)}/owner-link`, { method: 'POST', body: {} });
      setLinks((l) => ({ ...l, [s.study_id]: r.owner_url }));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="admin-section">
      {error && <p className="error-message">{error}</p>}
      {!data && !error && <p className="dash-empty">Loading</p>}
      {data && (
        <>
          <p className="dash-hint">Sign-up: {data.signup}. Studies: {data.limits.studies}. Up to {data.limits.codes_per_study} codes per study. Change the sign-up key through the assistant (set_esm_signup_key).</p>
          {!data.studies.length && <p className="dash-empty">No self-service studies.</p>}
          {data.studies.length > 0 && (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead><tr><th>Study</th><th className="wide">Contact</th><th className="num wide">Codes</th><th className="num wide">Enrolled</th><th className="num">Sessions</th><th>Last activity</th><th aria-label="Actions" /></tr></thead>
                <tbody>
                  {data.studies.map((s) => (
                    <Fragment key={s.study_id}>
                      <tr>
                        <td><span className="admin-name">{s.app_title}</span><small><code>{s.study_id}</code>{s.closed && ' · closed'}</small></td>
                        <td className="wide">{s.contact.name}<small>{s.contact.email}{s.contact.institution && `, ${s.contact.institution}`}</small></td>
                        <td className="num wide">{s.codes_issued}</td>
                        <td className="num wide">{s.enrolled}</td>
                        <td className="num">{s.sessions_completed}</td>
                        <td>{day(s.last_activity)}<small>deleted after {day(s.deleted_after)}</small></td>
                        <td><button className="dash-link" onClick={() => reissue(s)}>New owner link</button></td>
                      </tr>
                      {links[s.study_id] && (
                        <tr className="admin-detail"><td colSpan={7}><p className="admin-message">Send only to {s.contact.email}; it can't be shown again: <CopyText text={links[s.study_id]} /></p></td></tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
