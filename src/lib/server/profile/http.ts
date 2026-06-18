/** HTTP response helpers shared by the profile crawl routes. */
import { json } from "@sveltejs/kit";

/**
 * Map a thrown service error to a `Response` for the profile crawl routes: a
 * missing source credential is the expected, actionable 400; anything else is
 * logged server-side and returned as a generic 500 so internals don't leak.
 *
 * @param logContext A short route label for the server log, e.g. "POST /api/profile".
 */
export function credentialErrorResponse(err: unknown, logContext: string): Response {
  const message = err instanceof Error ? err.message : String(err);
  if (/token|credential|app configured|configured/i.test(message)) {
    return json({ error: "No source credentials configured on the server" }, { status: 400 });
  }
  console.error(`[api] ${logContext} failed:`, err);
  return json({ error: "Internal server error" }, { status: 500 });
}
