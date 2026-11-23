import { z } from "zod";
import { assertMigrationSourceApiUrl } from "$lib/server/core/source-url";
import { getSourceProviderAdapter, SOURCE_PROVIDERS } from "$lib/source-provider";

const MAX_FIELD_LENGTH = 255;

const boundedString = () =>
  z.string().max(MAX_FIELD_LENGTH, `must be at most ${MAX_FIELD_LENGTH} characters`);

const positiveDecimalId = boundedString().regex(/^[1-9]\d*$/, "must be a positive integer");
const targetProfileId = boundedString().regex(
  /^[a-z0-9](?:[a-z0-9-]{0,62})$/,
  "must be a lowercase target profile ID",
);

const appAuthSchema = z.object({
  appId: positiveDecimalId,
  privateKey: z.string().min(1, "is required").max(16_384, "must be at most 16384 characters"),
  installationId: positiveDecimalId,
});

const repository = boundedString().regex(
  /^[^/\s]+(?:\/[^/\s]+)+$/,
  'must contain a namespace and repository name separated by "/"',
);

function validateProviderProjectPaths(
  value: {
    sourceProvider?: (typeof SOURCE_PROVIDERS)[number];
    sourceRepo?: string;
    repos?: string[];
    items?: Array<{ sourceRepo: string }>;
  },
  context: z.RefinementCtx,
): void {
  const adapter = getSourceProviderAdapter(value.sourceProvider ?? "github");
  const projects = value.sourceRepo
    ? [{ path: value.sourceRepo, issuePath: ["sourceRepo"] }]
    : [
        ...(value.repos ?? []).map((path, index) => ({ path, issuePath: ["repos", index] })),
        ...(value.items ?? []).map((item, index) => ({
          path: item.sourceRepo,
          issuePath: ["items", index, "sourceRepo"],
        })),
      ];
  for (const project of projects) {
    if (!adapter.isValidProjectPath(project.path)) {
      context.addIssue({
        code: "custom",
        path: project.issuePath,
        message: `must be a valid ${adapter.displayName} repository path`,
      });
    }
  }
}

function validateSourceUrl(
  value: { sourceProvider?: (typeof SOURCE_PROVIDERS)[number]; sourceApiUrl?: string },
  context: z.RefinementCtx,
): void {
  if (value.sourceApiUrl === undefined) return;
  try {
    assertMigrationSourceApiUrl(value.sourceApiUrl, value.sourceProvider);
  } catch {
    context.addIssue({
      code: "custom",
      path: ["sourceApiUrl"],
      message: "must be an HTTPS URL without credentials, query, or fragment",
    });
  }
}

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

export const restartMigrationSchema = z.object(optionFields);

export const confirmRestartSchema = z.object({
  confirmation: boundedString().min(1, "confirmation is required"),
});

export const createMigrationSchema = z
  .object({
    ...optionFields,
    sourceProvider: z.enum(SOURCE_PROVIDERS).optional(),
    sourceApiUrl: boundedString().optional(),
    targetProfileId: targetProfileId.optional(),
    sourceRepo: repository,
    targetOrg: boundedString().min(1, "targetOrg is required"),
    targetRepo: boundedString().optional(),
    gitArchivePath: boundedString().optional(),
    metadataArchivePath: boundedString().optional(),
  })
  .superRefine((value, context) => {
    validateSourceUrl(value, context);
    validateProviderProjectPaths(value, context);
  });

const MAX_BATCH_REPOSITORIES = 500;

const batchItems = z
  .array(
    z.object({
      sourceRepo: repository,
      targetRepo: boundedString().min(1, "targetRepo is required"),
    }),
  )
  .min(1, "items must contain at least one repository mapping")
  .max(MAX_BATCH_REPOSITORIES, `items exceeds the maximum of ${MAX_BATCH_REPOSITORIES}`);

export const batchMigrationSchema = z
  .object({
    ...optionFields,
    profileRunId: boundedString().optional(),
    sourceProvider: z.enum(SOURCE_PROVIDERS).optional(),
    sourceApiUrl: boundedString().optional(),
    targetProfileId,
    repos: z
      .array(repository)
      .min(1, "repos must contain at least one org/repo entry")
      .max(MAX_BATCH_REPOSITORIES, `repos exceeds the maximum of ${MAX_BATCH_REPOSITORIES}`)
      .optional(),
    items: batchItems.optional(),
    targetOrg: boundedString().min(1, "targetOrg is required"),
  })
  .superRefine((value, context) => {
    validateSourceUrl(value, context);
    validateProviderProjectPaths(value, context);
    if (!value.repos && !value.items) {
      context.addIssue({ code: "custom", path: ["repos"], message: "repos or items is required" });
      return;
    }
    if (value.repos && value.items) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "use either repos or items, not both",
      });
      return;
    }
    if (value.items) {
      const targetNames = new Set<string>();
      for (const [index, item] of value.items.entries()) {
        const normalized = item.targetRepo.toLowerCase();
        if (targetNames.has(normalized)) {
          context.addIssue({
            code: "custom",
            path: ["items", index, "targetRepo"],
            message: "target repository names must be unique",
          });
        }
        targetNames.add(normalized);
      }
    }
  });

function firstError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request body";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

export function validateBody<S extends z.ZodType>(
  schema: S,
  data: unknown,
): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: firstError(result.error) };
}
