import { describe, expect, test } from "bun:test";
import type { ProfileInventorySummary } from "$lib/profile/types";
import { GITLAB_PROFILE_METRIC_KEYS, type GitLabMetricKey } from "$lib/source/gitlab-metrics";
import { gitLabMetricFixtures } from "$lib/source/gitlab-metrics/fixtures";
import type {
  GitLabProfileEnrichment,
  GitLabProjectMetrics,
  ProfileNumericMetric,
  SourceNamespaceInventory,
} from "$lib/source/types";
import {
  parseProfileInventorySummary,
  summarizeGitLabEnrichment,
  summarizeProfileInventory,
} from "./overview";

function profileMetrics(issues: ProfileNumericMetric): GitLabProjectMetrics {
  const exact = (endpointFamily: string, value: number, basis: "reported" | "enumerated") => ({
    provider: "gitlab" as const,
    endpointFamily,
    collectedAt: "2026-08-10T12:00:00.000Z",
    observation: { kind: "exact" as const, value, basis, scope: `${endpointFamily} scope` },
  });
  return gitLabMetricFixtures({
    issues,
    mergeRequests: exact("project-merge-requests", 1, "reported"),
    commits: exact("repository-commit-sequence", 3, "reported"),
    branches: exact("repository-branches", 2, "enumerated"),
    tags: exact("repository-tags", 1, "enumerated"),
    releases: exact("project-releases", 1, "enumerated"),
    ciConfiguration: exact("project-ci-configuration", 1, "reported"),
    protectedBranches: exact("project-protected-branches", 2, "enumerated"),
    inheritedProtectedBranches: exact("protected-branch-inheritance", 1, "enumerated"),
    protectedTags: exact("project-protected-tags", 1, "enumerated"),
    projectWebhooks: { ...exact("project-hooks", 0, "enumerated"), eventCategories: [] },
    groupWebhooks: { ...exact("group-hooks", 1, "enumerated"), eventCategories: ["pipeline"] },
  });
}

type SummaryObservation = NonNullable<ProfileInventorySummary["metrics"]>[GitLabMetricKey];

/** What summing one observation over identical projects gives: unavailable stays unavailable. */
function sameInEveryProject(
  observation: ProfileNumericMetric["observation"],
  projects: number,
): SummaryObservation {
  return observation.kind === "unavailable"
    ? { kind: "unavailable", reason: observation.reason }
    : { kind: observation.kind, value: observation.value * projects };
}

function inventory(): SourceNamespaceInventory {
  return {
    version: 1,
    provider: "gitlab",
    sourceApiUrl: "https://gitlab.example.com/api/v4",
    namespace: "platform/products",
    projectCount: { kind: "at-least", value: 2 },
    projects: [
      {
        provider: "gitlab",
        sourceId: "1",
        path: "platform/products/api",
        name: "api",
        visibility: "private",
        archived: false,
        defaultBranch: "main",
        lastActivityAt: null,
        repositorySizeBytes: { kind: "exact", value: 100 },
        storageSizeBytes: { kind: "exact", value: 120 },
        lfsObjectsSizeBytes: { kind: "unavailable", reason: "not-reported" },
        packagesSizeBytes: { kind: "exact", value: 10 },
        wikiSizeBytes: { kind: "exact", value: 0 },
        uploadsSizeBytes: { kind: "exact", value: 1 },
        jobArtifactsSizeBytes: { kind: "unavailable", reason: "not-reported" },
        pipelineArtifactsSizeBytes: { kind: "unavailable", reason: "not-reported" },
        snippetsSizeBytes: { kind: "unavailable", reason: "not-reported" },
        containerRegistrySizeBytes: { kind: "unavailable", reason: "not-reported" },
      },
      {
        provider: "gitlab",
        sourceId: "2",
        path: "platform/products/web",
        name: "web",
        visibility: "internal",
        archived: true,
        defaultBranch: null,
        lastActivityAt: null,
        repositorySizeBytes: { kind: "at-least", value: 200 },
        storageSizeBytes: { kind: "exact", value: 230 },
        lfsObjectsSizeBytes: { kind: "exact", value: 0 },
        packagesSizeBytes: { kind: "exact", value: 20 },
        wikiSizeBytes: { kind: "exact", value: 2 },
        uploadsSizeBytes: { kind: "exact", value: 3 },
        jobArtifactsSizeBytes: { kind: "unavailable", reason: "not-reported" },
        pipelineArtifactsSizeBytes: { kind: "unavailable", reason: "not-reported" },
        snippetsSizeBytes: { kind: "unavailable", reason: "not-reported" },
        containerRegistrySizeBytes: { kind: "unavailable", reason: "not-reported" },
      },
    ],
  };
}

