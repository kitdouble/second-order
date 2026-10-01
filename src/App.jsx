import { useEffect, useState } from 'react';
import { api } from './api.js';
import Login from './Login.jsx';
import Invite from './Invite.jsx';
import Connect from './Connect.jsx';
import Home from './Home.jsx';

export default function App() {
  const path = window.location.pathname;
  const inviteToken = path.match(/^\/invite\/([^/]+)$/)?.[1];
  const connectRequest = path === '/connect' ? new URLSearchParams(window.location.search).get('request') : null;
  const [user, setUser] = useState(undefined); // undefined = still checking

  useEffect(() => {
    if (inviteToken || connectRequest) return;
    api('/me').then(({ user }) => setUser(user), () => setUser(null));
  }, [inviteToken, connectRequest]);

  if (inviteToken) return <Invite token={inviteToken} />;
  if (connectRequest) return <Connect requestId={connectRequest} />;
  if (user === undefined) return <div className="loading">Loading</div>;
  if (!user) {
    if (path !== '/login') window.history.replaceState(null, '', '/login');
    return <Login />;
  }
  if (path !== '/') window.history.replaceState(null, '', '/');
  return <Home user={user} />;
}
