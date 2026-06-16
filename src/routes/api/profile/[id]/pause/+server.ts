/** POST /api/profile/[id]/pause — ask a running profile to pause at a safe point. */
import { json } from "@sveltejs/kit";
import { requestProfilePause } from "$lib/server/profile/service";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ params }) => {
  const run = requestProfilePause(params.id);
  if (!run) {
    return json({ error: "Profile run not found" }, { status: 404 });
  }
  // 202 Accepted: the pause is cooperative — the crawl stops at its next
  // checkpoint and flips to `paused` shortly after, signalled over SSE.
  return json(run, { status: 202 });
};