describe("summarizeProfileInventory", () => {
  test("retains scoped membership counts separately and deduplicates shared groups, not users", () => {
    const members = gitLabMetricFixtures().members;
    const projectScope = members.scopes[0]!;
    const group = { ...projectScope, kind: "group" as const, path: "platform/products" };
    const enrichment: GitLabProfileEnrichment = {
      version: 2,
      provider: "gitlab",
      sourceApiUrl: "https://gitlab.invalid/api/v4",
      namespace: "platform/products",
      projects: ["api", "web"].map((name) => ({
        sourceId: name,
        path: `platform/products/${name}`,
        metrics: gitLabMetricFixtures({
          members: {
            ...members,
            scopes: [{ ...projectScope, path: `platform/products/${name}` }, group],
          },
        }),
      })),
    };
    const summary = parseProfileInventorySummary(
      summarizeGitLabEnrichment(summarizeProfileInventory(inventory()), enrichment),
    );
    expect(summary.metrics?.members).toEqual({ kind: "unavailable", reason: "unsupported" });
    expect(summary.membershipScopes?.map(({ kind, path }) => [kind, path])).toEqual([
      ["project", "platform/products/api"],
      ["group", "platform/products"],
      ["project", "platform/products/web"],
    ]);
    expect(
      summary.membershipScopes?.map(({ direct, effective }) => [
        direct.observation,
        effective.observation,
      ]),
    ).toEqual(
      Array.from({ length: 3 }, () => [
        expect.objectContaining({ kind: "exact", value: 2 }),
        expect.objectContaining({ kind: "exact", value: 3 }),
      ]),
    );
  });
  test("summarizes project state and preserves lower-bound totals", () => {
    const summary = summarizeProfileInventory(inventory());

    expect(summary).toMatchObject({
      projectCount: { kind: "at-least", value: 2 },
      projectsCaptured: 2,
      visibility: { public: 0, private: 1, internal: 1 },
      archivedProjects: 1,
      projectsWithoutDefaultBranch: 1,
    });
    expect(summary.storage.repositorySizeBytes).toEqual({ kind: "at-least", value: 300 });
    expect(summary.storage.storageSizeBytes).toEqual({ kind: "exact", value: 350 });
  });

  test("keeps the known lower bound when only some project values are unavailable", () => {
    const summary = summarizeProfileInventory(inventory());

    expect(summary.storage.lfsObjectsSizeBytes).toEqual({ kind: "at-least", value: 0 });
  });

  test("keeps an aggregate unavailable when every project value is unavailable", () => {
    const value = inventory();
    value.projects[1]!.lfsObjectsSizeBytes = {
      kind: "unavailable",
      reason: "not-reported",
    };

    expect(summarizeProfileInventory(value).storage.lfsObjectsSizeBytes).toEqual({
      kind: "unavailable",
      reason: "not-reported",
    });
  });

  test("reports exact zero for an empty, available inventory", () => {
    const empty = inventory();
    empty.projectCount = { kind: "exact", value: 0 };
    empty.projects = [];

    const summary = summarizeProfileInventory(empty);
    expect(summary.projectsCaptured).toBe(0);
    expect(summary.storage.repositorySizeBytes).toEqual({ kind: "exact", value: 0 });
  });

  test("does not convert an unavailable namespace into exact zero storage", () => {
    const unavailable = inventory();
    unavailable.projectCount = { kind: "unavailable", reason: "forbidden" };
    unavailable.projects = [];

    const summary = summarizeProfileInventory(unavailable);
    expect(summary.storage.repositorySizeBytes).toEqual({
      kind: "unavailable",
      reason: "forbidden",
    });
    expect(summary.storage.storageSizeBytes).toEqual({
      kind: "unavailable",
      reason: "forbidden",
    });
  });
});

