import { z } from "zod";
import type { ProfileDetailRollup } from "../analysis/rollup";
import {
  type OrgResources,
  type RepoSignals,
  type StoredCatalogMatch,
  ZERO_ORG_RESOURCES,
} from "../types";

const count = z.number().int().nonnegative();

const orgResourcesSchema = z
  .object({
    actionsSecrets: count.optional(),
    actionsVariables: count.optional(),
    dependabotSecrets: count.optional(),
    codespacesSecrets: count.optional(),
    selfHostedRunners: count.optional(),
    customProperties: count.optional(),
    teams: count.optional(),
    appInstallations: count.optional(),
  })
  .strict();

const repoSignalsSchema = z
  .object({
    name: z.string(),
    nameWithOwner: z.string(),
    visibility: z.enum(["PUBLIC", "PRIVATE", "INTERNAL"]),
    isArchived: z.boolean(),
    isFork: z.boolean(),
    isEmpty: z.boolean(),
    diskUsageKb: count.nullable(),
    hasWiki: z.boolean(),
    hasIssues: z.boolean(),
    hasProjects: z.boolean(),
    hasDiscussions: z.boolean(),
    hasPages: z.boolean(),
    defaultBranch: z.string().nullable(),
    pushedAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    commitsCount: count,
    discussionsCount: count,
    projectsV2Count: count,
    environmentsCount: count,
    releaseAssetBytes: count,
    stargazerCount: count,
    watcherCount: count,
    forkCount: count,
    rulesetCount: count,
    branchProtectionRuleCount: count,
    branchProtectionRulesUsingUnmigratedFeatures: count,
    packagesCount: count,
    usesLfs: z.boolean(),
    workflowFileCount: count,
    webhooksCount: count.nullable(),
    hasCodeScanningAlerts: z.boolean().nullable(),
    collaboratorsCount: count.nullable(),
    tagProtectionCount: count.nullable(),
    issuesCount: count,
    pullRequestsCount: count,
    branchesCount: count,
    tagsCount: count,
    releasesCount: count,
  })
  .strict() satisfies z.ZodType<RepoSignals>;

const persistedCatalogMatchSchema = z
  .object({
    considerationId: z.string(),
    evidence: z.string(),
  })
  .strict();

const preparationSummarySchema = z
  .object({
    items: z.array(
      z
        .object({
          catalogEntryId: z.string(),
          label: z.string(),
          kind: z.enum(["routable", "recreate", "reconfigure", "blocker", "accepted-loss"]),
          severity: z.enum(["info", "warn", "blocker"]),
          routesTo: z.string().nullable(),
          affectedRepos: count,
        })
        .strict(),
    ),
    notYetCrawled: z.array(
      z
        .object({
          catalogEntryId: z.string(),
          label: z.string(),
          severity: z.enum(["info", "warn", "blocker"]),
        })
        .strict(),
    ),
    alwaysLost: z.array(
      z
        .object({
          catalogEntryId: z.string(),
          label: z.string(),
          summary: z.string(),
        })
        .strict(),
    ),
    blockerRepos: count,
    warnRepos: count,
    cleanRepos: count,
  })
  .strict();

const profileDetailRollupSchema = z
  .object({
    scale: z
      .object({
        repos: count,
        issues: count,
        pullRequests: count,
        commits: count,
        branches: count,
        tags: count,
        releases: count,
        diskUsageKb: count,
      })
      .strict(),
    composition: z
      .object({
        total: count,
        active: z.object({ count, pct: count.max(100) }).strict(),
        stale: z.object({ count, pct: count.max(100) }).strict(),
        empty: z.object({ count, pct: count.max(100) }).strict(),
        archived: z.object({ count, pct: count.max(100) }).strict(),
      })
      .strict(),
    summary: preparationSummarySchema,
    estimate: z
      .object({
        bandCounts: z.object({ S: count, M: count, L: count, XL: count }).strict(),
        totalRepoHoursLow: z.number().nonnegative(),
        totalRepoHoursHigh: z.number().nonnegative(),
        defaultParallelism: count.positive(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<ProfileDetailRollup>;

function parseJson(json: string, description: string): unknown {
  try {
    return JSON.parse(json);
  } catch (cause) {
    throw new Error(`Invalid stored ${description}`, { cause });
  }
}

function parseRequired<S extends z.ZodType>(
  schema: S,
  json: string,
  description: string,
): z.infer<S> {
  const parsed = schema.safeParse(parseJson(json, description));
  if (!parsed.success) throw new Error(`Invalid stored ${description}`, { cause: parsed.error });
  return parsed.data;
}

export function parsePersistedOrgResources(json: string): OrgResources {
  return {
    ...ZERO_ORG_RESOURCES,
    ...parseRequired(orgResourcesSchema, json, "profile organization resources"),
  };
}

export function parsePersistedRepoSignals(json: string): RepoSignals {
  return parseRequired(repoSignalsSchema, json, "repository profile signals");
}

export function parsePersistedCatalogMatches(json: string): StoredCatalogMatch[] {
  return parseRequired(
    z.array(persistedCatalogMatchSchema),
    json,
    "repository profile catalog matches",
  ).map(({ considerationId, evidence }) => ({ catalogEntryId: considerationId, evidence }));
}

export function parsePersistedProfileRollup(json: string): ProfileDetailRollup | null {
  try {
    return parseRequired(profileDetailRollupSchema, json, "profile detail rollup");
  } catch {
    return null;
  }
}
