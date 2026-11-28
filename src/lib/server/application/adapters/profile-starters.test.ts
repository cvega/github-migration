import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import { getProfileInventorySummary } from "$lib/server/profile/database/inventories";
import { countProfileRuns, getProfileRun } from "$lib/server/profile/database/runs";
import { profileStore } from "$lib/server/profile/database/schema";
import {
  runBitbucketInventoryProfile,
  runGitLabInventoryProfile,
} from "$lib/server/profile/inventory-runner";
import { startBitbucketServerProfile, startGitLabProfile } from "$lib/server/profile/service";
import { BitbucketServerClient } from "$lib/server/source/bitbucket/client";
import { collectBitbucketProfileEnrichment } from "$lib/server/source/bitbucket/profile";
import { GitLabClient } from "$lib/server/source/gitlab/client";
import { collectGitLabProfileEnrichment } from "$lib/server/source/gitlab/profile";
import type { SourceNamespaceInventory } from "$lib/source/types";
import { gitLabProfileRunnerDeps, profileStarters } from "./profile-starters";

beforeEach(() => initStore(":memory:", [profileStore]));
afterEach(closeStore);

test.each(["gitlab", "bitbucket-server"] as const)(
  "%s keeps the lane until every dispatched enrichment request settles",
  async (provider) => {
    const release = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const attempts: string[] = [];
    const gitlab = provider === "gitlab";
    let pending = 0;
    async function fetch(input: string | URL | Request, init?: RequestInit) {
      const path = new URL(input.toString()).pathname;
      attempts.push(path);
      // Fail one request and hold a sibling even after cancellation. In GitLab,
      // hold a metric from the failed project to exercise its inner fan-out.
      if (path.endsWith(gitlab ? "/1/issues" : "/1/commits")) {
        return new Response(null, { status: 400 });
      }
      if (path.endsWith(gitlab ? "/1/merge_requests" : "/2/commits")) {
        pending++;
        init?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
        await release.promise;
        pending--;
      }
      return Response.json(gitlab ? [] : { values: [], isLastPage: true, totalCount: 0 });
    }
    const options = { baseUrl: "https://source.example", maxRetries: 0, fetch };
    const unavailable = { kind: "unavailable", reason: "not-reported" } as const;
    async function discover(client: { apiUrl: string }, namespace: string) {
      const projects: SourceNamespaceInventory["projects"] = ["1", "2", "3"].map((sourceId) => ({
        provider,
        sourceId,
        name: sourceId,
        path: `${namespace}/${sourceId}`,
        defaultBranch: gitlab ? null : "main",
        archived: false,
        visibility: "private",
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
      }));
      return {
        version: 1,
        provider,
        namespace,
        sourceApiUrl: client.apiUrl,
        projects,
        projectCount: { kind: "exact", value: projects.length },
      } satisfies SourceNamespaceInventory;
    }
    function start(id: string, done = finished.resolve) {
      return gitlab
        ? startGitLabProfile("group", {
            newId: () => id,
            buildSourceClient: () => new GitLabClient({ ...options, token: "fixture" }),
            run: (client, input) =>
              runGitLabInventoryProfile<GitLabClient>(client, input, undefined, {
                discover,
                enrich: (c, inv, opts) =>
                  collectGitLabProfileEnrichment(c, inv, { ...opts, concurrency: 2 }),
              }).finally(done),
          })
        : startBitbucketServerProfile("group", {
            newId: () => id,
            buildSourceClient: () =>
              new BitbucketServerClient({ ...options, username: "fixture", password: "fixture" }),
            run: (client, input) =>
              runBitbucketInventoryProfile(client, input, undefined, {
                discover,
                enrich: collectBitbucketProfileEnrichment,
              }).finally(done),
          });
    }
    start("old");
    await aborted.promise;
    await Bun.sleep(0);
    expect(pending).toBe(1);
    expect(getProfileRun("old")?.state).toBe("running");
    expect(() => start("replacement")).toThrow("already running");
    release.resolve();
    await finished.promise;
    expect(pending).toBe(0);
    // Five GitLab collections, CI settings and two protection rule lists per project, plus one group rule list and per-project local
    // and namespace group webhook reads.
    expect(attempts).toHaveLength(gitlab ? 21 : 2);
    expect(attempts.some((path) => path.includes("/3/"))).toBe(false);
    expect(getProfileRun("old")).toMatchObject({ state: "failed", apiCalls: attempts.length });
    const replacement = Promise.withResolvers<void>();
    expect(start("replacement", replacement.resolve).state).toBe("running");
    await replacement.promise;
    expect(getProfileRun("replacement")?.state).toBe("failed");
  },
);

