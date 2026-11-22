import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Counts, Migration, MigrationEvent } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { approveIdentityMapping, listIdentityMappings } from "../database/identity-mappings";
import { getGhesImportJobByMigrationId, insertGhesImportJob } from "../database/import-jobs";
import { insertMigration } from "../database/migrations";
import { migrateStore } from "../database/schema";
import type { ExporterWorker } from "../exporters/worker";
import {
  type ExporterGhesSourceAdapter,
  resumeExporterGhesMigration,
  runExporterGhesMigration,
} from "./import";

const targetCounts: Counts = {
  commits: 1,
  branches: 3,
  tags: 0,
  issues: 0,
  pullRequests: 2,
  releases: 0,
};

function migration(id: string): Migration {
  return {
    id,
    batchId: null,
    githubMigrationId: null,
    sourceProvider: "gitlab",
    sourceApiUrl: "https://gitlab.example/api/v4",
    targetProfileId: "ghes",
    targetPlatform: "ghes",
    targetApiUrl: "https://ghes.example/api/v3",
    sourceOrg: "group",
    sourceRepo: "project",
    targetOrg: "target",
    targetRepo: "project",
    state: "running",
    failureReason: null,
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    elapsedSeconds: null,
    authMode: "env-pat",
    requestOptions: "{}",
  };
}

function adapter(worker: ExporterWorker): ExporterGhesSourceAdapter {
  return {
    provider: "gitlab",
    displayName: "GitLab",
    getConfig: () =>
      ({
        profile: {
          apiUrl: "https://ghes.example/api/v3",
          webUrl: "https://ghes.example",
        },
      }) as never,
    assertSource: () => {},
    createWorker: () => worker,
    verifyTargetUser: async () => {},
    fetchTargetCounts: async () => targetCounts,
    createSshClient: () => ({
      connect: async () => {},
      disconnect: () => {},
      remoteArchivePath: () => "/remote/archive.tar.gz",
      uploadArchive: async () => "/remote/archive.tar.gz",
      prepare: async () => "migration-guid-123",
      conflicts: async () => ({ stdout: "", stderr: "" }),
      mappingRecords: async () => ({ stdout: "", stderr: "" }),
      map: async () => ({ stdout: "", stderr: "" }),
      import: async () => ({ stdout: "", stderr: "" }),
      auditFailures: async () => ({ stdout: "", stderr: "" }),
      unlock: async () => ({ stdout: "", stderr: "" }),
      removeArchive: async () => ({ stdout: "", stderr: "" }),
    }),
    sourceWasLocked: async () => true,
    wait: async () => {},
  };
}

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

