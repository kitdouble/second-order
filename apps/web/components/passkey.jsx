"use client";
// Passkey buttons. The browser shows its own Touch ID / Face ID / phone prompt.
import { useState } from "react";
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";

async function post(action, body) {
  const r = await fetch(`/api/passkey/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? "Something went wrong.");
  return data;
}

const cancelled = (e) => e?.name === "NotAllowedError" || e?.name === "AbortError";

export function PasskeySignIn({ next = "/", label = "Sign in with a passkey" }) {
  const [state, setState] = useState({ busy: false, error: null });
  async function go() {
    setState({ busy: true, error: null });
    try {
      if (!browserSupportsWebAuthn()) throw new Error("This browser doesn't support passkeys.");
      const { challengeId, options } = await post("login-options");
      const response = await startAuthentication({ optionsJSON: options });
      await post("login-verify", { challengeId, response });
      window.location.assign(next.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch (e) {
      setState({ busy: false, error: cancelled(e) ? null : e.message });
    }
  }
  return (
    <div>
      <button className="primary" type="button" onClick={go} disabled={state.busy}>
        {state.busy ? "Waiting for your passkey…" : label}
      </button>
      {state.error && <div className="flash err" style={{ marginTop: 10 }}>{state.error}</div>}
    </div>
  );
}

export function AddPasskey({ label = "Add a passkey" }) {
  const [state, setState] = useState({ busy: false, error: null });
  async function go() {
    setState({ busy: true, error: null });
    try {
      if (!browserSupportsWebAuthn()) throw new Error("This browser doesn't support passkeys.");
      const { challengeId, options } = await post("register-options");
      const response = await startRegistration({ optionsJSON: options });
      await post("register-verify", { challengeId, response });
      window.location.assign(`${window.location.pathname}?msg=${encodeURIComponent("Passkey added. Next time, sign in with it: no link needed.")}`);
    } catch (e) {
      const msg = e?.name === "InvalidStateError" ? "This device already has a passkey for Second Order." : cancelled(e) ? null : e.message;
      setState({ busy: false, error: msg });
    }
  }
  return (
    <span>
      <button className="primary" type="button" onClick={go} disabled={state.busy}>
        {state.busy ? "Waiting for your device…" : label}
      </button>
      {state.error && <div className="flash err" style={{ marginTop: 10 }}>{state.error}</div>}
    </span>
  );
}