describe("gitlab profile request budget", () => {
  const ENV_KEYS = [
    "GITLAB_SOURCE_API_URL",
    "GITLAB_SOURCE_PAT",
    "GITLAB_SOURCE_PROFILE_REQUEST_BUDGET",
  ] as const;
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;

  beforeEach(() => {
    process.env.GITLAB_SOURCE_API_URL = "https://gitlab.example.com";
    process.env.GITLAB_SOURCE_PAT = "secret-token";
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  /** Project 1 reports statistics in the listing; the others need a detail request. */
  function installGitLab(
    projectCount = 1,
    withListingStatistics: (id: number) => boolean = (id) => id === 1,
  ) {
    const requests: string[] = [];
    const statistics = {
      commit_count: 3,
      repository_size: 1_024,
      storage_size: 1_024,
      lfs_objects_size: 0,
      packages_size: 0,
      wiki_size: 0,
      uploads_size: 0,
      job_artifacts_size: 0,
      pipeline_artifacts_size: 0,
      snippets_size: 0,
      container_registry_size: 0,
    };
    const project = (id: number, listed: boolean) => ({
      id,
      name: `api-${id}`,
      path_with_namespace: `platform/api-${id}`,
      visibility: "private",
      archived: false,
      default_branch: "main",
      last_activity_at: null,
      statistics: listed ? statistics : null,
    });
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      requests.push(url.pathname);
      await Bun.sleep(1);
      const json = (data: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(data), { headers });
      if (url.pathname.endsWith("/groups/platform/projects")) {
        return json(
          Array.from({ length: projectCount }, (_, index) =>
            project(index + 1, withListingStatistics(index + 1)),
          ),
        );
      }
      const detail = /\/projects\/(\d+)$/.exec(url.pathname);
      if (detail) return json({ ...project(Number(detail[1]), true) });
      if (/\/(issues|merge_requests)$/.test(url.pathname)) return json([{}], { "X-Total": "5" });
      if (url.pathname.includes("/repository/branches/main")) {
        return json({ commit: { id: "abc123" } });
      }
      return json([]);
    }) as typeof fetch);
    return requests;
  }

  async function settled(id: string) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const run = getProfileRun(id);
      if (run && run.state !== "running") return run;
      await Bun.sleep(5);
    }
    throw new Error("profile did not settle");
  }

  test("keeps the last allowed request's head SHA as an at-least-one commit observation", async () => {
    // Listing, issues, merge requests, then the default-branch lookup is the fourth and last.
    process.env.GITLAB_SOURCE_PROFILE_REQUEST_BUDGET = "4";
    const requests = installGitLab();

    const run = profileStarters.gitlab("platform");
    const finished = await settled(run.id);

    expect(finished).toMatchObject({ state: "completed", apiCalls: 4 });
    expect(requests).toHaveLength(4);
    expect(requests.at(-1)).toContain("/repository/branches/main");
    expect(getProfileInventorySummary(run.id)?.metrics).toMatchObject({
      issues: { kind: "exact", value: 5 },
      mergeRequests: { kind: "exact", value: 5 },
      commits: { kind: "at-least", value: 1 },
      branches: { kind: "unavailable", reason: "request-budget" },
      tags: { kind: "unavailable", reason: "request-budget" },
      releases: { kind: "unavailable", reason: "request-budget" },
    });
  });

  test("a budget of one is spent once across discovery and enrichment for many projects", async () => {
    process.env.GITLAB_SOURCE_PROFILE_REQUEST_BUDGET = "1";
    const requests = installGitLab(50, () => false);

    const run = profileStarters.gitlab("platform");
    const finished = await settled(run.id);

    // The required listing page is the only request; no optional call is made on either side.
    expect(finished).toMatchObject({ state: "completed", apiCalls: 1 });
    expect(requests).toEqual(["/api/v4/groups/platform/projects"]);
    const summary = getProfileInventorySummary(run.id);
    expect(summary?.projectsCaptured).toBe(50);
    expect(summary?.storage.repositorySizeBytes).toEqual({
      kind: "unavailable",
      reason: "request-budget",
    });
    for (const metric of Object.values(summary?.metrics ?? {})) {
      expect(metric).toEqual({ kind: "unavailable", reason: "request-budget" });
    }
  });

  test("statistics detail requests and metric requests draw on one allowance", async () => {
    process.env.GITLAB_SOURCE_PROFILE_REQUEST_BUDGET = "9";
    const requests = installGitLab(5, () => false);

    const run = profileStarters.gitlab("platform");
    const finished = await settled(run.id);

    expect(finished).toMatchObject({ state: "completed", apiCalls: 9 });
    expect(requests).toHaveLength(9);
    // Discovery's detail requests ran first; whatever remained went to metrics.
    expect(requests.filter((path) => /\/projects\/\d+$/.test(path))).toHaveLength(5);
  });

  test("rejects an invalid budget before creating a run or calling GitLab", () => {
    process.env.GITLAB_SOURCE_PROFILE_REQUEST_BUDGET = "lots";
    const requests = installGitLab();

    expect(() => profileStarters.gitlab("platform")).toThrow(
      "GITLAB_SOURCE_PROFILE_REQUEST_BUDGET must be a positive integer",
    );
    expect(requests).toEqual([]);
    expect(countProfileRuns()).toBe(0);
  });
});

