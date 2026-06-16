/** POST /api/profile/enterprise/[id]/resume — resume a paused or failed enterprise profile. */
import { json } from "@sveltejs/kit";
import { resumeEnterpriseRun } from "$lib/server/profile/service";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ params }) => {
  try {
    const run = resumeEnterpriseRun(params.id);
    if (!run) {
      return json({ error: "Enterprise run not found" }, { status: 404 });
    }
    // 202 Accepted: the crawl is re-dispatched in the background; the run is
    // already flipped back to `running` and streams progress over SSE.
    return json(run, { status: 202 });
  } catch (err) {
    // A missing source credential is the expected, actionable failure → 400.
    const message = err instanceof Error ? err.message : String(err);
    if (/token|credential|app configured|configured/i.test(message)) {
      return json({ error: "No source credentials configured on the server" }, { status: 400 });
    }
    console.error("[api] POST /api/profile/enterprise/[id]/resume failed:", err);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};
