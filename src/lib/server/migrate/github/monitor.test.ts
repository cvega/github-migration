import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Counts, Migration, MigrationEvent } from "$lib/migrate/types";
import type { GitHubClients } from "$lib/server/core/github";
import { monitorGhecMigration } from "../executors/archive-to-ghec";
import { __setMonitorDependenciesForTests, monitorRepositoryMigration } from "./monitor";

const counts: Counts = {
  commits: 10,
  branches: 2,
  tags: 1,
  issues: 3,
  pullRequests: 4,
  releases: 1,
};

const clients = {
  source: {},
  sourceGraphql: async () => ({}),
  target: {},
  targetGraphql: async () => ({}),
  getTargetToken: async () => "target-token",
} as unknown as GitHubClients;

let restore = () => {};
afterEach(() => restore());

describe("GitHub migration monitor", () => {
  test.each(["gitlab", "bitbucket-server"] as const)(
    "does not look up a colliding %s source on GitHub",
    async (sourceProvider) => {
      const lookups: string[] = [];
      restore = __setMonitorDependenciesForTests({
        getRepositoryMigration: async () => ({
          state: "SUCCEEDED",
          repositoryName: "widget",
          warningsCount: 0,
          failureReason: "",
          migrationLogUrl: "",
        }),
        doesRepoExist: async () => true,
        getRepoCounts: async (_client, _gql, owner, repo) => {
          lookups.push(`${owner}/${repo}`);
          return counts;
        },
      });
      const events: MigrationEvent[] = [];
      const result = await monitorGhecMigration(
        clients,
        {
          id: "collision",
          sourceProvider,
          sourceOrg: "other-owner",
          sourceRepo: "widget",
          targetOrg: "dest",
          targetRepo: "widget",
          sourceCounts: null,
          startedAt: new Date().toISOString(),
        } as Migration,
        "remote",
        (event) => events.push(event),
      );
      expect(lookups).toEqual(["dest/widget"]);
      expect(events.at(-1)).toMatchObject({
        eventType: "complete",
        payload: { sourceCounts: null },
      });
      expect(result.targetCounts).toEqual(counts);
    },
  );
  test("returns authoritative counts from the successful terminal snapshot", async () => {
    restore = __setMonitorDependenciesForTests({
      getRepositoryMigration: async () => ({
        state: "SUCCEEDED",
        repositoryName: "widget",
        warningsCount: 1,
        failureReason: "",
        migrationLogUrl: "",
      }),
      doesRepoExist: async () => true,
      getRepoCounts: async () => counts,
      wait: async () => {},
    });
    const events: MigrationEvent[] = [];
    const result = await monitorRepositoryMigration({
      targetApiUrl: "https://api.github.com",
      clients,
      migrationId: "migration-1",
      githubMigrationId: "node-1",
      targetOrg: "acme",
      targetRepo: "widget",
      sourceCounts: counts,
      pollInterval: 0,
      emit: (event) => events.push(event),
    });
    expect(result).toEqual({ phase: "SUCCEEDED", finalCounts: counts });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("complete");
  });

  test("projects in-progress phase changes before completion", async () => {
    let poll = 0;
    restore = __setMonitorDependenciesForTests({
      getRepositoryMigration: async () => ({
        state: ++poll === 1 ? "IN_PROGRESS" : "SUCCEEDED",
        repositoryName: "widget",
        warningsCount: 0,
        failureReason: "",
        migrationLogUrl: "",
      }),
      doesRepoExist: async () => poll > 1,
      getRepoCounts: async () => counts,
      wait: async () => {},
    });

    const events: MigrationEvent[] = [];
    await monitorRepositoryMigration({
      targetApiUrl: "https://api.github.com",
      clients,
      migrationId: "migration-1",
      githubMigrationId: "node-1",
      targetOrg: "acme",
      targetRepo: "widget",
      sourceCounts: counts,
      emit: (event) => events.push(event),
    });
    expect(events.map((event) => event.eventType)).toEqual([
      "snapshot",
      "phase_change",
      "complete",
    ]);
    expect(events[0]?.phase).toBe("EXPORTING");
  });

  test("does not use an earlier snapshot as final counts when the final lookup fails", async () => {
    using warn = spyOn(console, "warn").mockImplementation(() => {});
    let poll = 0;
    restore = __setMonitorDependenciesForTests({
      getRepositoryMigration: async () => ({
        state: ++poll === 1 ? "IN_PROGRESS" : "SUCCEEDED",
        repositoryName: "widget",
        warningsCount: 0,
        failureReason: "",
        migrationLogUrl: "",
      }),
      doesRepoExist: async () => true,
      getRepoCounts: async () => {
        if (poll === 2) throw new Error("unavailable");
        return counts;
      },
      wait: async () => {},
    });
    const result = await monitorRepositoryMigration({
      targetApiUrl: "https://api.github.com",
      clients,
      migrationId: "migration-1",
      githubMigrationId: "node-1",
      targetOrg: "acme",
      targetRepo: "widget",
      sourceCounts: counts,
      emit: () => {},
    });
    expect(result).toEqual({ phase: "SUCCEEDED", finalCounts: null });
    expect(warn).toHaveBeenCalled();
  });

  test("does not send target credentials to untrusted failure-log URLs", async () => {
    let tokenRequests = 0;
    const events: MigrationEvent[] = [];
    let migrationLogUrl = "https://attacker.example/log.json";
    const guardedClients = {
      ...clients,
      getTargetToken: async () => {
        tokenRequests += 1;
        return "target-token";
      },
    } as GitHubClients;
    restore = __setMonitorDependenciesForTests({
      getRepositoryMigration: async () => ({
        state: "FAILED",
        repositoryName: "widget",
        warningsCount: 0,
        failureReason: "failed",
        migrationLogUrl,
      }),
      doesRepoExist: async () => false,
      fetch: async () => Response.json([]),
      wait: async () => {},
    });
    for (migrationLogUrl of [
      "https://attacker.example/log.json",
      "https://api.github.com/log.json",
      "https://github.com.example/log.json",
      "https://other.ghe.com/log.json",
      "https://github.com/log.json#sample",
      "https://github.com/log.json?example=1",
      "https://github.com:443/log.json",
      "http://github.com/log.json",
      "https://user@github.com/log.json",
      "https://github.com:444/log.json",
    ]) {
      await monitorRepositoryMigration({
        targetApiUrl: "https://api.github.com",
        clients: guardedClients,
        migrationId: "migration-1",
        githubMigrationId: "node-1",
        targetOrg: "acme",
        targetRepo: "widget",
        emit: (event) => events.push(event),
      });
      expect(events.at(-1)).toMatchObject({
        payload: { detail: { logUrl: "" }, progress: { current: { migrationLogUrl: "" } } },
      });
    }
    expect(tokenRequests).toBe(0);
  });

  test.each(["github.com", "sample.ghe.com"])("fetches failure logs only from %s", async (host) => {
    let authorization = "";
    restore = __setMonitorDependenciesForTests({
      getRepositoryMigration: async () => ({
        state: "FAILED",
        repositoryName: "widget",
        warningsCount: 0,
        failureReason: "failed",
        migrationLogUrl: `https://${host}/migrations/log.json`,
      }),
      doesRepoExist: async () => false,
      fetch: async (_input, init) => {
        expect(init?.redirect).toBe("error");
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json([]);
      },
      wait: async () => {},
    });
    await monitorRepositoryMigration({
      targetApiUrl: `https://api.${host}`,
      clients,
      migrationId: "migration-1",
      githubMigrationId: "node-1",
      targetOrg: "acme",
      targetRepo: "widget",
      emit: () => {},
    });
    expect(authorization).toBe("Bearer target-token");
  });
});
