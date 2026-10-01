import { useEffect, useState } from 'react';
import { api, passkeyError, signInWithPasskey } from './api.js';
import AuthLayout from './AuthLayout.jsx';

// OAuth consent: Claude or ChatGPT sends the person here to approve the connection.
export default function Connect({ requestId }) {
  const [request, setRequest] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api(`/oauth/requests/${encodeURIComponent(requestId)}`).then(setRequest, (err) => setError(err.message));
  useEffect(() => { load(); }, [requestId]);

  const run = async (fn) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(passkeyError(err));
    }
    setBusy(false);
  };

  const signIn = () => run(async () => {
    await signInWithPasskey();
    await load();
  });

  const decide = (decision) => run(async () => {
    const { redirect } = await api(`/oauth/requests/${encodeURIComponent(requestId)}/${decision}`, { method: 'POST' });
    window.location.replace(redirect);
  });

  if (!request) {
    return (
      <AuthLayout subtitle={error ? null : 'Loading…'}>
        {error && <p className="error-message">{error}</p>}
      </AuthLayout>
    );
  }

  const { client, user } = request;

  if (!user) {
    return (
      <AuthLayout subtitle={`Connect ${client.name}`}>
        <p className="login-note">Sign in to let {client.name} use Second Order on your behalf.</p>
        <div className="social-buttons">
          <button onClick={signIn} disabled={busy} className="social-button primary">
            {busy ? 'Waiting for passkey…' : 'Sign in with passkey'}
          </button>
        </div>
        {error && <p className="error-message">{error}</p>}
      </AuthLayout>
    );
  }

  return (
    <AuthLayout subtitle={`Connect ${client.name}`}>
      <p className="login-note">
        <strong>{client.name}</strong> ({client.redirectHost}) wants to use Second Order as{' '}
        <strong>{user.name}</strong>. It will be able to do anything you can do in Second Order.
      </p>
      <div className="social-buttons">
        <button onClick={() => decide('approve')} disabled={busy} className="social-button primary">Allow</button>
        <button onClick={() => decide('deny')} disabled={busy} className="social-button">Deny</button>
      </div>
      {error && <p className="error-message">{error}</p>}
    </AuthLayout>
  );
}