describe("gitlab optional statistics cutoff and shared budget", () => {
  /** Listing and statistics requests fail transiently once, so retries spend the same limits. */
  function flakyGitLabClient() {
    const seen = new Set<string>();
    const requests: string[] = [];
    const statistics = {
      commit_count: 3,
      repository_size: 1_024,
      storage_size: 1_024,
      lfs_objects_size: 0,
      packages_size: 0,
      wiki_size: 0,
      uploads_size: 0,
      job_artifacts_size: 0,
      pipeline_artifacts_size: 0,
      snippets_size: 0,
      container_registry_size: 0,
    };
    const project = (id: number, listed: boolean) => ({
      id,
      name: `api-${id}`,
      path_with_namespace: `platform/api-${id}`,
      visibility: "private",
      archived: false,
      default_branch: "main",
      last_activity_at: null,
      statistics: listed ? statistics : null,
    });
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      token: "fixture",
      maxRetries: 2,
      sleep: async () => {},
      fetch: async (input) => {
        const url = new URL(input.toString());
        requests.push(`${url.pathname}${url.search}`);
        await Bun.sleep(1);
        if (
          /\/(groups\/platform\/projects|projects\/\d+)$/.test(url.pathname) &&
          !seen.has(url.href)
        ) {
          seen.add(url.href);
          return new Response(null, { status: 503 });
        }
        const json = (data: unknown, headers: Record<string, string> = {}) =>
          new Response(JSON.stringify(data), { headers });
        if (url.pathname.endsWith("/groups/platform/projects")) {
          return json([1, 2, 3, 4, 5, 6].map((id) => project(id, false)));
        }
        const detail = /\/projects\/(\d+)$/.exec(url.pathname);
        if (detail) return json(project(Number(detail[1]), true));
        if (/\/(issues|merge_requests)$/.test(url.pathname)) return json([{}], { "X-Total": "5" });
        if (url.pathname.includes("/repository/branches/main")) {
          return json({ commit: { id: "abc123" } });
        }
        if (url.pathname.endsWith("/sequence")) return json({ count: 3 });
        return json([]);
      },
    });
    return { client, requests };
  }

  function metricObservations(runId: string) {
    return Object.values(getProfileInventorySummary(runId)?.metrics ?? {});
  }

  test("stops optional statistics at its own cutoff while metrics keep the shared budget", async () => {
    const { client, requests } = flakyGitLabClient();

    const run = await runGitLabInventoryProfile(
      client,
      { id: "cutoff-first", namespace: "platform" },
      undefined,
      gitLabProfileRunnerDeps(client, 14, { optionalStatisticsRequests: 5 }),
    );

    // Discovery stopped at its 5-attempt cutoff; metric requests then ran on to the shared 14.
    const statisticsAttempts = requests.filter((path) => /\/projects\/\d+\?/.test(path));
    expect(statisticsAttempts).toHaveLength(5 - 2);
    expect(requests.slice(0, 5)).toEqual(requests.slice(0, 2).concat(statisticsAttempts));
    expect(requests).toHaveLength(14);
    expect(run).toMatchObject({ state: "completed", apiCalls: 14 });
    expect(getProfileInventorySummary("cutoff-first")?.projectsCaptured).toBe(6);
    // Collected evidence survives: projects whose metrics ran roll up as lower bounds.
    expect(
      metricObservations("cutoff-first").some(
        (metric) => metric.kind === "at-least" && metric.value > 0,
      ),
    ).toBe(true);
  });

  test("stops everything at the shared budget when it is reached before the cutoff", async () => {
    const { client, requests } = flakyGitLabClient();

    const run = await runGitLabInventoryProfile(
      client,
      { id: "shared-first", namespace: "platform" },
      undefined,
      gitLabProfileRunnerDeps(client, 6, { optionalStatisticsRequests: 1_000 }),
    );

    expect(requests).toHaveLength(6);
    expect(run).toMatchObject({ state: "completed", apiCalls: 6 });
    expect(getProfileInventorySummary("shared-first")?.projectsCaptured).toBe(6);
    for (const metric of metricObservations("shared-first")) {
      expect(metric).toEqual({ kind: "unavailable", reason: "request-budget" });
    }
  });
});
