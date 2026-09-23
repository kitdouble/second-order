// Always render on request so the page reflects the running deploy.
export const dynamic = "force-dynamic";

export default function Home() {
  const commit = process.env.GIT_COMMIT ?? "local";
  const deployedAt = process.env.DEPLOYED_AT ?? "not deployed";

  return (
    <>
      <h1 style={{ fontSize: 32, marginBottom: 8 }}>Second Order</h1>
      <p style={{ marginTop: 0, color: "#57534e" }}>
        Study platform for the USYD Meta Lab. The platform itself is not built yet;
        this page confirms the deploy pipeline works.
      </p>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Deploy check</h2>
      <ul>
        <li>
          Commit: <code>{commit}</code>
        </li>
        <li>
          Deployed: <code>{deployedAt}</code>
        </li>
        <li>
          App health: <a href="/api/health">/api/health</a>
        </li>
        <li>
          Data ingest health: <a href="/api/ingest/health">/api/ingest/health</a>
        </li>
        <li>
          Participant runtime demo: <a href="/run/demo/">/run/demo/</a>
        </li>
      </ul>
    </>
  );
}
