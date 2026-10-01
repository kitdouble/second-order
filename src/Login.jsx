import { useState } from 'react';
import { passkeyError, signInWithPasskey } from './api.js';
import AuthLayout from './AuthLayout.jsx';

export default function Login() {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setError(null);
    setBusy(true);
    try {
      await signInWithPasskey();
      window.location.replace('/');
    } catch (err) {
      setError(passkeyError(err));
      setBusy(false);
    }
  };

  return (
    <AuthLayout subtitle="Sign in to continue">
      <div className="social-buttons">
        <button onClick={signIn} disabled={busy} className="social-button primary">
          {busy ? 'Waiting for passkey…' : 'Sign in with passkey'}
        </button>
        <span className="beta-subtitle">INVITE ONLY</span>
      </div>
      {error && <p className="error-message">{error}</p>}
    </AuthLayout>
  );
}
