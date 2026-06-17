/** GET /api/profile/[id]/repo/[name] — full details for a single repo. */
import { json } from "@sveltejs/kit";
import { getRepoDetail } from "$lib/server/profile/service";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) => {
  const nameWithOwner = decodeURIComponent(params.name);
  const detail = getRepoDetail(params.id, nameWithOwner);
  if (!detail) {
    return json({ error: "Repo not found" }, { status: 404 });
  }
  return json(detail);
};
