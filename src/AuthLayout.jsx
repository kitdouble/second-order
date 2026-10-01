export default function AuthLayout({ subtitle, children }) {
  return (
    <div className="login-container">
      <div className="login-box">
        <img src="/logo.png" alt="" className="login-logo" />
        <h1>Second Order</h1>
        {subtitle && <p className="login-subtitle">{subtitle}</p>}
        {children}
      </div>
      <footer>
        <p>&copy; {new Date().getFullYear()} Kit Double. All Rights Reserved.</p>
      </footer>
    </div>
  );
}
