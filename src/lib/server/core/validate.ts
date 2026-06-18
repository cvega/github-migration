/**
 * Request-body helpers shared by the API endpoints: JSON parsing and
 * env-dependent auth-availability checks. Request *shape* validation lives
 * in schemas.ts (Zod).
 */

import { json } from "@sveltejs/kit";
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

/** The per-request credential fields a write route's body may carry. */
type AuthCredentials = {
  sourceToken?: unknown;
  sourceApp?: unknown;
  targetToken?: unknown;
  targetApp?: unknown;
};

/**
 * The common preamble for the migrate write routes: parse the JSON body,
 * shape-validate it with the given validator, and confirm both sides have
 * usable auth. Returns the typed body, or a ready 400 `Response` describing the
 * first failure (invalid JSON, a schema error, or missing auth) — so the caller
 * is just `if ("errorResponse" in r) return r.errorResponse;`.
 *
 * The validator is passed in (rather than a Zod schema) so this core helper
 * stays free of any domain-schema import.
 */
export async function parseAuthenticatedBody<T extends AuthCredentials>(
  request: Request,
  validate: (
    data: Record<string, unknown>,
  ) => { ok: true; value: T } | { ok: false; error: string },
): Promise<{ body: T } | { errorResponse: Response }> {
  const parsed = await parseJsonBody(request);
  if ("error" in parsed) {
    return { errorResponse: json({ error: parsed.error }, { status: 400 }) };
  }
  const result = validate(parsed.data);
  if (!result.ok) {
    return { errorResponse: json({ error: result.error }, { status: 400 }) };
  }
  const authError = validateAuthAvailable(result.value);
  if (authError) {
    return { errorResponse: json({ error: authError }, { status: 400 }) };
  }
  return { body: result.value };
}
