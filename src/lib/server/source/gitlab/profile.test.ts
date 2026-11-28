import { describe, expect, spyOn, test } from "bun:test";
import { GITLAB_PROFILE_METRIC_KEYS } from "$lib/source/gitlab-metrics";
import type { SourceNamespaceInventory } from "$lib/source/types";
import { GitLabApiError, GitLabClient } from "./client";
import { DEFAULT_GITLAB_PROFILE_REQUEST_BUDGET } from "./config";
import { collectGitLabApprovalRuleMetric } from "./metrics/approval-rules.collector";
import { collectGitLabBranchMetric, GITLAB_BRANCHES_SCOPE } from "./metrics/branches.collector";
import { collectGitLabCommitMetric, GITLAB_COMMITS_SCOPE } from "./metrics/commits.collector";
import { collectGitLabIssueMetric, GITLAB_ISSUES_SCOPE } from "./metrics/issues.collector";
import {
  collectGitLabMergeRequestMetric,
  GITLAB_MERGE_REQUESTS_SCOPE,
} from "./metrics/merge-requests.collector";
import mirrorsCollector from "./metrics/mirrors.collector";
import { collectGitLabReleaseMetric, GITLAB_RELEASES_SCOPE } from "./metrics/releases.collector";
import { collectGitLabTagMetric, GITLAB_TAGS_SCOPE } from "./metrics/tags.collector";
import { collectGitLabProfileEnrichment } from "./profile";

function clientWithResponses(responses: Response[]) {
  const calls: URL[] = [];
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.com",
    token: "secret-token",
    maxRetries: 0,
    fetch: async (input) => {
      calls.push(new URL(input.toString()));
      const response = responses.shift();
      if (!response) throw new Error("unexpected fetch");
      return response;
    },
  });
  return { calls, client };
}

