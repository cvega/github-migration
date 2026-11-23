/** Public liveness probe; operational details are for the administrative workspace. */
import { json } from "@sveltejs/kit";
import { getAuthConfig } from "$lib/server/core/auth";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  const body: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
  };
  const showConfiguration = !locals.authEnabled || locals.user?.role === "admin";

  if (showConfiguration) {
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
