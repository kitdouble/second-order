import { requireActor } from "@/lib/auth";
import { getLabStandards } from "@/lib/studies";
import { standardsAction } from "@/app/actions";
import { Flash } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Settings({ searchParams }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const text = await getLabStandards();
  const head = actor.user.tier === "lab_head";
  return (
    <>
      <h1>Settings</h1>
      <Flash sp={sp} />
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Lab standards</h2>
        <p className="small muted">
          The design critic and AI reviewer apply these, so their judgement reflects the lab's rather than generic advice. Also a useful document for new
          students. Examples: preferred confidence scales, standard exclusions, measures always reported alongside M-ratio.
        </p>
        <form action={standardsAction}>
          <textarea name="text" rows={14} defaultValue={text} readOnly={!head} />
          {head && (
            <p>
              <button className="primary" type="submit">
                Save
              </button>
            </p>
          )}
        </form>
      </div>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Connections</h2>
        <p>
          Prolific: {process.env.PROLIFIC_TOKEN ? <span className="badge ok">connected</span> : <span className="badge">not connected</span>}{" "}
          <span className="small muted">(PROLIFIC_TOKEN secret; see SETUP.md)</span>
        </p>
      </div>
    </>
  );
}
