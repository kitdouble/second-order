import { useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { api, passkeyError } from './api.js';
import AuthLayout from './AuthLayout.jsx';

export default function Invite({ token }) {
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/auth/invite/${token}`).then(setInvite, (err) => setError(err.message));
  }, [token]);

  const createPasskey = async () => {
    setError(null);
    setBusy(true);
    try {
      const optionsJSON = await api(`/auth/invite/${token}/options`, { method: 'POST' });
      const response = await startRegistration({ optionsJSON });
      await api(`/auth/invite/${token}/verify`, { method: 'POST', body: response });
      window.location.replace('/');
    } catch (err) {
      setError(passkeyError(err));
      setBusy(false);
    }
  };

  if (!invite) {
    return (
      <AuthLayout subtitle={error ? null : 'Checking your invite…'}>
        {error && (
          <>
            <p className="error-message">{error}</p>
            <a className="text-link" href="/login">Go to sign in</a>
          </>
        )}
      </AuthLayout>
    );
  }

  return (
    <AuthLayout subtitle={`Welcome, ${invite.name}`}>
      <p className="login-note">
        {invite.existingUser
          ? 'Add a passkey on this device to sign in to your account.'
          : `You've been invited as ${invite.email}. Create a passkey to finish setting up your account.`}
      </p>
      <div className="social-buttons">
        <button onClick={createPasskey} disabled={busy} className="social-button primary">
          {busy ? 'Waiting for passkey…' : 'Create passkey'}
        </button>
      </div>
      {error && <p className="error-message">{error}</p>}
    </AuthLayout>
  );
}
