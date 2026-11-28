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
import { profileStarters } from "./profile-starters";

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
    expect(attempts).toHaveLength(gitlab ? 10 : 2);
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

  function installGitLab() {
    const requests: string[] = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      requests.push(url.pathname);
      const json = (data: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(data), { headers });
      if (url.pathname.endsWith("/groups/platform/projects")) {
        const bytes = 1_024;
        return json([
          {
            id: 1,
            name: "api",
            path_with_namespace: "platform/api",
            visibility: "private",
            archived: false,
            default_branch: "main",
            last_activity_at: null,
            statistics: {
              commit_count: 3,
              repository_size: bytes,
              storage_size: bytes,
              lfs_objects_size: 0,
              packages_size: 0,
              wiki_size: 0,
              uploads_size: 0,
              job_artifacts_size: 0,
              pipeline_artifacts_size: 0,
              snippets_size: 0,
              container_registry_size: 0,
            },
          },
        ]);
      }
      if (/\/(issues|merge_requests)$/.test(url.pathname)) return json([{}], { "X-Total": "5" });
      if (url.pathname.includes("/repository/branches/main")) {
        return json({ commit: { id: "abc123" } });
      }
      return json([]);
    }) as typeof fetch);
    return requests;
  }

  async function settled(id: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const run = getProfileRun(id);
      if (run && run.state !== "running") return run;
      await Bun.sleep(5);
    }
    throw new Error("profile did not settle");
  }

  test("completes with the configured budget spent and the rest unavailable", async () => {
    process.env.GITLAB_SOURCE_PROFILE_REQUEST_BUDGET = "3";
    const requests = installGitLab();

    const run = profileStarters.gitlab("platform");
    const finished = await settled(run.id);

    expect(finished).toMatchObject({ state: "completed", apiCalls: 1 + 3 });
    expect(requests).toHaveLength(1 + 3);
    expect(getProfileInventorySummary(run.id)?.metrics).toMatchObject({
      issues: { kind: "exact", value: 5 },
      mergeRequests: { kind: "exact", value: 5 },
      commits: { kind: "unavailable", reason: "request-budget" },
      branches: { kind: "unavailable", reason: "request-budget" },
      tags: { kind: "unavailable", reason: "request-budget" },
      releases: { kind: "unavailable", reason: "request-budget" },
    });
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
