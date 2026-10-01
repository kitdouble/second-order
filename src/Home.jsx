import { useState } from 'react';
import { api } from './api.js';
import AuthLayout from './AuthLayout.jsx';

// Second Order has no researcher interface: this page only explains how to connect an assistant.
export default function Home({ user }) {
  const mcpUrl = `${window.location.origin}/mcp`;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(mcpUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.replace('/login');
  };

  return (
    <AuthLayout subtitle={`Hi, ${user.name.split(' ')[0]}`}>
      <p className="login-note">
        Second Order is used through Claude or ChatGPT. Add it as a custom connector with this URL, then sign in
        with your passkey when asked.
      </p>
      <div className="social-buttons">
        <code className="connector-url">{mcpUrl}</code>
        <button onClick={copy} className="social-button primary">{copied ? 'Copied' : 'Copy connector URL'}</button>
      </div>
      <ul className="connect-steps">
        <li><strong>Claude:</strong> Settings → Connectors → Add custom connector.</li>
        <li><strong>ChatGPT:</strong> Settings → Apps → Advanced settings → turn on Developer mode, then create an app with this URL.</li>
      </ul>
      <button className="sign-out-button" onClick={signOut}>Sign out</button>
    </AuthLayout>
  );
}
