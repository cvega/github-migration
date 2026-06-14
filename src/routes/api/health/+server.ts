/**
 * GET /api/health — liveness probe.
 *
 * Public (listed in hooks' PUBLIC_PATHS) so the container HEALTHCHECK can reach
 * it without a session cookie. To avoid disclosing the auth posture to anonymous
 * callers, the detailed `auth` block is included only when the request is
 * authenticated — or when basic auth is disabled, in which case the whole app is
 * already open.
 */
import { json } from "@sveltejs/kit";
import { getAuthConfig } from "$lib/server/auth";
import { authEnabled, isValidSession, SESSION_COOKIE } from "$lib/server/session";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ cookies }) => {
  const body: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
  };

  // Expose the auth configuration only to an authenticated operator. When auth
  // is disabled the app is open anyway, so include it then too.
  const sessionCookie = cookies.get(SESSION_COOKIE);
  const authenticated = !authEnabled || (sessionCookie != null && isValidSession(sessionCookie));

  if (authenticated) {
    const auth = getAuthConfig();
    body.auth = {
      source: {
        mode: auth.source.mode,
        rateLimit: auth.source.rateLimit,
        appId: auth.source.appId ?? null,
      },
      target: {
        mode: auth.target.mode,
        rateLimit: auth.target.rateLimit,
        appId: auth.target.appId ?? null,
      },
    };
  }

  return json(body);
};