describe("GHES import execution", () => {
  test("checkpoints exporter, transfer, prepare, import, audit, and unlock", async () => {
    const record = migration("ghes-success");
    insertMigration(record);
    const worker: ExporterWorker = {
      submit: async () => ({ jobId: "export-job" }),
      inspect: async (jobId) => ({
        jobId,
        state: "succeeded",
        archive: { path: "/tmp/export.tar.gz", sha256: "a".repeat(64) },
      }),
      cancel: async () => {},
    };
    const source = adapter(worker);
    const ssh = source.createSshClient({} as never);
    const calls: string[] = [];
    let mapped = false;
    approveIdentityMapping({
      targetApiUrl: record.targetApiUrl,
      targetOrg: record.targetOrg,
      sourceKind: "ghe-migrator:gitlab",
      sourceIdentity: "https://gitlab.example/users/alice",
      targetLogin: "octocat",
    });
    ssh.conflicts = async () => {
      calls.push("conflicts-start");
      await Promise.resolve();
      calls.push("conflicts-end");
      return {
        stdout: mapped
          ? "model_name,source_url,target_url,recommended_action\n"
          : "model_name,source_url,target_url,recommended_action\nuser,https://gitlab.example/users/alice,,rename\n",
        stderr: "",
      };
    };
    ssh.mappingRecords = async () => {
      calls.push("audit");
      return { stdout: "", stderr: "" };
    };
    ssh.map = async (_guid, csv) => {
      expect(csv).toContain(
        "user,https://gitlab.example/users/alice,https://ghes.example/octocat,map",
      );
      mapped = true;
      return { stdout: "", stderr: "" };
    };
    ssh.unlock = async () => {
      calls.push("unlock");
      return { stdout: "", stderr: "" };
    };
    ssh.disconnect = () => {
      calls.push("disconnect");
    };
    source.fetchTargetCounts = async (completed) => {
      expect(completed.state).toBe("succeeded");
      expect(completed.targetOrg).toBe(record.targetOrg);
      expect(completed.targetRepo).toBe(record.targetRepo);
      calls.push("counts");
      return targetCounts;
    };
    source.createSshClient = () => ssh;
    const result = await runExporterGhesMigration(
      { id: record.id, sourceProvider: "gitlab", emit: () => {} },
      source,
    );
    expect(result.state).toBe("succeeded");
    expect(result.targetCounts).toEqual(targetCounts);
    expect(getGhesImportJobByMigrationId(record.id)?.phase).toBe("succeeded");
    expect(calls).toEqual([
      "conflicts-start",
      "conflicts-end",
      "audit",
      "conflicts-start",
      "conflicts-end",
      "unlock",
      "disconnect",
      "counts",
    ]);
    expect(listIdentityMappings(record.targetApiUrl, record.targetOrg)).toMatchObject([
      {
        sourceIdentity: "https://gitlab.example/users/alice",
        targetLogin: "octocat",
        status: "approved",
      },
    ]);
  });

  test("resolves team conflicts revealed by organization mapping before importing", async () => {
    const record = migration("ghes-team-conflict");
    insertMigration(record);
    const source = adapter({
      submit: async () => ({ jobId: "export-job" }),
      inspect: async (jobId) => ({
        jobId,
        state: "succeeded",
        archive: { path: "/tmp/ghes-team-conflict-test.tar.gz", sha256: "a".repeat(64) },
      }),
      cancel: async () => {},
    });
    const ssh = source.createSshClient({} as never);
    const header = "model_name,source_url,target_url,recommended_action\n";
    const conflicts = [
      header,
      `${header}team,https://gitlab.example/groups/admin,https://ghes.example/orgs/target/teams/admin,merge\n`,
      header,
    ];
    const calls: string[] = [];
    ssh.conflicts = async () => {
      const stdout = conflicts.shift();
      if (stdout === undefined) throw new Error("Unexpected conflict lookup");
      calls.push("conflicts");
      return { stdout, stderr: "" };
    };
    ssh.mappingRecords = async () => ({
      stdout: `${header}organization,https://gitlab.example/group,https://ghes.example/group,import\n`,
      stderr: "",
    });
    ssh.map = async (_guid, csv) => {
      calls.push(csv.includes("team,") ? "merge-team" : "map-organization");
      if (csv.includes("team,")) expect(csv).toContain("/orgs/target/teams/admin,merge");
      return { stdout: "", stderr: "" };
    };
    ssh.import = async () => {
      expect(conflicts).toHaveLength(0);
      calls.push("import");
      return { stdout: "", stderr: "" };
    };
    source.createSshClient = () => ssh;

    const result = await runExporterGhesMigration(
      { id: record.id, sourceProvider: record.sourceProvider, emit: () => {} },
      source,
    );

    expect(result.state).toBe("succeeded");
    expect(calls).toEqual([
      "conflicts",
      "map-organization",
      "conflicts",
      "merge-team",
      "conflicts",
      "import",
    ]);
    expect(result.targetCounts).toEqual(targetCounts);
  });

  test.each([
    { changing: false, cancel: false, expectedPasses: 1 },
    { changing: true, cancel: false, expectedPasses: 3 },
    { changing: false, cancel: true, expectedPasses: 1 },
  ])(
    "does not import unresolved or cancelled mapping passes (%j)",
    async ({ changing, cancel, expectedPasses }) => {
      const record = migration("ghes-persistent-conflict");
      insertMigration(record);
      const source = adapter({
        submit: async () => ({ jobId: "export-job" }),
        inspect: async (jobId) => ({
          jobId,
          state: "succeeded",
          archive: { path: "/tmp/ghes-persistent-conflict-test.tar.gz", sha256: "a".repeat(64) },
        }),
        cancel: async () => {},
      });
      const ssh = source.createSshClient({} as never);
      const controller = new AbortController();
      let passes = 0;
      let imported = false;
      ssh.conflicts = async () => {
        if (cancel && passes > 0) controller.abort();
        return {
          stdout: `model_name,source_url,target_url,recommended_action\nteam,https://gitlab.example/groups/admin-${changing ? passes : 0},https://ghes.example/orgs/target/teams/admin,merge\n`,
          stderr: "",
        };
      };
      ssh.map = async () => {
        passes += 1;
        return { stdout: "", stderr: "" };
      };
      ssh.import = async () => {
        imported = true;
        return { stdout: "", stderr: "" };
      };
      source.createSshClient = () => ssh;

      const result = await runExporterGhesMigration(
        {
          id: record.id,
          sourceProvider: record.sourceProvider,
          signal: controller.signal,
          emit: () => {},
        },
        source,
      );

      expect(passes).toBe(expectedPasses);
      expect(imported).toBe(false);
      expect(result.state).toBe("reconciliation_required");
      expect(result.failureReason).toContain(cancel ? "aborted" : "GHES conflicts remain");
      expect(result.targetCounts).toBeNull();
    },
  );

  test("preserves successful Bitbucket imports when resource counts are unavailable", async () => {
    const record = {
      ...migration("ghes-counts-unavailable"),
      sourceProvider: "bitbucket-server" as const,
    };
    insertMigration(record);
    const source = adapter({
      submit: async () => ({ jobId: "export-job" }),
      inspect: async (jobId) => ({
        jobId,
        state: "succeeded",
        archive: { path: "/tmp/ghes-counts-unavailable-test.tar.gz", sha256: "a".repeat(64) },
      }),
      cancel: async () => {},
    });
    source.provider = "bitbucket-server";
    source.fetchTargetCounts = async () => {
      throw new Error("Target API unavailable");
    };
    const events: MigrationEvent[] = [];

    const result = await runExporterGhesMigration(
      { id: record.id, sourceProvider: record.sourceProvider, emit: (event) => events.push(event) },
      source,
    );

    expect(result).toMatchObject({ state: "succeeded", failureReason: null, targetCounts: null });
    expect(getGhesImportJobByMigrationId(record.id)?.phase).toBe("succeeded");
    expect(events.at(-1)).toMatchObject({
      eventType: "step",
      payload: {
        message: expect.stringContaining("target resource counts could not be collected"),
      },
    });
  });

  test("saves unresolved GHES users without guessing their target", async () => {
    const record = migration("ghes-conflict");
    insertMigration(record);
    const worker: ExporterWorker = {
      submit: async () => ({ jobId: "export-job" }),
      inspect: async (jobId) => ({
        jobId,
        state: "succeeded",
        archive: { path: "/tmp/export.tar.gz", sha256: "a".repeat(64) },
      }),
      cancel: async () => {},
    };
    const source = adapter(worker);
    const ssh = source.createSshClient({} as never);
    ssh.conflicts = async () => ({
      stdout:
        "model_name,source_url,target_url,recommended_action\nuser,https://gitlab.example/users/alice,,rename\n",
      stderr: "",
    });

    source.createSshClient = () => ssh;
    const result = await runExporterGhesMigration(
      { id: record.id, sourceProvider: "gitlab", emit: () => {} },
      source,
    );
    expect(result.state).toBe("failed");
    expect(listIdentityMappings(record.targetApiUrl, record.targetOrg)).toMatchObject([
      {
        sourceIdentity: "https://gitlab.example/users/alice",
        targetLogin: null,
        status: "unmapped",
      },
    ]);
  });

  test.each(["initial", "late-missing", "late-unmapped", "late-valid"])(
    "validates and discovers users on the %s conflict pass",
    async (scenario) => {
      const record = migration("ghes-missing-user");
      insertMigration(record);
      const worker: ExporterWorker = {
        submit: async () => ({ jobId: "export-job" }),
        inspect: async (jobId) => ({
          jobId,
          state: "succeeded",
          archive: { path: "/tmp/export.tar.gz", sha256: "a".repeat(64) },
        }),
        cancel: async () => {},
      };
      const source = adapter(worker);
      const ssh = source.createSshClient({} as never);
      if (scenario !== "late-unmapped")
        approveIdentityMapping({
          targetApiUrl: record.targetApiUrl,
          targetOrg: record.targetOrg,
          sourceKind: "ghe-migrator:gitlab",
          sourceIdentity: "https://gitlab.example/users/alice",
          targetLogin: "missing",
        });
      const header = "model_name,source_url,target_url,recommended_action\n";
      const user = `${header}user,https://gitlab.example/users/alice,,rename\n`;
      const csvs =
        scenario === "initial"
          ? [user]
          : [
              `${header}organization,https://gitlab.example/group,https://ghes.example/target,map\n`,
              user,
              header,
            ];
      const calls: string[] = [];
      ssh.conflicts = async () => ({ stdout: csvs.shift() ?? header, stderr: "" });
      ssh.map = async (_, csv) => {
        calls.push(csv.includes("user,") ? "map-user" : "map-org");
        return { stdout: "", stderr: "" };
      };
      ssh.import = async () => {
        calls.push("import");
        return { stdout: "", stderr: "" };
      };
      source.createSshClient = () => ssh;
      source.verifyTargetUser = async () => {
        calls.push("verify");
        if (scenario !== "late-valid") throw new Error("Target user not found");
      };
      const result = await runExporterGhesMigration(
        { id: record.id, sourceProvider: "gitlab", emit: () => {} },
        source,
      );
      if (scenario === "late-valid") {
        expect(result.state).toBe("succeeded");
        expect(calls).toEqual(["map-org", "verify", "map-user", "import"]);
      } else if (scenario === "late-unmapped") {
        expect(listIdentityMappings(record.targetApiUrl, record.targetOrg)).toMatchObject([
          { status: "unmapped", sourceIdentity: "https://gitlab.example/users/alice" },
        ]);
        expect(result.state).toBe("reconciliation_required");
        expect(calls).toEqual(["map-org"]);
      } else {
        expect(result.failureReason).toContain("Target user not found");
        expect(calls).toEqual(scenario === "initial" ? ["verify"] : ["map-org", "verify"]);
      }
    },
  );

  test("does not replay an import interrupted at an ambiguous checkpoint", async () => {
    const record = migration("ghes-ambiguous");
    insertMigration(record);
    const now = new Date().toISOString();
    insertGhesImportJob({
      id: "job",
      migrationId: record.id,
      phase: "importing",
      exporterJobId: "export-job",
      archivePath: "/tmp/export.tar.gz",
      archiveSha256: "a".repeat(64),
      ghesImportId: "migration-guid-123",
      sourceWasArchived: true,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    });
    const worker: ExporterWorker = {
      submit: async () => ({ jobId: "unused" }),
      inspect: async () => ({ jobId: "unused", state: "running" }),
      cancel: async () => {},
    };
    const result = await resumeExporterGhesMigration(record, () => {}, undefined, adapter(worker));
    expect(result.state).toBe("reconciliation_required");
    expect(result.failureReason).toContain("ambiguous ghe-migrator importing");
  });
});
