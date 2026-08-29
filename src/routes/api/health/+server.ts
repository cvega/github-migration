/** Public liveness probe with auth details limited to authenticated operators. */
import { json } from "@sveltejs/kit";
import { getAuthConfig } from "$lib/server/core/auth";
import { authEnabled, isValidSession, SESSION_COOKIE } from "$lib/server/core/session";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ cookies }) => {
  const body: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
  };
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
