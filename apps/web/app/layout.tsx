import type { ReactNode } from "react";

export const metadata = {
  title: "Second Order",
  description: "Study platform for the USYD Meta Lab",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          margin: 0,
          padding: "48px 16px",
          background: "#fafaf9",
          color: "#1c1917",
        }}
      >
        <main style={{ maxWidth: 640, margin: "0 auto" }}>{children}</main>
      </body>
    </html>
  );
}
