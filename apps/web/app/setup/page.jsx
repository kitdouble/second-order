import { userCount } from "@/lib/auth";
import { dbConfigured } from "@/lib/db";
import { setupAction } from "@/app/actions";
import { Flash } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Setup({ searchParams }) {
  const sp = await searchParams;
  if (!dbConfigured()) return <p>Connect the database first (SETUP.md, step 7).</p>;
  if ((await userCount()) > 0) return <p>Setup is done. Sign in with your link.</p>;
  if (!process.env.BOOTSTRAP_TOKEN) {
    return (
      <div className="hero">
        <h1>One more secret</h1>
        <p>
          Create a secret called <code>BOOTSTRAP_TOKEN</code> (SETUP.md, step 9), re-run the deploy, then come back here.
        </p>
      </div>
    );
  }
  return (
    <div className="hero">
      <h1>Set up the lab head</h1>
      <p className="muted">This runs once. You'll be signed in straight away.</p>
      <Flash sp={sp} />
      <form action={setupAction}>
        <label htmlFor="name">Your name</label>
        <input id="name" name="name" required style={{ width: "100%" }} />
        <label htmlFor="code">Setup code (the BOOTSTRAP_TOKEN value)</label>
        <input id="code" name="code" required style={{ width: "100%" }} autoComplete="off" />
        <p>
          <button className="primary" type="submit">
            Create account
          </button>
        </p>
      </form>
    </div>
  );
}
