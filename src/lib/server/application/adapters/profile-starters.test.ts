import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import { getProfileRun } from "$lib/server/profile/database/runs";
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
