import { requireActor } from "@/lib/auth";
import { getLabStandards } from "@/lib/studies";
import { standardsAction, removePasskeyAction } from "@/app/actions";
import { listPasskeys } from "@/lib/passkeys";
import { AddPasskey } from "@/components/passkey";
import { When } from "@/components/ui";
import { Flash } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Settings({ searchParams }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const [text, keys] = await Promise.all([getLabStandards(), listPasskeys(actor.user.id)]);
  const head = actor.user.tier === "lab_head";
  return (
    <>
      <h1>Settings</h1>
      <Flash sp={sp} />
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Passkeys</h2>
        <p className="small muted">
          Sign in with Touch ID, Face ID, Windows Hello or your phone. Passkeys sync through iCloud Keychain or Google Password Manager, so one
          usually covers all your devices. A passkey works only on the address where you made it (2ndorder.live or the web.app address).
        </p>
        {keys.length > 0 && (
          <table>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="small muted">{k.rp_id}</td>
                  <td className="small">
                    added <When at={k.created_at} />
                  </td>
                  <td className="small">last used {k.last_used_at ? <When at={k.last_used_at} /> : "never"}</td>
                  <td>
                    <form action={removePasskeyAction} className="inline">
                      <input type="hidden" name="id" value={k.id} />
                      <button type="submit">Remove</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p>
          <AddPasskey label={keys.length ? "Add another passkey" : "Add a passkey"} />
        </p>
      </div>
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
