import { z } from "zod";
import {
  type BitbucketProfileEnrichment,
  type GitLabProfileEnrichment,
  type NumericObservation,
  OBSERVATION_UNAVAILABLE_REASONS,
  type ProfileNumericMetric,
  type SourceNamespaceInventory,
  type SourceProjectInventory,
} from "$lib/source/types";

const GITLAB_PROFILE_METRIC_KEYS = [
  "issues",
  "mergeRequests",
  "commits",
  "branches",
  "tags",
  "releases",
] as const;

const BITBUCKET_PROFILE_METRIC_KEYS = [
  "commits",
  "pullRequests",
  "branches",
  "tags",
  "forks",
] as const;

export interface ProfileInventorySummary {
  projectCount: NumericObservation;
  projectsCaptured: number;
  visibility: Record<SourceProjectInventory["visibility"], number>;
  archivedProjects: number;
  projectsWithoutDefaultBranch: number;
  storage: {
    repositorySizeBytes: NumericObservation;
    storageSizeBytes: NumericObservation;
    lfsObjectsSizeBytes: NumericObservation;
    packagesSizeBytes: NumericObservation;
    wikiSizeBytes: NumericObservation;
    uploadsSizeBytes: NumericObservation;
    jobArtifactsSizeBytes: NumericObservation;
    pipelineArtifactsSizeBytes: NumericObservation;
    snippetsSizeBytes: NumericObservation;
    containerRegistrySizeBytes: NumericObservation;
  };
  metrics?: Partial<Record<ProfileInventoryMetricKey, NumericObservation>>;
}

const PROFILE_INVENTORY_METRIC_KEYS = [
  ...GITLAB_PROFILE_METRIC_KEYS,
  ...BITBUCKET_PROFILE_METRIC_KEYS,
] as const;

type ProfileInventoryMetricKey = (typeof PROFILE_INVENTORY_METRIC_KEYS)[number];

const STORAGE_KEYS = [
  "repositorySizeBytes",
  "storageSizeBytes",
  "lfsObjectsSizeBytes",
  "packagesSizeBytes",
  "wikiSizeBytes",
  "uploadsSizeBytes",
  "jobArtifactsSizeBytes",
  "pipelineArtifactsSizeBytes",
  "snippetsSizeBytes",
  "containerRegistrySizeBytes",
] as const;

const numericObservationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), value: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("at-least"), value: z.number().int().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.enum(OBSERVATION_UNAVAILABLE_REASONS),
    })
    .strict(),
]);

const profileInventorySummarySchema = z
  .object({
    projectCount: numericObservationSchema,
    projectsCaptured: z.number().int().nonnegative(),
    visibility: z
      .object({
        public: z.number().int().nonnegative(),
        private: z.number().int().nonnegative(),
        internal: z.number().int().nonnegative(),
      })
      .strict(),
    archivedProjects: z.number().int().nonnegative(),
    projectsWithoutDefaultBranch: z.number().int().nonnegative(),
    storage: z
      .object(
        Object.fromEntries(STORAGE_KEYS.map((key) => [key, numericObservationSchema])) as Record<
          (typeof STORAGE_KEYS)[number],
          typeof numericObservationSchema
        >,
      )
      .strict(),
    metrics: z
      .object(
        Object.fromEntries(
          PROFILE_INVENTORY_METRIC_KEYS.map((key) => [key, numericObservationSchema.optional()]),
        ) as Record<ProfileInventoryMetricKey, z.ZodOptional<typeof numericObservationSchema>>,
      )
      .strict()
      .optional(),
  })
  .strict();

export function parseProfileInventorySummary(value: unknown): ProfileInventorySummary {
  return profileInventorySummarySchema.parse(value) as ProfileInventorySummary;
}

function toSummaryObservation({ observation }: ProfileNumericMetric): NumericObservation {
  return observation.kind === "unavailable"
    ? { kind: "unavailable", reason: observation.reason }
    : { kind: observation.kind, value: observation.value };
}

function sumObservations(observations: NumericObservation[]): NumericObservation {
  const known = observations.filter(
    (observation): observation is Exclude<NumericObservation, { kind: "unavailable" }> =>
      observation.kind !== "unavailable",
  );
  const value = known.reduce((total, observation) => total + observation.value, 0);
  if (known.length === 0 && observations.length > 0) {
    return observations[0] as Extract<NumericObservation, { kind: "unavailable" }>;
  }
  return observations.some(
    (observation) => observation.kind === "at-least" || observation.kind === "unavailable",
  )
    ? { kind: "at-least", value }
    : { kind: "exact", value };
}

/** Derive a bounded view model without exposing the full persisted inventory. */
export function summarizeProfileInventory(
  inventory: SourceNamespaceInventory,
): ProfileInventorySummary {
  const unavailable = inventory.projectCount.kind === "unavailable" ? inventory.projectCount : null;
  const summary: ProfileInventorySummary = {
    projectCount: inventory.projectCount,
    projectsCaptured: inventory.projects.length,
    visibility: { public: 0, private: 0, internal: 0 },
    archivedProjects: 0,
    projectsWithoutDefaultBranch: 0,
    storage: Object.fromEntries(
      STORAGE_KEYS.map((key) => [
        key,
        unavailable ?? sumObservations(inventory.projects.map((project) => project[key])),
      ]),
    ) as ProfileInventorySummary["storage"],
  };

  for (const project of inventory.projects) {
    summary.visibility[project.visibility] += 1;
    if (project.archived) summary.archivedProjects += 1;
    if (project.defaultBranch === null) summary.projectsWithoutDefaultBranch += 1;
  }
  return summary;
}

/** Add UI-facing aggregates while retaining detailed v2 observations separately. */
export function summarizeGitLabEnrichment(
  summary: ProfileInventorySummary,
  enrichment: GitLabProfileEnrichment,
): ProfileInventorySummary {
  const metrics = Object.fromEntries(
    GITLAB_PROFILE_METRIC_KEYS.map((key) => {
      const observations = enrichment.projects.map(({ metrics: projectMetrics }) =>
        toSummaryObservation(projectMetrics[key]),
      );
      return [key, sumObservations(observations)];
    }),
  ) as NonNullable<ProfileInventorySummary["metrics"]>;
  return {
    ...summary,
    metrics,
  };
}

/** Add Bitbucket repository aggregates without fabricating unsupported metrics. */
export function summarizeBitbucketEnrichment(
  summary: ProfileInventorySummary,
  enrichment: BitbucketProfileEnrichment,
): ProfileInventorySummary {
  const metrics = Object.fromEntries(
    BITBUCKET_PROFILE_METRIC_KEYS.map((key) => {
      const observations = enrichment.projects.map(({ metrics: projectMetrics }) =>
        toSummaryObservation(projectMetrics[key]),
      );
      return [key, sumObservations(observations)];
    }),
  ) as NonNullable<ProfileInventorySummary["metrics"]>;
  return { ...summary, metrics };
}
