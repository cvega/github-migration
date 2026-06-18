/** POST /api/profile — start a profiling run for an org or an enterprise.
 *  GET  /api/profile — list profiling runs (most recent first).
 */
import { json } from "@sveltejs/kit";
import { parseJsonBody } from "$lib/server/core/validate";
import { credentialErrorResponse } from "$lib/server/profile/http";
import { startEnterpriseProfile, startOrgProfile } from "$lib/server/profile/service";
import { listProfileRuns } from "$lib/server/profile/store";
import type { RequestHandler } from "./$types";

/** GitHub org login / enterprise slug: 1–39 chars, alphanumeric or hyphen,
 *  not hyphen-leading. */
const SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const POST: RequestHandler = async ({ request }) => {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return json({ error: parsed.error }, { status: 400 });
  }

  // `scope` selects org vs enterprise; default "org" keeps the original
  // `{ org }` body working unchanged.
  const scope = parsed.data.scope === "enterprise" ? "enterprise" : "org";

  try {
    if (scope === "enterprise") {
      const raw = parsed.data.enterprise;
      const slug = typeof raw === "string" ? raw.trim() : "";
      if (!slug || !SLUG_RE.test(slug)) {
        return json(
          { error: "A valid enterprise slug ('enterprise') is required" },
          { status: 400 },
        );
      }
      const run = startEnterpriseProfile(slug);
      return json(run, { status: 201 });
    }

    const raw = parsed.data.org;
    const org = typeof raw === "string" ? raw.trim() : "";
    if (!org || !SLUG_RE.test(org)) {
      return json({ error: "A valid organization login ('org') is required" }, { status: 400 });
    }
    const run = startOrgProfile(org);
    return json(run, { status: 201 });
  } catch (err) {
    return credentialErrorResponse(err, "POST /api/profile");
  }
};

export const GET: RequestHandler = async () => {
  return json({ runs: listProfileRuns() });
};
