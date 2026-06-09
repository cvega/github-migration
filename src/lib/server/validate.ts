/**
 * Runtime validation helpers for migration request bodies.
 *
 * TypeScript `as` casts are compile-time only — these functions
 * provide actual runtime checks so malformed payloads are rejected
 * with a clean 400 instead of causing downstream errors.
 */

import { isSourceAuthAvailable, isTargetAuthAvailable } from "$lib/server/auth";

const VALID_VISIBILITIES = ["private", "public", "internal"] as const;

/** Maximum accepted length for any single string field in a request body. */
export const MAX_FIELD_LEN = 255;

/** Check if a value is undefined, null, or an empty/whitespace-only string. */
function isBlank(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  );
}

const BOOLEAN_FIELDS = [
  "noSslVerify",
  "skipReleases",
  "lockSource",
  "archiveSource",
  "directPassthrough",
] as const;

/**
 * Validate fields common to both single and batch migration requests.
 * Returns an error string if validation fails, or null if valid.
 */
export function validateCommonFields(body: Record<string, unknown>): string | null {
  // ── Boolean fields must actually be booleans (or absent) ──────────────
  for (const field of BOOLEAN_FIELDS) {
    if (field in body && body[field] !== undefined && typeof body[field] !== "boolean") {
      return `Field "${field}" must be a boolean, got ${typeof body[field]}`;
    }
  }

  // ── targetRepoVisibility must be one of the allowed values ────────────
  if (body.targetRepoVisibility !== undefined && body.targetRepoVisibility !== null) {
    if (
      typeof body.targetRepoVisibility !== "string" ||
      !(VALID_VISIBILITIES as readonly string[]).includes(body.targetRepoVisibility)
    ) {
      return `Field "targetRepoVisibility" must be one of: ${VALID_VISIBILITIES.join(", ")}`;
    }
  }

  // ── AppAuth sub-objects ───────────────────────────────────────────────
  const appAuthError = validateAppAuth(body.sourceApp, "sourceApp");
  if (appAuthError) return appAuthError;

  const targetAppError = validateAppAuth(body.targetApp, "targetApp");
  if (targetAppError) return targetAppError;

  return null;
}

/**
 * Validate a GitHub App auth sub-object.
 */
function validateAppAuth(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;

  if (typeof value !== "object" || Array.isArray(value)) {
    return `Field "${fieldName}" must be an object with appId, privateKey, and installationId`;
  }

  const app = value as Record<string, unknown>;
  const required = ["appId", "privateKey", "installationId"] as const;

  for (const key of required) {
    if (!(key in app) || isBlank(app[key])) {
      return `Field "${fieldName}.${key}" is required`;
    }
    if (typeof app[key] !== "string") {
      return `Field "${fieldName}.${key}" must be a string, got ${typeof app[key]}`;
    }
  }

  return null;
}

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
 * Narrow a validated JSON body to a specific request type.
 *
 * Centralises the single `as T` assertion so API endpoints don't need
 * the `as unknown as T` double-cast.  The caller is responsible for
 * calling `validateCommonFields` first to verify structural correctness.
 */
export function narrowBody<T>(data: Record<string, unknown>): T {
  return data as T;
}

/**
 * Reject any provided string field longer than {@link MAX_FIELD_LEN}.
 * `fields` is a list of `[name, value]` pairs; non-string values are skipped.
 * Returns an error string, or null when all are within the limit.
 */
export function validateFieldLengths(fields: ReadonlyArray<[string, unknown]>): string | null {
  for (const [name, val] of fields) {
    if (typeof val === "string" && val.length > MAX_FIELD_LEN) {
      return `Field "${name}" exceeds maximum length of ${MAX_FIELD_LEN} characters`;
    }
  }
  return null;
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
