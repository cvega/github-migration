/** POST /api/profile/enterprise/[id]/resume — resume a paused or failed enterprise profile. */
import { json } from "@sveltejs/kit";
import { credentialErrorResponse } from "$lib/server/profile/http";
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
    return credentialErrorResponse(err, "POST /api/profile/enterprise/[id]/resume");
  }
};
