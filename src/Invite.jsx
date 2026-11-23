import { useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { api, passkeyError } from './api.js';
import AuthLayout from './AuthLayout.jsx';

export default function Invite({ token }) {
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => {
    api(`/auth/invite/${token}`).then((info) => {
      setInvite(info);
      setName(info.name ?? '');
    }, (err) => setError(err.message));
  }, [token]);

  const askName = invite && (invite.open || invite.needsName);

  const createPasskey = async (e) => {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const optionsJSON = await api(`/auth/invite/${token}/options`, { method: 'POST', body: { name, email } });
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
    <AuthLayout subtitle={invite.open && !invite.name ? 'Welcome' : `Welcome, ${invite.name || name || invite.email}`}>
      <p className="login-note">
        {invite.existingUser
          ? 'Add a passkey on this device to sign in to your account.'
          : invite.open
            ? "You've been invited to Second Order. Enter your name and email, then create a passkey to finish setting up your account."
            : `You've been invited as ${invite.email}. Create a passkey to finish setting up your account.`}
      </p>
      <form className="social-buttons" onSubmit={createPasskey}>
        {askName && (
          <label className="upload-folder">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </label>
        )}
        {invite.open && (
          <label className="upload-folder">
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </label>
        )}
        <button type="submit" disabled={busy} className="social-button primary">
          {busy ? 'Waiting for passkey…' : 'Create passkey'}
        </button>
      </form>
      {error && <p className="error-message">{error}</p>}
    </AuthLayout>
  );
}