describe("summarizeGitLabEnrichment", () => {
  test("sums exact issue observations across inventory projects", () => {
    const enrichment: GitLabProfileEnrichment = {
      version: 2,
      provider: "gitlab",
      sourceApiUrl: "https://gitlab.example.com/api/v4",
      namespace: "platform/products",
      projects: [
        {
          sourceId: "1",
          path: "platform/products/api",
          metrics: profileMetrics({
            provider: "gitlab",
            endpointFamily: "project-issues",
            collectedAt: "2026-08-10T12:00:00.000Z",
            observation: {
              kind: "exact",
              value: 2,
              basis: "reported",
              scope: "visible project issues",
            },
          }),
        },
        {
          sourceId: "2",
          path: "platform/products/web",
          metrics: profileMetrics({
            provider: "gitlab",
            endpointFamily: "project-issues",
            collectedAt: "2026-08-10T12:00:00.000Z",
            observation: {
              kind: "exact",
              value: 3,
              basis: "reported",
              scope: "visible project issues",
            },
          }),
        },
      ],
    };

    const listed: Record<string, SummaryObservation> = {
      issues: { kind: "exact", value: 5 },
      mergeRequests: { kind: "exact", value: 2 },
      commits: { kind: "exact", value: 6 },
      branches: { kind: "exact", value: 4 },
      tags: { kind: "exact", value: 2 },
      releases: { kind: "exact", value: 2 },
      ciConfiguration: { kind: "exact", value: 2 },
      protectedBranches: { kind: "exact", value: 4 },
      inheritedProtectedBranches: { kind: "exact", value: 2 },
      protectedTags: { kind: "exact", value: 2 },
      projectWebhooks: { kind: "exact", value: 0 },
      groupWebhooks: { kind: "exact", value: 2 },
    };
    // Metrics the scenario does not name keep their generated fixture, summed over two projects.
    const generated: Record<string, SummaryObservation> = Object.fromEntries(
      Object.entries(gitLabMetricFixtures())
        .filter(([key]) => !(key in listed))
        .map(([key, { observation }]) => [key, sameInEveryProject(observation, 2)]),
    );
    expect(
      summarizeGitLabEnrichment(summarizeProfileInventory(inventory()), enrichment).metrics,
    ).toEqual({ ...listed, ...generated });
    expect(
      summarizeGitLabEnrichment(summarizeProfileInventory(inventory()), enrichment).webhookEvents,
    ).toEqual({ projectWebhooks: [], groupWebhooks: ["pipeline"] });
  });

  test("keeps a spent request budget unavailable, never a measured zero, for every metric", () => {
    const fixtures = gitLabMetricFixtures();
    const spent = gitLabMetricFixtures(
      Object.fromEntries(
        GITLAB_PROFILE_METRIC_KEYS.map((key) => [
          key,
          {
            ...fixtures[key],
            observation: {
              kind: "unavailable",
              reason: "request-budget",
              scope: "fixture request budget",
            },
          },
        ]),
      ),
    );
    const enrichment = (second: GitLabProjectMetrics): GitLabProfileEnrichment => ({
      version: 2,
      provider: "gitlab",
      sourceApiUrl: "https://gitlab.example.com/api/v4",
      namespace: "platform/products",
      projects: [
        { sourceId: "1", path: "platform/products/api", metrics: spent },
        { sourceId: "2", path: "platform/products/web", metrics: second },
      ],
    });
    const summarize = (second: GitLabProjectMetrics) =>
      summarizeGitLabEnrichment(summarizeProfileInventory(inventory()), enrichment(second)).metrics;

    expect(summarize(spent)).toEqual(
      Object.fromEntries(
        GITLAB_PROFILE_METRIC_KEYS.map((key) => [
          key,
          { kind: "unavailable", reason: "request-budget" },
        ]),
      ),
    );
    // One project still measured: its count is a lower bound, not the total.
    expect(summarize(fixtures)).toEqual(
      Object.fromEntries(
        GITLAB_PROFILE_METRIC_KEYS.map((key) => {
          const { observation } = fixtures[key];
          return [
            key,
            observation.kind === "unavailable"
              ? { kind: "unavailable", reason: "request-budget" }
              : { kind: "at-least", value: observation.value },
          ];
        }),
      ),
    );
  });

  test("distinguishes known approval policy from missing evidence across the captured projects", () => {
    const { approvalRules: none } = gitLabMetricFixtures();
    const restricted: typeof none = {
      ...none,
      observation: { kind: "unavailable", reason: "not-reported", scope: none.observation.scope },
      requiresApprovals: null,
      hasRequiredProtectedBranchRules: null,
    };
    const required: typeof none = {
      ...none,
      observation: {
        kind: "exact",
        value: 2,
        basis: "enumerated",
        scope: none.observation.scope,
      },
      requiresApprovals: true,
      hasRequiredProtectedBranchRules: true,
    };
    const discovered = inventory();
    const summarize = (left: typeof none, right: typeof none) =>
      summarizeGitLabEnrichment(summarizeProfileInventory(discovered), {
        version: 2,
        provider: "gitlab",
        sourceApiUrl: discovered.sourceApiUrl,
        namespace: discovered.namespace,
        projects: discovered.projects.map(({ sourceId, path }, index) => ({
          sourceId,
          path,
          metrics: gitLabMetricFixtures({ approvalRules: index === 0 ? left : right }),
        })),
      });

    expect(summarize(none, none)).toMatchObject({
      metrics: { approvalRules: { kind: "exact", value: 0 } },
      approvalPolicy: { requiresApprovals: false, hasRequiredProtectedBranchRules: false },
    });
    expect(summarize(none, restricted)).toMatchObject({
      metrics: { approvalRules: { kind: "at-least", value: 0 } },
      approvalPolicy: { requiresApprovals: null, hasRequiredProtectedBranchRules: null },
    });
    expect(summarize(restricted, required)).toMatchObject({
      metrics: { approvalRules: { kind: "at-least", value: 2 } },
      approvalPolicy: { requiresApprovals: true, hasRequiredProtectedBranchRules: true },
    });
  });

  test("rolls up enabled pull projects independently of push mirror counts", () => {
    const { mirrors } = gitLabMetricFixtures();
    const discovered = inventory();
    const summarize = (left: typeof mirrors.pullMirror, right: typeof mirrors.pullMirror) =>
      summarizeGitLabEnrichment(summarizeProfileInventory(discovered), {
        version: 2,
        provider: "gitlab",
        sourceApiUrl: discovered.sourceApiUrl,
        namespace: discovered.namespace,
        projects: discovered.projects.map(({ sourceId, path }, index) => ({
          sourceId,
          path,
          metrics: gitLabMetricFixtures({
            mirrors: { ...mirrors, pullMirror: index === 0 ? left : right },
          }),
        })),
      });

    const unavailable = { kind: "unavailable", reason: "forbidden" } as const;
    expect(summarize({ kind: "enabled" }, unavailable)).toMatchObject({
      metrics: { mirrors: { kind: "exact", value: 0 } },
      pullMirrorProjects: { kind: "at-least", value: 1 },
    });
    expect(summarize(unavailable, unavailable).pullMirrorProjects).toEqual(unavailable);
    expect(summarize({ kind: "disabled" }, { kind: "not-mirrored" }).pullMirrorProjects).toEqual({
      kind: "exact",
      value: 0,
    });
  });

  test("keeps known issue counts as a lower bound when one project is unavailable", () => {
    const exact = {
      provider: "gitlab" as const,
      endpointFamily: "project-issues",
      collectedAt: "2026-08-10T12:00:00.000Z",
      observation: {
        kind: "exact" as const,
        value: 2,
        basis: "reported" as const,
        scope: "visible project issues",
      },
    };
    const enrichment: GitLabProfileEnrichment = {
      version: 2,
      provider: "gitlab",
      sourceApiUrl: "https://gitlab.example.com/api/v4",
      namespace: "platform/products",
      projects: [
        { sourceId: "1", path: "platform/products/api", metrics: profileMetrics(exact) },
        {
          sourceId: "2",
          path: "platform/products/web",
          metrics: profileMetrics({
            ...exact,
            observation: {
              kind: "unavailable",
              reason: "forbidden",
              scope: "visible project issues",
            },
          }),
        },
      ],
    };

    expect(
      summarizeGitLabEnrichment(summarizeProfileInventory(inventory()), enrichment).metrics,
    ).toMatchObject({ issues: { kind: "at-least", value: 2 } });
  });
});
