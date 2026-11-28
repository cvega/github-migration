import { z } from "zod";
import {
  GITLAB_PROFILE_METRIC_KEYS,
  GITLAB_PROFILE_METRICS,
  type GitLabMetricKey,
} from "$lib/source/gitlab-metrics";
import { profileNumericMetricSchema } from "$lib/source/observations";
import type { BitbucketProfileEnrichment, GitLabProfileEnrichment } from "$lib/source/types";

const BITBUCKET_PROFILE_METRIC_KEYS = [
  "commits",
  "pullRequests",
  "branches",
  "tags",
  "forks",
] as const;

const gitLabProjectProfileSchema = z
  .object({
    sourceId: z.string().min(1).max(255),
    path: z.string().min(1).max(2_048),
    metrics: z
      .object(
        Object.fromEntries(
          GITLAB_PROFILE_METRICS.map(({ key, ...descriptor }) => [
            key,
            "fields" in descriptor
              ? profileNumericMetricSchema.extend(descriptor.fields)
              : profileNumericMetricSchema,
          ]),
        ) as Record<GitLabMetricKey, typeof profileNumericMetricSchema>,
      )
      .strict(),
  })
  .strict();

const gitLabProfileEnrichmentSchema = z
  .object({
    version: z.literal(2),
    provider: z.literal("gitlab"),
    sourceApiUrl: z.string().min(1).max(2_048),
    namespace: z.string().min(1).max(2_048),
    projects: z.array(gitLabProjectProfileSchema).max(10_000),
  })
  .strict()
  .superRefine((enrichment, context) => {
    const sourceIds = new Set<string>();
    const paths = new Set<string>();
    for (const [index, project] of enrichment.projects.entries()) {
      for (const key of GITLAB_PROFILE_METRIC_KEYS) {
        if (project.metrics[key].provider !== "gitlab") {
          context.addIssue({
            code: "custom",
            path: ["projects", index, "metrics", key, "provider"],
            message: "must match the enrichment provider",
          });
        }
      }
      if (sourceIds.has(project.sourceId) || paths.has(project.path)) {
        context.addIssue({
          code: "custom",
          path: ["projects", index],
          message: "must have a unique sourceId and path",
        });
      }
      sourceIds.add(project.sourceId);
      paths.add(project.path);
    }
  });

export const bitbucketActivitySchema = z
  .object({
    defaultBranch: z.string().nullable(),
    tipCommittedAt: z.string().datetime().nullable(),
    review: z
      .object({
        open: z.number().int().nonnegative(),
        merged: z.number().int().nonnegative(),
        declined: z.number().int().nonnegative(),
        oldestOpenCreatedAt: z.string().datetime().nullable(),
        latestUpdatedAt: z.string().datetime().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const bitbucketProjectProfileSchema = z
  .object({
    sourceId: z.string().min(1).max(255),
    path: z.string().min(1).max(2_048),
    activity: bitbucketActivitySchema,
    metrics: z
      .object({
        commits: profileNumericMetricSchema,
        pullRequests: profileNumericMetricSchema,
        branches: profileNumericMetricSchema,
        tags: profileNumericMetricSchema,
        forks: profileNumericMetricSchema,
      })
      .strict(),
  })
  .strict();

const bitbucketProfileEnrichmentSchema = z
  .object({
    version: z.literal(2),
    provider: z.literal("bitbucket-server"),
    sourceApiUrl: z.string().min(1).max(2_048),
    namespace: z.string().min(1).max(2_048),
    projects: z.array(bitbucketProjectProfileSchema).max(10_000),
  })
  .strict()
  .superRefine((enrichment, context) => {
    const sourceIds = new Set<string>();
    const paths = new Set<string>();
    for (const [index, project] of enrichment.projects.entries()) {
      for (const key of BITBUCKET_PROFILE_METRIC_KEYS) {
        if (project.metrics[key].provider !== "bitbucket-server") {
          context.addIssue({
            code: "custom",
            path: ["projects", index, "metrics", key, "provider"],
            message: "must match the enrichment provider",
          });
        }
      }
      const canonicalPath = project.path.toLowerCase();
      if (sourceIds.has(project.sourceId) || paths.has(canonicalPath)) {
        context.addIssue({
          code: "custom",
          path: ["projects", index],
          message: "must have a unique sourceId and path",
        });
      }
      sourceIds.add(project.sourceId);
      paths.add(canonicalPath);
    }
  });

export function parseGitLabProfileEnrichment(value: unknown): GitLabProfileEnrichment {
  return gitLabProfileEnrichmentSchema.parse(value) as GitLabProfileEnrichment;
}

export function parseBitbucketProfileEnrichment(value: unknown): BitbucketProfileEnrichment {
  return bitbucketProfileEnrichmentSchema.parse(value) as BitbucketProfileEnrichment;
}
