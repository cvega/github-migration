/**
 * Zod schemas for API request bodies — the single source of truth for what a
 * valid migration/batch/restart request looks like at runtime. Replaces the
 * hand-rolled `narrowBody`/`validateCommonFields`/inline checks so the runtime
 * shape and the inferred type can never drift.
 *
 * Server-only (lives under $lib/server) so Zod never reaches the client bundle.
 * Credential/auth *availability* (env-dependent) stays in validate.ts — schemas
 * validate shape, not whether env auth exists.
 */
import { z } from "zod";

/** Maximum accepted length for any single string field in a request body. */
const MAX_FIELD_LEN = 255;

const boundedString = () =>
  z.string().max(MAX_FIELD_LEN, `must be at most ${MAX_FIELD_LEN} characters`);

const appAuthSchema = z.object({
  appId: z.string().min(1, "is required"),
  privateKey: z.string().min(1, "is required"),
  installationId: z.string().min(1, "is required"),
});

/** Credential + per-migration option fields shared by every request (MigrationOptions). */
const optionFields = {
  sourceToken: boundedString().optional(),
  targetToken: boundedString().optional(),
  sourceApp: appAuthSchema.optional(),
  targetApp: appAuthSchema.optional(),
  noSslVerify: z.boolean().optional(),
  skipReleases: z.boolean().optional(),
  lockSource: z.boolean().optional(),
  archiveSource: z.boolean().optional(),
  targetRepoVisibility: z.enum(["private", "public", "internal"]).optional(),
  directPassthrough: z.boolean().optional(),
};

/** Restart request — just credentials + options (repo identity comes from the DB row). */
export const restartSchema = z.object(optionFields);

/** Single migration request. */
export const createMigrationSchema = z.object({
  ...optionFields,
  sourceApiUrl: boundedString().optional(),
  sourceRepo: boundedString()
    .min(1, "sourceRepo is required")
    .refine((v) => v.includes("/"), 'sourceRepo must be in "org/repo" format'),
  targetOrg: boundedString().min(1, "targetOrg is required"),
  targetRepo: boundedString().optional(),
  gitArchivePath: boundedString().optional(),
  metadataArchivePath: boundedString().optional(),
});

/** Maximum repositories accepted in a single batch. */
const MAX_BATCH_REPOS = 500;

/** Batch migration request. */
export const batchMigrationSchema = z.object({
  ...optionFields,
  sourceApiUrl: boundedString().optional(),
  repos: z
    .array(
      boundedString().refine(
        (v) => !v.trim() || v.trim().includes("/"),
        "repos entries must be in org/repo format",
      ),
    )
    .min(1, "repos must contain at least one org/repo entry")
    .max(MAX_BATCH_REPOS, `repos exceeds the maximum of ${MAX_BATCH_REPOS}`),
  targetOrg: boundedString().min(1, "targetOrg is required"),
});

/** Render a ZodError as a single, field-qualified message (path: reason). */
function firstError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request body";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Validate a request body against a schema. Returns the parsed (typed, unknown
 * keys stripped) value, or a single field-qualified error string for a 400.
 */
export function validateBody<S extends z.ZodType>(
  schema: S,
  data: unknown,
): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: firstError(result.error) };
}
