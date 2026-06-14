/** GET /api/profile/[id] — a profiling run and its per-repo results. */
import { json } from "@sveltejs/kit";
import { getProfileDetail } from "$lib/server/profile/service";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) => {
  const detail = getProfileDetail(params.id);
  if (!detail) {
    return json({ error: "Profile run not found" }, { status: 404 });
  }
  return json(detail);
};
