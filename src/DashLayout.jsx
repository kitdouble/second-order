import { api } from './api.js';

// Header and footer shared by the signed-in pages (studies, admin).
export default function DashLayout({ user, children }) {
  const path = window.location.pathname;
  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.replace('/login');
  };
  return (
    <div className="dash-container">
      <header className="about-header">
        <a href="/" className="about-brand">
          <img src="/logo.png" alt="" />
          <span className="dash-brand-text">Second Order</span>
        </a>
        <nav className="dash-user">
          {user.role === 'admin' && (
            <>
              <a href="/" className={`dash-nav ${path === '/' ? 'current' : ''}`}>Studies</a>
              <a href="/admin" className={`dash-nav ${path === '/admin' ? 'current' : ''}`}>Admin</a>
            </>
          )}
          <span className="dash-user-name">{user.name}</span>
          <button className="sign-out-button" onClick={signOut}>Sign out</button>
        </nav>
      </header>
      <main className="dash-main">{children}</main>
      <footer className="about-footer">
        <a href="/about">About</a> · &copy; {new Date().getFullYear()} Kit Double. All Rights Reserved.
      </footer>
    </div>
  );
}
