import { requireActor } from "@/lib/auth";
import { EXAMPLE_DOTS_YAML } from "@so/core";
import { saveSpecAction } from "@/app/actions";
import { Flash } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NewStudy({ searchParams }) {
  await requireActor();
  const sp = await searchParams;
  return (
    <>
      <h1>New study</h1>
      <p className="muted">
        Paste or edit a spec. The example below is a complete study; change <code>study.slug</code> and <code>study.title</code> first. Usually
        it's quicker to ask Claude to draft this through the connector.
      </p>
      <Flash sp={sp} />
      <form action={saveSpecAction}>
        <textarea className="code" name="yaml" defaultValue={EXAMPLE_DOTS_YAML} spellCheck={false} />
        <label htmlFor="message">What is this study? (optional)</label>
        <input id="message" name="message" style={{ width: "100%" }} />
        <p>
          <button className="primary" type="submit">
            Create study
          </button>
        </p>
      </form>
    </>
  );
}
