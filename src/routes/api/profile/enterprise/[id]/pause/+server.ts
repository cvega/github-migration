/** POST /api/profile/enterprise/[id]/pause — pause a running enterprise profile. */
import { json } from "@sveltejs/kit";
import { requestEnterprisePause } from "$lib/server/profile/service";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ params }) => {
  const run = requestEnterprisePause(params.id);
  if (!run) {
    return json({ error: "Enterprise run not found" }, { status: 404 });
  }
  // 202 Accepted: the pause is cooperative — the fan-out stops and in-flight
  // child crawls pause at their next checkpoints, signalled over SSE.
  return json(run, { status: 202 });
};
