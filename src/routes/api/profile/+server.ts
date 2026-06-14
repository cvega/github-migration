/** POST /api/profile — start an organization profiling run.
 *  GET  /api/profile — list profiling runs (most recent first).
 */
import { json } from "@sveltejs/kit";
import { parseJsonBody } from "$lib/server/core/validate";
import { startOrgProfile } from "$lib/server/profile/service";
import { listProfileRuns } from "$lib/server/profile/store";
import type { RequestHandler } from "./$types";

/** GitHub org login: 1–39 chars, alphanumeric or hyphen, not hyphen-leading. */
const ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const POST: RequestHandler = async ({ request }) => {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return json({ error: parsed.error }, { status: 400 });
  }

  const raw = parsed.data.org;
  const org = typeof raw === "string" ? raw.trim() : "";
  if (!org || !ORG_RE.test(org)) {
    return json({ error: "A valid organization login ('org') is required" }, { status: 400 });
  }

  try {
    const run = startOrgProfile(org);
    return json(run, { status: 201 });
  } catch (err) {
    // A missing source credential is the expected, actionable failure → 400.
    const message = err instanceof Error ? err.message : String(err);
    if (/token|credential|app configured|configured/i.test(message)) {
      return json({ error: "No source credentials configured on the server" }, { status: 400 });
    }
    // Anything else is unexpected: log server-side, return a generic message.
    console.error("[api] POST /api/profile failed:", err);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};

export const GET: RequestHandler = async () => {
  return json({ runs: listProfileRuns() });
};
