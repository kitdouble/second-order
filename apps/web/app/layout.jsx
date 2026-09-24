import "./globals.css";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { dbConfigured } from "@/lib/db";

export const metadata = {
  title: "Second Order",
  description: "Study platform for the USYD Meta Lab",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }) {
  const user = dbConfigured() ? await currentUser().catch(() => null) : null;
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="wrap">
            <Link href="/" className="brand">
              Second Order
            </Link>
            {user && (
              <nav>
                <Link href="/">Studies</Link>
                <Link href="/studies/new">New study</Link>
                <Link href="/connect">Connect Claude</Link>
                {user.tier === "lab_head" && <Link href="/people">People</Link>}
                <Link href="/settings">Settings</Link>
                {user.tier === "lab_head" && <Link href="/audit">Audit</Link>}
              </nav>
            )}
            {user && (
              <span className="who">
                {user.name} · <a href="/logout">Sign out</a>
              </span>
            )}
          </div>
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
