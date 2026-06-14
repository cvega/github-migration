/**
 * Request-body helpers shared by the API endpoints: JSON parsing and
 * env-dependent auth-availability checks. Request *shape* validation lives
 * in schemas.ts (Zod).
 */

import { isSourceAuthAvailable, isTargetAuthAvailable } from "./auth";

/**
 * Safely parse a JSON request body. Returns the parsed object or an error string.
 */
export async function parseJsonBody(
  request: Request,
): Promise<{ data: Record<string, unknown> } | { error: string }> {
  try {
    const data = await request.json();
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { error: "Request body must be a JSON object" };
    }
    return { data: data as Record<string, unknown> };
  } catch {
    return { error: "Invalid JSON in request body" };
  }
}

/**
 * Verify that both sides have usable credentials: a per-request token/app, or
 * env-configured auth. Returns an error string for the first missing side, or
 * null when both are satisfied.
 */
export function validateAuthAvailable(creds: {
  sourceToken?: unknown;
  sourceApp?: unknown;
  targetToken?: unknown;
  targetApp?: unknown;
}): string | null {
  if (!creds.sourceToken && !creds.sourceApp && !isSourceAuthAvailable()) {
    return "Missing source auth — provide a PAT, app credentials, or configure auth via env vars";
  }
  if (!creds.targetToken && !creds.targetApp && !isTargetAuthAvailable()) {
    return "Missing target auth — provide a PAT, app credentials, or configure auth via env vars";
  }
  return null;
}
