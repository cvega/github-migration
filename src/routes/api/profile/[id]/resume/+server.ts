/** POST /api/profile/[id]/resume — resume a paused or failed profile run. */
import { json } from "@sveltejs/kit";
import { credentialErrorResponse } from "$lib/server/profile/http";
import { resumeProfileRun } from "$lib/server/profile/service";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ params }) => {
  try {
    const run = resumeProfileRun(params.id);
    if (!run) {
      return json({ error: "Profile run not found" }, { status: 404 });
    }
    // 202 Accepted: the crawl is re-dispatched in the background; the run is
    // already flipped back to `running` and streams progress over SSE.
    return json(run, { status: 202 });
  } catch (err) {
    return credentialErrorResponse(err, "POST /api/profile/[id]/resume");
  }
};
