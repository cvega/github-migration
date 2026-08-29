import { afterEach, describe, expect, test } from "bun:test";
import type { Counts, MigrationEvent } from "$lib/migrate/types";
import type { GitHubClients } from "$lib/server/core/github";
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

  test("does not send target credentials to an untrusted failure-log host", async () => {
    let tokenRequests = 0;
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
        migrationLogUrl: "https://attacker.example/log.json",
      }),
      doesRepoExist: async () => false,
      wait: async () => {},
    });
    await monitorRepositoryMigration({
      clients: guardedClients,
      migrationId: "migration-1",
      githubMigrationId: "node-1",
      targetOrg: "acme",
      targetRepo: "widget",
      emit: () => {},
    });
    expect(tokenRequests).toBe(0);
  });
});
