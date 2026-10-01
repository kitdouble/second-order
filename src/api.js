export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// Turn WebAuthn browser errors into something a person can act on.
export function passkeyError(err) {
  if (err?.name === 'NotAllowedError') return 'Passkey request was cancelled or timed out.';
  if (err?.name === 'InvalidStateError') return 'This device already has a passkey for this account.';
  return err?.message || 'Something went wrong.';
}

export async function signInWithPasskey() {
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const optionsJSON = await api('/auth/login/options', { method: 'POST' });
  const response = await startAuthentication({ optionsJSON });
  await api('/auth/login/verify', { method: 'POST', body: response });
}
