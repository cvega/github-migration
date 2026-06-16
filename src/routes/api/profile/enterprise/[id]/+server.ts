/** GET /api/profile/enterprise/[id] — an enterprise run and its child org runs. */
import { json } from "@sveltejs/kit";
import { getEnterpriseDetail } from "$lib/server/profile/service";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) => {
  const detail = getEnterpriseDetail(params.id);
  if (!detail) {
    return json({ error: "Enterprise run not found" }, { status: 404 });
  }
  return json(detail);
};