function jsonResponse(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("collectGitLabIssueMetric", () => {
  test("records an exact provider-reported count with its scope and provenance", async () => {
    const { calls, client } = clientWithResponses([jsonResponse([{}], { "X-Total": "42" })]);

    const metric = await collectGitLabIssueMetric(
      client,
      { sourceId: "platform/payments" },
      { nowMs: Date.parse("2026-08-10T12:00:00Z") },
    );

    expect(metric).toEqual({
      provider: "gitlab",
      endpointFamily: "project-issues",
      collectedAt: "2026-08-10T12:00:00.000Z",
      observation: {
        kind: "exact",
        value: 42,
        basis: "reported",
        scope: GITLAB_ISSUES_SCOPE,
      },
    });
    expect(calls[0]?.pathname).toBe("/api/v4/projects/platform%2Fpayments/issues");
    expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toMatchObject({
      page: "1",
      per_page: "1",
      scope: "all",
      state: "all",
    });
  });

  test("keeps a missing total as a request-bounded lower bound", async () => {
    const { client } = clientWithResponses([jsonResponse([{}])]);

    await expect(collectGitLabIssueMetric(client, { sourceId: "42" })).resolves.toMatchObject({
      observation: {
        kind: "at-least",
        value: 1,
        reason: "request-budget",
        scope: GITLAB_ISSUES_SCOPE,
      },
    });
  });

  test.each<{ data: unknown[]; headers: Record<string, string> }>([
    { data: [], headers: { "X-Total": "0", "X-Next-Page": "2" } },
    { data: [{}], headers: { "X-Total": "1", "X-Total-Pages": "2" } },
    { data: [], headers: { "X-Total-Pages": "2" } },
  ])(
    "keeps contradictory pagination unavailable with scoped provenance (%j)",
    async ({ data, headers }) => {
      const { client } = clientWithResponses([jsonResponse(data, headers)]);

      await expect(collectGitLabIssueMetric(client, { sourceId: "42" })).resolves.toMatchObject({
        provider: "gitlab",
        endpointFamily: "project-issues",
        observation: {
          kind: "unavailable",
          reason: "malformed",
          scope: GITLAB_ISSUES_SCOPE,
        },
      });
    },
  );

  test("preserves permission denial instead of reporting zero", async () => {
    const { client } = clientWithResponses([new Response(null, { status: 403 })]);

    await expect(collectGitLabIssueMetric(client, { sourceId: "42" })).resolves.toMatchObject({
      observation: {
        kind: "unavailable",
        reason: "forbidden",
        scope: GITLAB_ISSUES_SCOPE,
      },
    });
  });
});

describe("GitLab repository metric collectors", () => {
  test("records merge requests from the explicit all-state, all-author scope", async () => {
    const { calls, client } = clientWithResponses([jsonResponse([{}], { "X-Total": "7" })]);

    const metric = await collectGitLabMergeRequestMetric(client, { sourceId: "42" });

    expect(metric.observation).toEqual({
      kind: "exact",
      value: 7,
      basis: "reported",
      scope: GITLAB_MERGE_REQUESTS_SCOPE,
    });
    expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toMatchObject({
      scope: "all",
      state: "all",
    });
  });

  test("enumerates branches, tags, and releases to their terminal pages", async () => {
    const { client } = clientWithResponses([
      jsonResponse([{}, {}], { "X-Next-Page": "2", "X-Total": "3" }),
      jsonResponse([{}], { "X-Next-Page": "", "X-Total": "3" }),
      jsonResponse([{}]),
      jsonResponse([]),
    ]);

    await expect(collectGitLabBranchMetric(client, { sourceId: "42" })).resolves.toMatchObject({
      observation: { kind: "exact", value: 3, basis: "enumerated", scope: GITLAB_BRANCHES_SCOPE },
    });
    await expect(collectGitLabTagMetric(client, { sourceId: "42" })).resolves.toMatchObject({
      observation: { kind: "exact", value: 1, basis: "enumerated", scope: GITLAB_TAGS_SCOPE },
    });
    await expect(collectGitLabReleaseMetric(client, { sourceId: "42" })).resolves.toMatchObject({
      observation: { kind: "exact", value: 0, basis: "enumerated", scope: GITLAB_RELEASES_SCOPE },
    });
  });

  test("keeps a release count unavailable when a terminal header disagrees with Link", async () => {
    const { client, calls } = clientWithResponses([
      jsonResponse([{}], { "X-Next-Page": "2" }),
      jsonResponse([{}], { "X-Next-Page": "", Link: '<?page=3>; rel="next"' }),
    ]);

    await expect(collectGitLabReleaseMetric(client, { sourceId: "42" })).resolves.toMatchObject({
      observation: { kind: "unavailable", reason: "malformed", scope: GITLAB_RELEASES_SCOPE },
    });
    expect(calls.map((call) => call.searchParams.get("page"))).toEqual(["1", "2"]);
  });

  test.each([
    [collectGitLabBranchMetric, "repository-branches", GITLAB_BRANCHES_SCOPE],
    [collectGitLabTagMetric, "repository-tags", GITLAB_TAGS_SCOPE],
    [collectGitLabReleaseMetric, "project-releases", GITLAB_RELEASES_SCOPE],
  ] as const)("explains rejected enumeration for %s", async (collect, endpointFamily, scope) => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { client } = clientWithResponses([
        jsonResponse([{}], { "X-Total": "private-provider-payload" }),
      ]);

      await expect(collect(client, { sourceId: "private-project" })).resolves.toMatchObject({
        endpointFamily,
        observation: { kind: "unavailable", reason: "malformed", scope },
      });
      expect(warn.mock.calls).toEqual([
        [
          `[gitlab] ${endpointFamily} count unavailable: GitLab API returned an invalid X-Total header`,
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test.each([
    [collectGitLabTagMetric, GITLAB_TAGS_SCOPE],
    [collectGitLabReleaseMetric, GITLAB_RELEASES_SCOPE],
  ] as const)("enumerates without X-Total for %s", async (collect, scope) => {
    const { client, calls } = clientWithResponses([
      jsonResponse([{}], { "X-Next-Page": "2" }),
      jsonResponse([{}, {}], { "X-Next-Page": "" }),
    ]);

    await expect(collect(client, { sourceId: "42" })).resolves.toMatchObject({
      observation: { kind: "exact", value: 3, basis: "enumerated", scope },
    });
    expect(calls.map((call) => call.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(client.getApiCalls()).toBe(2);
  });

  test("counts commits reachable from the reported default-branch head SHA", async () => {
    const { calls, client } = clientWithResponses([
      jsonResponse({ commit: { id: "abc123" } }),
      jsonResponse({ count: 12 }),
    ]);

    const metric = await collectGitLabCommitMetric(client, {
      sourceId: "42",
      defaultBranch: "main",
    });

    expect(metric.observation).toEqual({
      kind: "exact",
      value: 12,
      basis: "reported",
      scope: GITLAB_COMMITS_SCOPE,
    });
    expect(calls.map((call) => call.pathname)).toEqual([
      "/api/v4/projects/42/repository/branches/main",
      "/api/v4/projects/42/repository/commits/abc123/sequence",
    ]);
  });

  test("distinguishes an authoritative empty repository from an unknown default branch", async () => {
    const { client } = clientWithResponses([]);

    await expect(
      collectGitLabCommitMetric(client, {
        sourceId: "42",
        defaultBranch: null,
        providerDetails: { provider: "gitlab", emptyRepository: true },
      }),
    ).resolves.toMatchObject({
      observation: { kind: "exact", value: 0, basis: "enumerated" },
    });
    await expect(
      collectGitLabCommitMetric(client, { sourceId: "43", defaultBranch: null }),
    ).resolves.toMatchObject({
      observation: { kind: "unavailable", reason: "not-reported" },
    });
  });

  test("preserves malformed and forbidden commit observations instead of reporting zero", async () => {
    const malformed = clientWithResponses([jsonResponse({ commit: {} })]).client;
    await expect(
      collectGitLabCommitMetric(malformed, { sourceId: "42", defaultBranch: "main" }),
    ).resolves.toMatchObject({
      observation: { kind: "unavailable", reason: "malformed" },
    });

    const forbidden = clientWithResponses([new Response(null, { status: 403 })]).client;
    await expect(
      collectGitLabCommitMetric(forbidden, { sourceId: "42", defaultBranch: "main" }),
    ).resolves.toMatchObject({
      observation: { kind: "unavailable", reason: "forbidden" },
    });
  });
});

describe("collectGitLabProfileEnrichment", () => {
  test("collects all repository metrics for every inventory project in stable order", async () => {
    const web: Record<string, Response> = {
      issues: jsonResponse([{}], { "X-Total": "3" }),
      merge_requests: jsonResponse([{}], { "X-Total": "1" }),
      "repository/branches": jsonResponse([{}, {}]),
      "repository/tags": jsonResponse([{}]),
      releases: jsonResponse([{}]),
      protected_branches: jsonResponse([{ name: "main" }]),
      protected_tags: jsonResponse([{ name: "v*" }]),
      hooks: jsonResponse([]),
      approval_rules: jsonResponse([]),
      members: jsonResponse([]),
      "members/all": jsonResponse([]),
      remote_mirrors: jsonResponse([]),
      "mirror/pull": jsonResponse({ enabled: false }),
      packages: jsonResponse([]),
      "registry/repositories": jsonResponse([]),
    };
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      token: "secret-token",
      maxRetries: 0,
      fetch: async (input) => {
        const { pathname } = new URL(input.toString());
        if (pathname === "/api/v4/groups/platform/hooks") return jsonResponse([]);
        // Variables are counted from the pagination headers of metadata-only requests.
        if (pathname === "/api/v4/groups/platform/variables") {
          return new Response(null, { headers: { "X-Total": "4" } });
        }
        if (/^\/api\/v4\/projects\/\d+\/variables$/.test(pathname)) {
          return new Response(null, {
            headers: { "X-Total": pathname.includes("/2/") ? "2" : "0" },
          });
        }
        if (/^\/api\/v4\/groups\/platform\/members(?:\/all)?$/.test(pathname))
          return jsonResponse([]);
        if (pathname === "/api/v4/groups/platform/protected_branches") {
          return new Response(null, { status: 404 });
        }
        const ci = /^\/api\/v4\/projects\/(\d+)$/.exec(pathname)?.[1];
        if (ci) return jsonResponse({ ci_config_path: null, auto_devops_enabled: ci === "2" });
        const [, project, collection] = /^\/api\/v4\/projects\/(\d+)\/(.+)$/.exec(pathname) ?? [];
        if (project === "1") {
          return /^(issues|merge_requests)$/.test(collection ?? "")
            ? jsonResponse([], { "X-Total": "0" })
            : jsonResponse([]);
        }
        const response = project === "2" && collection ? web[collection] : undefined;
        if (!response) throw new Error(`unexpected fetch ${pathname}`);
        return response;
      },
    });

    const enrichment = await collectGitLabProfileEnrichment(
      client,
      {
        version: 1,
        provider: "gitlab",
        sourceApiUrl: "https://gitlab.example.com/api/v4",
        namespace: "platform",
        projectCount: { kind: "exact", value: 2 },
        projects: [
          {
            provider: "gitlab",
            sourceId: "1",
            path: "platform/api",
            name: "api",
            visibility: "private",
            archived: false,
            defaultBranch: null,
            lastActivityAt: null,
            repositorySizeBytes: { kind: "exact", value: 0 },
            storageSizeBytes: { kind: "exact", value: 0 },
            lfsObjectsSizeBytes: { kind: "exact", value: 0 },
            packagesSizeBytes: { kind: "exact", value: 0 },
            wikiSizeBytes: { kind: "exact", value: 0 },
            uploadsSizeBytes: { kind: "exact", value: 0 },
            jobArtifactsSizeBytes: { kind: "unavailable", reason: "not-reported" },
            pipelineArtifactsSizeBytes: { kind: "unavailable", reason: "not-reported" },
            snippetsSizeBytes: { kind: "unavailable", reason: "not-reported" },
            containerRegistrySizeBytes: { kind: "unavailable", reason: "not-reported" },
            providerDetails: { provider: "gitlab", emptyRepository: true },
          },
          {
            provider: "gitlab",
            sourceId: "2",
            path: "platform/web",
            name: "web",
            visibility: "private",
            archived: false,
            defaultBranch: null,
            lastActivityAt: null,
            repositorySizeBytes: { kind: "exact", value: 0 },
            storageSizeBytes: { kind: "exact", value: 0 },
            lfsObjectsSizeBytes: { kind: "exact", value: 0 },
            packagesSizeBytes: { kind: "exact", value: 0 },
            wikiSizeBytes: { kind: "exact", value: 0 },
            uploadsSizeBytes: { kind: "exact", value: 0 },
            jobArtifactsSizeBytes: { kind: "unavailable", reason: "not-reported" },
            pipelineArtifactsSizeBytes: { kind: "unavailable", reason: "not-reported" },
            snippetsSizeBytes: { kind: "unavailable", reason: "not-reported" },
            containerRegistrySizeBytes: { kind: "unavailable", reason: "not-reported" },
            providerDetails: { provider: "gitlab", emptyRepository: true },
          },
        ],
      },
      { concurrency: 1, nowMs: Date.parse("2026-08-10T12:00:00Z") },
    );

    expect(enrichment).toMatchObject({
      version: 2,
      provider: "gitlab",
      sourceApiUrl: "https://gitlab.example.com/api/v4",
      namespace: "platform",
    });
    expect(enrichment.projects.map((project) => project.path)).toEqual([
      "platform/api",
      "platform/web",
    ]);
    expect(enrichment.projects.map((project) => project.metrics.issues.observation)).toEqual([
      {
        kind: "exact",
        value: 0,
        basis: "reported",
        scope: GITLAB_ISSUES_SCOPE,
      },
      {
        kind: "exact",
        value: 3,
        basis: "reported",
        scope: GITLAB_ISSUES_SCOPE,
      },
    ]);
    expect(enrichment.projects[1]?.metrics).toMatchObject({
      mergeRequests: { observation: { kind: "exact", value: 1, basis: "reported" } },
      commits: { observation: { kind: "exact", value: 0, basis: "enumerated" } },
      branches: { observation: { kind: "exact", value: 2, basis: "enumerated" } },
      tags: { observation: { kind: "exact", value: 1, basis: "enumerated" } },
      releases: { observation: { kind: "exact", value: 1, basis: "enumerated" } },
      // Without group rules or inheritance flags, "main" cannot be classified as the project's.
      protectedBranches: { observation: { kind: "unavailable", reason: "not-reported" } },
      inheritedProtectedBranches: { observation: { kind: "unavailable", reason: "not-reported" } },
      protectedTags: { observation: { kind: "exact", value: 1, basis: "enumerated" } },
      ciConfiguration: { observation: { kind: "exact", value: 1, basis: "reported" } },
      ciVariables: {
        observation: { kind: "exact", value: 2, basis: "reported" },
        groupLocal: { kind: "exact", value: 4, basis: "reported" },
      },
    });
    expect(enrichment.projects[0]?.metrics.ciConfiguration.observation).toMatchObject({
      kind: "exact",
      value: 0,
    });
  });
});

function budgetInventory(projectCount: number): SourceNamespaceInventory {
  const unavailable = { kind: "unavailable", reason: "not-reported" } as const;
  return {
    version: 1,
    provider: "gitlab",
    sourceApiUrl: "https://gitlab.example.com/api/v4",
    namespace: "platform",
    projectCount: { kind: "exact", value: projectCount },
    projects: Array.from({ length: projectCount }, (_, index) => ({
      provider: "gitlab" as const,
      sourceId: String(index + 1),
      path: `platform/project-${index + 1}`,
      name: `project-${index + 1}`,
      visibility: "private" as const,
      archived: false,
      defaultBranch: "main",
      lastActivityAt: null,
      repositorySizeBytes: unavailable,
      storageSizeBytes: unavailable,
      lfsObjectsSizeBytes: unavailable,
      packagesSizeBytes: unavailable,
      wikiSizeBytes: unavailable,
      uploadsSizeBytes: unavailable,
      jobArtifactsSizeBytes: unavailable,
      pipelineArtifactsSizeBytes: unavailable,
      snippetsSizeBytes: unavailable,
      containerRegistrySizeBytes: unavailable,
      providerDetails: { provider: "gitlab" as const },
    })),
  };
}

describe("GitLab registry access during a profile", () => {
  test.each([
    [401, "forbidden"],
    [403, "forbidden"],
    [404, "not-reported"],
  ] as const)(
    "continues collecting selected projects after registry HTTP %i",
    async (status, reason) => {
      const registryPaths: string[] = [];
      const client = new GitLabClient({
        baseUrl: "https://gitlab.example.com",
        token: "offline-fixture",
        maxRetries: 0,
        fetch: async (input) => {
          const { pathname } = new URL(input.toString());
          if (pathname.endsWith("/registry/repositories")) {
            registryPaths.push(pathname);
            return pathname === "/api/v4/projects/1/registry/repositories"
              ? Response.json({ message: "Registry unavailable for this subscription" }, { status })
              : jsonResponse([{ id: 2, tags_count: 7 }]);
          }
          if (pathname.endsWith("/sequence")) return jsonResponse({ count: 4 });
          if (pathname.endsWith("/repository/branches/main")) {
            return jsonResponse({ commit: { id: "abc123" } });
          }
          return jsonResponse([]);
        },
      });
      const { projects } = await collectGitLabProfileEnrichment(client, budgetInventory(2));
      expect(registryPaths.sort()).toEqual([
        "/api/v4/projects/1/registry/repositories",
        "/api/v4/projects/2/registry/repositories",
      ]);
      expect(projects[0]?.metrics.containerRegistry).toMatchObject({
        observation: { kind: "unavailable", reason },
        tags: { kind: "unavailable", reason },
      });
      expect(projects[1]?.metrics.containerRegistry).toMatchObject({
        observation: { kind: "exact", value: 1 },
        tags: { kind: "exact", value: 7 },
      });
      expect(projects.map(({ metrics }) => metrics.commits.observation)).toEqual([
        expect.objectContaining({ kind: "exact", value: 4 }),
        expect.objectContaining({ kind: "exact", value: 4 }),
      ]);
      expect(JSON.stringify(projects)).not.toContain("subscription");
    },
  );
});

describe("GitLab merge request approval policy collection", () => {
  const project = { sourceId: "platform/project" };

  async function profileWithRestrictedApprovalRules(restriction: Response) {
    const approvalPaths: string[] = [];
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      token: "offline-fixture",
      maxRetries: 0,
      fetch: async (input) => {
        const { pathname } = new URL(input.toString());
        if (pathname.endsWith("/approval_rules")) {
          approvalPaths.push(pathname);
          if (pathname === "/api/v4/projects/1/approval_rules") return restriction;
        }
        if (pathname.endsWith("/sequence")) return jsonResponse({ count: 4 });
        if (pathname.endsWith("/repository/branches/main")) {
          return jsonResponse({ commit: { id: "abc123" } });
        }
        return jsonResponse([]);
      },
    });
    const { projects } = await collectGitLabProfileEnrichment(client, budgetInventory(2));
    expect(approvalPaths.sort()).toEqual([
      "/api/v4/projects/1/approval_rules",
      "/api/v4/projects/2/approval_rules",
    ]);
    expect(projects[1]?.metrics.approvalRules).toMatchObject({
      observation: { kind: "exact", value: 0 },
      requiresApprovals: false,
      hasRequiredProtectedBranchRules: false,
    });
    for (const { metrics } of projects) {
      expect(metrics.commits.observation).toMatchObject({ kind: "exact", value: 4 });
    }
    return projects[0]?.metrics.approvalRules;
  }

  test.each([
    [401, "forbidden"],
    [403, "forbidden"],
    [404, "not-reported"],
  ] as const)("continues after approval-rule HTTP %i with %s", async (status, reason) => {
    const rules = await profileWithRestrictedApprovalRules(new Response(null, { status }));
    expect(rules).toMatchObject({
      observation: { kind: "unavailable", reason },
      requiresApprovals: null,
      hasRequiredProtectedBranchRules: null,
    });
  });

  test("does not mistake the paid-tier-only approval rules endpoint for a project with no policy", async () => {
    const rules = await profileWithRestrictedApprovalRules(
      Response.json({ message: "Approval rules require Premium or Ultimate" }, { status: 404 }),
    );
    expect(rules).toMatchObject({
      observation: { kind: "unavailable", reason: "not-reported" },
      requiresApprovals: null,
      hasRequiredProtectedBranchRules: null,
    });
    expect(JSON.stringify(rules)).not.toContain("Premium");
  });

  test("counts every visible rule but stores only the presence of requirements and protected scope", async () => {
    const { client, calls } = clientWithResponses([
      jsonResponse([{ id: 8, approvals_required: 0 }], { "X-Next-Page": "2" }),
      jsonResponse([
        {
          id: 9,
          name: "discard-rule-name",
          approvals_required: 2,
          applies_to_all_protected_branches: false,
          protected_branches: [{ id: 3, name: "discard-branch-name" }],
          eligible_approvers: [{ username: "discard-identity" }],
          users: [{ username: "discard-user" }],
          groups: [{ name: "discard-group" }],
        },
      ]),
    ]);

    const rules = await collectGitLabApprovalRuleMetric(client, project, {
      nowMs: Date.parse("2026-08-10T12:00:00Z"),
    });

    expect(rules).toEqual({
      provider: "gitlab",
      endpointFamily: "project-approval-rules",
      collectedAt: "2026-08-10T12:00:00.000Z",
      observation: {
        kind: "exact",
        value: 2,
        basis: "enumerated",
        scope: expect.stringContaining("visible via the project endpoint"),
      },
      requiresApprovals: true,
      hasRequiredProtectedBranchRules: true,
    });
    expect(calls.map(({ pathname, searchParams }) => [pathname, searchParams.get("page")])).toEqual(
      [
        ["/api/v4/projects/platform%2Fproject/approval_rules", "1"],
        ["/api/v4/projects/platform%2Fproject/approval_rules", "2"],
      ],
    );
  });

  test.each([
    [{ approvals_required: 0, applies_to_all_protected_branches: true }, false, false],
    [{ approvals_required: 2, applies_to_all_protected_branches: true }, true, true],
    [
      { approvals_required: 2, applies_to_all_protected_branches: false, protected_branches: [] },
      true,
      false,
    ],
    [{ approvals_required: 2 }, true, null],
  ] as const)(
    "keeps explicit protected branch scope separate from a positive approval threshold (%j)",
    async (rule, requiresApprovals, hasRequiredProtectedBranchRules) => {
      const { client } = clientWithResponses([jsonResponse([{ id: 1, ...rule }])]);
      expect(await collectGitLabApprovalRuleMetric(client, project)).toMatchObject({
        observation: { kind: "exact", value: 1 },
        requiresApprovals,
        hasRequiredProtectedBranchRules,
      });
    },
  );

  test("keeps a budget-bounded count without inferring the remaining rules are optional", async () => {
    const { client, calls } = clientWithResponses([
      jsonResponse([{ id: 1, approvals_required: 0 }], { "X-Next-Page": "2" }),
    ]);
    const result = await collectGitLabApprovalRuleMetric(client, project, { apiCallCeiling: 1 });
    expect(result).toMatchObject({
      observation: { kind: "at-least", value: 1, reason: "request-budget" },
      requiresApprovals: null,
      hasRequiredProtectedBranchRules: null,
    });
    expect(calls).toHaveLength(1);
  });

  test("retains affirmative evidence when access is denied on a later page", async () => {
    const { client } = clientWithResponses([
      jsonResponse([{ id: 1, approvals_required: 2, applies_to_all_protected_branches: true }], {
        "X-Next-Page": "2",
      }),
      new Response(null, { status: 403 }),
    ]);
    expect(await collectGitLabApprovalRuleMetric(client, project)).toMatchObject({
      observation: {
        kind: "at-least",
        value: 1,
        reason: "pagination-uncertain",
        scope: expect.stringContaining("forbidden"),
      },
      requiresApprovals: true,
      hasRequiredProtectedBranchRules: true,
    });
  });

  test("does not treat contradictory rule identities as an exact or partial observation", async () => {
    const repeatedRule = { id: 1, approvals_required: 2, applies_to_all_protected_branches: true };
    const { client } = clientWithResponses([
      jsonResponse([repeatedRule], { "X-Next-Page": "2" }),
      jsonResponse([repeatedRule]),
    ]);
    expect(await collectGitLabApprovalRuleMetric(client, project)).toMatchObject({
      observation: { kind: "unavailable", reason: "malformed" },
      requiresApprovals: null,
      hasRequiredProtectedBranchRules: null,
    });
  });

  test("propagates an unexpected server failure rather than treating it as missing policy", async () => {
    const { client } = clientWithResponses([new Response(null, { status: 503 })]);
    await expect(collectGitLabApprovalRuleMetric(client, project)).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("GitLab repository mirror inventory", () => {
  const project = {
    sourceId: "platform/project",
    path: "platform/project",
    defaultBranch: null,
  };

  async function profileWithMirrors(fixtures: Record<string, Response>) {
    const calls: string[] = [];
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      token: "offline-fixture",
      maxRetries: 0,
      fetch: async (input, init) => {
        const { pathname } = new URL(input.toString());
        const mirror = /^\/api\/v4\/projects\/(.+\/(?:remote_mirrors|mirror\/pull))$/.exec(
          pathname,
        )?.[1];
        if (mirror) {
          expect(init?.method).toBe("GET");
          calls.push(mirror);
          const response = fixtures[mirror];
          if (!response) throw new Error(`unexpected mirror read: ${pathname}`);
          return response;
        }
        if (pathname.endsWith("/sequence")) return jsonResponse({ count: 4 });
        if (pathname.endsWith("/repository/branches/main")) {
          return jsonResponse({ commit: { id: "abc123" } });
        }
        return jsonResponse([]);
      },
    });
    const { projects } = await collectGitLabProfileEnrichment(client, budgetInventory(2));
    expect(projects[0]?.metrics.commits.observation).toMatchObject({ kind: "exact", value: 4 });
    expect(projects[1]?.metrics.commits.observation).toMatchObject({ kind: "exact", value: 4 });
    return { mirrors: projects.map(({ metrics }) => metrics.mirrors), calls };
  }

  test("reports push-only and pull-only dependencies independently without retaining configuration", async () => {
    const discarded = {
      url: "https://mirror.invalid/example",
      auth_method: "discard-auth-method",
      last_error: "discard-provider-error",
    };
    const { mirrors, calls } = await profileWithMirrors({
      "1/remote_mirrors": jsonResponse([
        { id: 8, enabled: true, ...discarded },
        { id: 9, enabled: false, ...discarded },
      ]),
      "1/mirror/pull": Response.json({ message: "The project is not mirrored" }, { status: 400 }),
      "2/remote_mirrors": jsonResponse([]),
      "2/mirror/pull": jsonResponse({ id: 6, enabled: true, ...discarded }),
    });

    expect(mirrors).toMatchObject([
      {
        observation: { kind: "exact", value: 1 },
        hasDisabledPushMirrors: true,
        pullMirror: { kind: "not-mirrored" },
      },
      {
        observation: { kind: "exact", value: 0 },
        hasDisabledPushMirrors: false,
        pullMirror: { kind: "enabled" },
      },
    ]);
    expect(calls.sort()).toEqual([
      "1/mirror/pull",
      "1/remote_mirrors",
      "2/mirror/pull",
      "2/remote_mirrors",
    ]);
    expect(JSON.stringify(mirrors)).not.toMatch(/mirror\.invalid|discard-|project is not mirrored/);
  });

  test.each([
    [401, "forbidden"],
    [403, "forbidden"],
    [404, "not-reported"],
  ] as const)(
    "keeps the other direction and project available after HTTP %i",
    async (status, reason) => {
      const { mirrors } = await profileWithMirrors({
        "1/remote_mirrors": new Response(null, { status }),
        "1/mirror/pull": jsonResponse({ enabled: true }),
        "2/remote_mirrors": jsonResponse([{ id: 8, enabled: false }]),
        "2/mirror/pull": new Response(null, { status }),
      });

      expect(mirrors).toMatchObject([
        {
          observation: { kind: "unavailable", reason },
          hasDisabledPushMirrors: null,
          pullMirror: { kind: "enabled" },
        },
        {
          observation: { kind: "exact", value: 0 },
          hasDisabledPushMirrors: true,
          pullMirror: { kind: "unavailable", reason },
        },
      ]);
    },
  );

  test("does not mistake unlicensed pull mirroring for observed absence or a disabled mirror", async () => {
    const { mirrors } = await profileWithMirrors({
      "1/remote_mirrors": jsonResponse([]),
      "1/mirror/pull": Response.json(
        { message: "Pull mirroring requires Premium" },
        { status: 403 },
      ),
      "2/remote_mirrors": jsonResponse([]),
      "2/mirror/pull": jsonResponse({ enabled: false }),
    });

    expect(mirrors[0]?.pullMirror).toEqual({ kind: "unavailable", reason: "forbidden" });
    expect(mirrors[1]?.pullMirror).toEqual({ kind: "disabled" });
  });

  test("counts enabled push mirrors across pages without going over the shared budget for pull", async () => {
    const { client, calls } = clientWithResponses([
      jsonResponse([{ id: 8, enabled: true }], { "X-Next-Page": "2" }),
      jsonResponse([
        { id: 9, enabled: false },
        { id: 10, enabled: true },
      ]),
    ]);

    await expect(
      mirrorsCollector.collect(client, project, { apiCallCeiling: 2 }),
    ).resolves.toMatchObject({
      observation: { kind: "exact", value: 2, basis: "enumerated" },
      hasDisabledPushMirrors: true,
      pullMirror: { kind: "unavailable", reason: "request-budget" },
    });
    expect(calls.map((url) => [url.pathname, url.searchParams.get("page")])).toEqual([
      ["/api/v4/projects/platform%2Fproject/remote_mirrors", "1"],
      ["/api/v4/projects/platform%2Fproject/remote_mirrors", "2"],
    ]);
  });

  test("keeps a lower bound when budget stops push enumeration before the final page", async () => {
    const { client, calls } = clientWithResponses([
      jsonResponse([{ id: 8, enabled: true }], { "X-Next-Page": "2" }),
    ]);

    await expect(
      mirrorsCollector.collect(client, project, { apiCallCeiling: 1 }),
    ).resolves.toMatchObject({
      observation: { kind: "at-least", value: 1, reason: "request-budget" },
      hasDisabledPushMirrors: null,
      pullMirror: { kind: "unavailable", reason: "request-budget" },
    });
    expect(calls).toHaveLength(1);
  });

  test("preserves affirmative push evidence when a later page is forbidden", async () => {
    const { client } = clientWithResponses([
      jsonResponse(
        [
          { id: 8, enabled: true },
          { id: 9, enabled: false },
        ],
        { "X-Next-Page": "2" },
      ),
      new Response(null, { status: 403 }),
      jsonResponse({ enabled: true }),
    ]);

    await expect(mirrorsCollector.collect(client, project)).resolves.toMatchObject({
      observation: {
        kind: "at-least",
        value: 1,
        reason: "pagination-uncertain",
        scope: expect.stringContaining("forbidden"),
      },
      hasDisabledPushMirrors: true,
      pullMirror: { kind: "enabled" },
    });
  });

  test("does not treat duplicate push entries or a missing pull state as measured absence", async () => {
    const { client } = clientWithResponses([
      jsonResponse([{ id: 8, enabled: false }], { "X-Next-Page": "2" }),
      jsonResponse([{ id: 8, enabled: false }]),
      jsonResponse({}),
    ]);

    await expect(mirrorsCollector.collect(client, project)).resolves.toMatchObject({
      observation: { kind: "unavailable", reason: "malformed" },
      hasDisabledPushMirrors: null,
      pullMirror: { kind: "unavailable", reason: "malformed" },
    });
  });

  test("propagates an unexpected mirror endpoint failure after the client's retries", async () => {
    const { client } = clientWithResponses([jsonResponse([]), new Response(null, { status: 503 })]);
    await expect(mirrorsCollector.collect(client, project)).rejects.toMatchObject({ status: 503 });
  });
});

/** A GitLab whose first attempt at every URL fails transiently, so retries are exercised. */
function flakyGitLab(options: { maxRetries?: number } = {}) {
  const seen = new Set<string>();
  const requests: string[] = [];
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.com",
    token: "secret-token",
    maxRetries: options.maxRetries ?? 2,
    sleep: async () => {},
    fetch: async (input) => {
      const url = new URL(input.toString());
      requests.push(url.pathname + url.search);
      await Bun.sleep(1);
      if (!seen.has(url.href)) {
        seen.add(url.href);
        return new Response(null, { status: 503 });
      }
      if (url.pathname.endsWith("/sequence")) return jsonResponse({ count: 7 });
      if (url.pathname.includes("/repository/branches/main")) {
        return jsonResponse({ commit: { id: "abc123" } });
      }
      if (/\/projects\/\d+$/.test(url.pathname)) {
        return jsonResponse({ ci_config_path: null, auto_devops_enabled: false });
      }
      if (/\/(issues|merge_requests)$/.test(url.pathname)) {
        return jsonResponse([{}], { "X-Total": "2" });
      }
      if (/\/protected_(branches|tags)$/.test(url.pathname)) {
        return jsonResponse([{ name: "main" }]);
      }
      return jsonResponse([{}]);
    },
  });
  return { client, requests };
}

describe("GitLab profile request budget", () => {
  test("shares one budget across workers, metrics and retries without overshooting", async () => {
    const { client, requests } = flakyGitLab();
    const budget = 11;

    const enrichment = await collectGitLabProfileEnrichment(client, budgetInventory(4), {
      concurrency: 4,
      requestBudget: budget,
    });

    expect(requests).toHaveLength(budget);
    expect(client.getApiCalls()).toBe(budget);
    const observations = enrichment.projects.flatMap((project) =>
      Object.values(project.metrics).map((metric) => metric.observation),
    );
    expect(observations).toHaveLength(4 * GITLAB_PROFILE_METRIC_KEYS.length);
    expect(
      observations.some((o) => o.kind === "unavailable" && o.reason === "request-budget"),
    ).toBe(true);
    for (const observation of observations) {
      if (observation.kind === "unavailable") expect(observation.reason).toBe("request-budget");
    }
  });

  test("counts the budget from the call counter at the start of enrichment", async () => {
    const { client, requests } = flakyGitLab();
    await client.get("/version");
    await client.get("/version");
    expect(client.getApiCalls()).toBe(3); // one transient retry plus the success

    await collectGitLabProfileEnrichment(client, budgetInventory(2), { requestBudget: 5 });

    expect(requests).toHaveLength(3 + 5);
    expect(client.getApiCalls()).toBe(3 + 5);
  });

  test("records every metric unavailable for request-budget when the budget is zero", async () => {
    const { client, requests } = flakyGitLab();

    const enrichment = await collectGitLabProfileEnrichment(client, budgetInventory(2), {
      requestBudget: 0,
      nowMs: Date.parse("2026-08-10T12:00:00Z"),
    });

    expect(requests).toEqual([]);
    expect(enrichment.projects).toHaveLength(2);
    for (const { metrics } of enrichment.projects) {
      expect(Object.keys(metrics).sort()).toEqual([...GITLAB_PROFILE_METRIC_KEYS].sort());
      for (const metric of Object.values(metrics)) {
        expect(metric.observation).toMatchObject({ kind: "unavailable", reason: "request-budget" });
        expect(metric.collectedAt).toBe("2026-08-10T12:00:00.000Z");
      }
      for (const scope of metrics.members.scopes) {
        expect(scope.direct.observation).toMatchObject({
          kind: "unavailable",
          reason: "request-budget",
        });
        expect(scope.effective.observation).toMatchObject({
          kind: "unavailable",
          reason: "request-budget",
        });
      }
    }
  });

  test("keeps the items already counted as a lower bound when pagination runs out of budget", async () => {
    const { client, calls } = clientWithResponses([
      jsonResponse(
        Array.from({ length: 100 }, () => ({})),
        { "X-Next-Page": "2" },
      ),
    ]);

    const metric = await collectGitLabBranchMetric(
      client,
      { sourceId: "42" },
      { apiCallCeiling: client.getApiCalls() + 1 },
    );

    expect(calls).toHaveLength(1);
    expect(metric.observation).toEqual({
      kind: "at-least",
      value: 100,
      reason: "request-budget",
      scope: GITLAB_BRANCHES_SCOPE,
    });
  });

  test("keeps a valid head commit as an at-least-one count when the sequence request is out of budget", async () => {
    const { client, calls } = clientWithResponses([jsonResponse({ commit: { id: "abc123" } })]);

    const metric = await collectGitLabCommitMetric(
      client,
      { sourceId: "42", defaultBranch: "main" },
      { apiCallCeiling: client.getApiCalls() + 1 },
    );

    expect(calls).toHaveLength(1);
    expect(metric.observation).toEqual({
      kind: "at-least",
      value: 1,
      reason: "request-budget",
      scope: GITLAB_COMMITS_SCOPE,
    });
  });

  test.each(["", " ", "\t\n  "])(
    "does not treat a blank head commit id (%j) as evidence, even from the last allowed lookup",
    async (id) => {
      const { client, calls } = clientWithResponses([jsonResponse({ commit: { id } })]);

      const metric = await collectGitLabCommitMetric(
        client,
        { sourceId: "42", defaultBranch: "main" },
        { apiCallCeiling: client.getApiCalls() + 1 },
      );

      expect(calls).toHaveLength(1);
      expect(metric.observation).toEqual({
        kind: "unavailable",
        reason: "malformed",
        scope: GITLAB_COMMITS_SCOPE,
      });
    },
  );

  test("marks the commit count unavailable when the head lookup itself is out of budget", async () => {
    const { client, calls } = clientWithResponses([]);

    const metric = await collectGitLabCommitMetric(
      client,
      { sourceId: "42", defaultBranch: "main" },
      { apiCallCeiling: client.getApiCalls() },
    );

    expect(calls).toEqual([]);
    expect(metric.observation).toMatchObject({ kind: "unavailable", reason: "request-budget" });
  });

  test("marks counted collections unavailable when no budget remains", async () => {
    const { client, calls } = clientWithResponses([]);
    const options = { apiCallCeiling: client.getApiCalls() };

    for (const metric of await Promise.all([
      collectGitLabIssueMetric(client, { sourceId: "42" }, options),
      collectGitLabMergeRequestMetric(client, { sourceId: "42" }, options),
      collectGitLabTagMetric(client, { sourceId: "42" }, options),
      collectGitLabReleaseMetric(client, { sourceId: "42" }, options),
    ])) {
      expect(metric.observation).toMatchObject({ kind: "unavailable", reason: "request-budget" });
    }
    expect(calls).toEqual([]);
  });

  test("still fails the profile on expired authentication instead of hiding it as unavailable", async () => {
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      token: "secret-token",
      maxRetries: 0,
      fetch: async () => new Response(null, { status: 401 }),
    });

    const failure = await collectGitLabProfileEnrichment(client, budgetInventory(1), {
      requestBudget: 50,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitLabApiError);
    expect((failure as GitLabApiError).status).toBe(401);
  });

  test("records a 401 from the optional CI probe while required metrics still succeed", async () => {
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      token: "secret-token",
      maxRetries: 0,
      fetch: async (input) => {
        const { pathname } = new URL(input.toString());
        if (pathname.endsWith("/projects/1")) return new Response(null, { status: 401 });
        if (pathname.endsWith("/sequence")) return jsonResponse({ count: 4 });
        if (pathname.endsWith("/repository/branches/main")) {
          return jsonResponse({ commit: { id: "abc123" } });
        }
        return jsonResponse([], { "X-Total": "0" });
      },
    });

    const enrichment = await collectGitLabProfileEnrichment(client, budgetInventory(1), {
      requestBudget: 50,
    });

    const metrics = enrichment.projects[0]?.metrics;
    expect(metrics?.ciConfiguration.observation).toMatchObject({
      kind: "unavailable",
      reason: "forbidden",
    });
    expect(metrics?.commits.observation).toMatchObject({ kind: "exact", value: 4 });
  });

  test("does not turn cancellation into an exhausted budget", async () => {
    const { client, requests } = flakyGitLab();
    const controller = new AbortController();
    controller.abort();

    const failure = await collectGitLabProfileEnrichment(client, budgetInventory(1), {
      signal: controller.signal,
      requestBudget: 50,
    }).catch((error: unknown) => error);

    expect(failure).toBeDefined();
    expect(requests).toEqual([]);
  });

  test("lets a shared absolute ceiling override the relative budget", async () => {
    const { client, requests } = flakyGitLab();
    await client.get("/version");
    await client.get("/version");
    const used = client.getApiCalls();

    await collectGitLabProfileEnrichment(client, budgetInventory(2), {
      requestBudget: 1_000,
      apiCallCeiling: used + 2,
    });

    expect(client.getApiCalls()).toBe(used + 2);
    expect(requests).toHaveLength(used + 2);
    await expect(
      collectGitLabProfileEnrichment(client, budgetInventory(1), { apiCallCeiling: -1 }),
    ).rejects.toThrow("GitLab API call ceiling must be a non-negative integer");
  });

  test("rejects an invalid budget and defaults to the configured ceiling", async () => {
    const { client } = flakyGitLab();
    for (const requestBudget of [-1, 1.5, Number.NaN]) {
      await expect(
        collectGitLabProfileEnrichment(client, budgetInventory(1), { requestBudget }),
      ).rejects.toThrow("GitLab profile request budget must be a non-negative integer");
    }
    expect(DEFAULT_GITLAB_PROFILE_REQUEST_BUDGET).toBeGreaterThan(0);
  });
});
