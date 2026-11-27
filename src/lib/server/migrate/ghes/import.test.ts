import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Counts, Migration, MigrationEvent } from "$lib/migrate/types";
import { closeStore, initStore } from "$lib/server/core/db";
import { getEvents, insertEvent } from "../database/events";
import { approveIdentityMapping, listIdentityMappings } from "../database/identity-mappings";
import { getGhesImportJobByMigrationId, insertGhesImportJob } from "../database/import-jobs";
import { getMigration, insertMigration } from "../database/migrations";
import { migrateStore } from "../database/schema";
import { type ExporterWorker, exporterFailures } from "../exporters/worker";
import { activeMigrationRuns } from "../runs/active";
import { createMigrationRunFinisher } from "../runs/finish";
import { drainMigrationQueue, shouldQueueMigration } from "../runs/queue";
import {
  defaultGhesWait,
  type ExporterGhesSourceAdapter,
  resumeExporterGhesMigration,
  runExporterGhesMigration,
} from "./import";

import { GhesMigratorBusyError } from "./ssh";

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
  test.each(["running", "expired", "unstarted"] as const)(
    "releases the GHES slot after a %s exporter fails",
    async (scenario) => {
      const record = migration("exporter");
      insertMigration(record);
      insertMigration({ ...record, id: "next", state: "queued" });
      const calls: string[] = [];
      const source = adapter({
        submit: async () => {
          calls.push("submit");
          return { jobId: "export-job" };
        },
        inspect: async (jobId) => {
          calls.push(`inspect ${jobId}`);
          return scenario === "unstarted"
            ? { jobId, state: "failed", failureReason: exporterFailures.unstarted }
            : { jobId, state: "running" };
        },
        cancel: async (id) => {
          calls.push(`stop ${id}`);
        },
        cleanup: async (id) => {
          calls.push(`remove ${id}`);
        },
      });
      source.wait = defaultGhesWait;
      if (scenario !== "running") {
        insertGhesImportJob({
          id: "job",
          migrationId: record.id,
          phase: "exporting",
          exporterJobId: "export-job",
          archivePath: null,
          archiveSha256: null,
          ghesImportId: null,
          sourceWasArchived: true,
          failureReason: null,
          updatedAt: record.startedAt,
          createdAt: scenario === "expired" ? new Date(0).toISOString() : record.startedAt,
        });
      }
      const previous = process.env.GHES_EXPORT_TIMEOUT_MS;
      process.env.GHES_EXPORT_TIMEOUT_MS = scenario === "running" ? "100" : "60000";
      const registration = activeMigrationRuns.claim(record.id)!;
      activeMigrationRuns.enqueue("next", { sourceRepo: "group/next", targetOrg: "target" });
      const launched: string[] = [];
      const drain = () =>
        drainMigrationQueue((id) => {
          launched.push(id);
          return true;
        });
      try {
        drain();
        expect(launched).toEqual([]);
        const result =
          scenario === "running"
            ? await runExporterGhesMigration(
                { id: record.id, sourceProvider: record.sourceProvider, emit: insertEvent },
                source,
              )
            : await resumeExporterGhesMigration(record, insertEvent, undefined, source);
        createMigrationRunFinisher(drain).settleResult(record.id, registration.token, result);
        const failureReason =
          scenario === "unstarted"
            ? "GitLab export failed: Exporter container was never started"
            : "GHES exporter timed out";
        expect(getMigration(record.id)).toMatchObject({ state: "failed", failureReason });
        expect(getGhesImportJobByMigrationId(record.id)).toMatchObject({
          phase: "failed",
          failureReason,
        });
        expect(calls).toEqual(
          scenario === "unstarted"
            ? ["inspect export-job", "remove export-job"]
            : [
                ...(scenario === "running" ? ["submit"] : []),
                "inspect export-job",
                "stop export-job",
                "remove export-job",
              ],
        );
        expect(launched).toEqual(["next"]);
      } finally {
        activeMigrationRuns.finish(record.id, registration.token);
        activeMigrationRuns.dropQueued("next");
        if (previous === undefined) delete process.env.GHES_EXPORT_TIMEOUT_MS;
        else process.env.GHES_EXPORT_TIMEOUT_MS = previous;
      }
    },
  );

  test.each(["completed", "unavailable", "cleanup pending"] as const)(
    "inspects an expired recovery and preserves ownership when %s",
    async (scenario) => {
      const record = {
        ...migration("expired-recovery"),
        sourceProvider: "bitbucket-server" as const,
      };
      insertMigration(record);
      insertGhesImportJob({
        id: "original",
        migrationId: record.id,
        phase: "exporting",
        exporterJobId: "old-export",
        archivePath: null,
        archiveSha256: null,
        ghesImportId: null,
        sourceWasArchived: true,
        failureReason: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: record.startedAt,
      });
      const calls: string[] = [];
      let refuseCleanup = scenario === "cleanup pending";
      const source = adapter({
        submit: async () => {
          calls.push("submit");
          return { jobId: "new-export" };
        },
        inspect: async (id, signal) => {
          calls.push(`inspect ${id}`);
          expect(signal?.aborted).toBe(false);
          if (scenario === "unavailable") throw new Error("inert-private-detail");
          return refuseCleanup
            ? { jobId: id, state: "running" }
            : {
                jobId: id,
                state: "succeeded",
                archive: { path: "/tmp/expired-recovery-fixture.tar.gz", sha256: "a".repeat(64) },
              };
        },
        cancel: async (id) => {
          calls.push(`stop ${id}`);
          throw new Error("inert-private-detail");
        },
        cleanup: async (id) => {
          calls.push(`remove ${id}`);
          if (refuseCleanup) throw new Error("inert-private-detail");
        },
      });
      source.provider = record.sourceProvider;
      source.localMappingRecords = async () =>
        "model_name,source_url,target_url,state\nrepository,https://bb.example/project,,exported\n";
      source.wait = async () => {
        throw new Error("Expired recovery must not poll again");
      };
      const result = await resumeExporterGhesMigration(record, insertEvent, undefined, source);
      if (scenario === "unavailable") {
        expect(result.state).toBe("reconciliation_required");
        expect(result.failureReason).toContain("exporter status is unconfirmed");
        expect(result.failureReason).not.toContain("inert-private-detail");
        expect(calls).toEqual(["inspect old-export"]);
        expect(getGhesImportJobByMigrationId(record.id)?.exporterJobId).toBe("old-export");
        return;
      }
      if (scenario === "completed") {
        expect(result.state).toBe("succeeded");
        expect(calls).toEqual(["inspect old-export", "remove old-export"]);
        expect(getGhesImportJobByMigrationId(record.id)).toMatchObject({
          id: "original",
          archiveSha256: "a".repeat(64),
          phase: "succeeded",
        });
        return;
      }
      const run = () =>
        runExporterGhesMigration(
          { id: record.id, sourceProvider: record.sourceProvider, emit: insertEvent },
          source,
        );
      const registration = activeMigrationRuns.claim(record.id)!;
      createMigrationRunFinisher(() => {}).settleResult(record.id, registration.token, result);
      expect(shouldQueueMigration({ ...record, id: "unrelated" })).toBe(false);
      for (const attempt of [result, await run()]) {
        expect(attempt.state).toBe("reconciliation_required");
        expect(attempt.failureReason).toContain("exporter cleanup");
        expect(attempt.failureReason).not.toContain("inert-private-detail");
      }
      expect(getGhesImportJobByMigrationId(record.id)).toMatchObject({
        id: "original",
        exporterJobId: "old-export",
        phase: "reconciliation_required",
      });
      expect(calls).toEqual([
        "inspect old-export",
        "stop old-export",
        "remove old-export",
        "remove old-export",
      ]);
      refuseCleanup = false;
      expect((await run()).state).toBe("succeeded");
      expect(calls.slice(4)).toEqual([
        "remove old-export",
        "submit",
        "inspect new-export",
        "remove new-export",
      ]);
    },
  );
  test.each([false, true])(
    "Bitbucket sends approved archive mappings upfront; remaining conflict: %s",
    async (blocked) => {
      const record = migration("bitbucket-upfront");
      record.sourceProvider = "bitbucket-server";
      record.batchId = "bitbucket-batch";
      insertMigration(record);
      const sibling = {
        ...record,
        id: "queued-sibling",
        state: "queued" as const,
        sourceRepo: "other",
        targetRepo: "other",
      };
      insertMigration(sibling);
      approveIdentityMapping({
        targetApiUrl: record.targetApiUrl,
        targetOrg: record.targetOrg,
        sourceKind: "ghe-migrator:bitbucket-server:team",
        sourceIdentity: "https://bb/known",
        targetLogin: "approved-team",
      });
      const source = adapter({
        submit: async (request) => {
          expect(request.migrationId).toBe(record.id);
          return { jobId: "export-job" };
        },
        inspect: async (jobId) => ({
          jobId,
          state: "succeeded",
          archive: { path: "/tmp/bitbucket-upfront.tar.gz", sha256: "a".repeat(64) },
        }),
        cancel: async () => {},
      });
      source.provider = "bitbucket-server";
      const ssh = source.createSshClient({} as never);
      const calls: string[] = [];
      const csv =
        "model_name,source_url,target_url,state\nrepository,https://bb/repo,,exported\nteam,https://bb/known,,exported\nteam,https://bb/unknown,,exported\n";
      source.localMappingRecords = async (path) => {
        expect(path).toBe("/tmp/bitbucket-upfront.tar.gz");
        calls.push("local");
        if (blocked) throw new Error("Archive manifests not available");
        return csv;
      };
      ssh.mappingRecords = async (_guid, include) => {
        expect(include).toBe(true);
        calls.push("audit");
        return {
          stdout: csv,
          stderr: "",
        };
      };
      ssh.map = async (_guid, csv) => {
        calls.push("map");
        expect(csv).toContain(
          "https://bb/known,https://ghes.example/orgs/target/teams/approved-team,merge",
        );
        expect(csv).not.toContain("https://bb/unknown");
        return { stdout: "", stderr: "" };
      };
      ssh.conflicts = async () => {
        calls.push("conflicts");
        return {
          stdout: blocked
            ? "model_name,source_url,target_url,recommended_action\nteam,https://bb/unknown,,merge\n"
            : "",
          stderr: "",
        };
      };
      ssh.import = async () => {
        calls.push("import");
        return { stdout: "", stderr: "" };
      };
      source.createSshClient = () => ssh;
      const result = await runExporterGhesMigration(
        { id: record.id, sourceProvider: record.sourceProvider, emit: () => {} },
        source,
      );
      expect(calls).toEqual(
        blocked ? ["local", "audit", "map", "conflicts"] : ["local", "map", "conflicts", "import"],
      );
      expect(result.state).toBe(blocked ? "reconciliation_required" : "succeeded");
      expect(getGhesImportJobByMigrationId(sibling.id)).toBeNull();
    },
  );
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
      { id: record.id, sourceProvider: "gitlab", emit: insertEvent },
      source,
    );
    expect(result.state).toBe("succeeded");
    expect(result.targetCounts).toEqual(targetCounts);
    expect(
      getEvents(record.id).flatMap((event) =>
        event.eventType === "step" ? [[event.payload.executorPhase, event.phase]] : [],
      ),
    ).toEqual([
      ["exporting", "EXPORTING"],
      ["archive_ready", "EXPORTING"],
      ["transferring", null],
      ["preparing", null],
      ["mapping", null],
      ["importing", "IMPORTING_GIT"],
      ["auditing", null],
      ["unlocking", null],
      ["succeeded", "SUCCEEDED"],
    ]);
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
    approveIdentityMapping({
      targetApiUrl: record.targetApiUrl,
      targetOrg: record.targetOrg,
      sourceKind: `ghe-migrator:${record.sourceProvider}:team`,
      sourceIdentity: "https://gitlab.example/groups/admin",
      targetLogin: "approved-team",
    });
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
      if (csv.includes("team,"))
        expect(csv).toContain(`/orgs/${record.targetOrg}/teams/approved-team,merge`);
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
      for (let index = 0; index <= 3; index++) {
        approveIdentityMapping({
          targetApiUrl: record.targetApiUrl,
          targetOrg: record.targetOrg,
          sourceKind: `ghe-migrator:${record.sourceProvider}:team`,
          sourceIdentity: `https://gitlab.example/groups/admin-${index}`,
          targetLogin: "admin",
        });
      }
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
      throw new Error("private upstream diagnostic");
    };
    const ssh = source.createSshClient({} as never);
    ssh.mappingRecords = async () => ({
      stdout: "model_name,source_url,target_url,state\nrepository,https://bb/project,,exported\n",
      stderr: "",
    });
    source.createSshClient = () => ssh;
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
    expect(JSON.stringify(events)).not.toContain("private upstream diagnostic");
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
        expect(result.failureReason).toContain("migration-guid-123 reached");
        expect(calls).toEqual(scenario === "initial" ? ["verify"] : ["map-org", "verify"]);
      }
    },
  );

  test.each([
    ["Exporter container stopped unexpectedly", "Exporter container stopped unexpectedly"],
    ["Exporter container exited unsuccessfully", "Exporter container exited unsuccessfully"],
    ["Exporter archive is not a regular file", "Exporter archive is not a regular file"],
    ["Authorization: Bearer inert-placeholder", "Exporter job failed"],
  ])("retains only curated exporter failures: %s", async (diagnostic, expected) => {
    const record = migration("export-failed");
    insertMigration(record);
    const source = adapter({
      submit: async () => ({ jobId: "export" }),
      inspect: async (jobId) => ({ jobId, state: "failed", failureReason: diagnostic }),
      cancel: async () => {},
    });
    const result = await runExporterGhesMigration(
      { id: record.id, sourceProvider: record.sourceProvider, emit: insertEvent },
      source,
    );
    const failureReason = `GitLab export failed: ${expected}`;
    expect(result).toMatchObject({ state: "failed", failureReason });
    expect(getGhesImportJobByMigrationId(record.id)).toMatchObject({
      phase: "failed",
      failureReason,
    });
    expect(JSON.stringify(getEvents(record.id))).not.toContain("inert-placeholder");
  });

  test.each([true, false])(
    "persists a prepare failure without a GUID, known busy rejection: %s",
    async (busy) => {
      const record = migration("prepare");
      insertMigration(record);
      const source = adapter({
        submit: async () => ({ jobId: "export" }),
        inspect: async (jobId) => ({
          jobId,
          state: "succeeded",
          archive: { path: "/tmp/prepare.tar.gz", sha256: "a".repeat(64) },
        }),
        cancel: async () => {},
      });
      const ssh = source.createSshClient({} as never);
      ssh.prepare = async () => {
        if (busy) throw new GhesMigratorBusyError();
        throw Object.assign(
          new Error("Authorization: Bearer inert-test-token", {
            cause: new Error("https://fixture.invalid/archive?signature=inert"),
          }),
          { status: 503 },
        );
      };
      source.createSshClient = () => ssh;
      const result = await runExporterGhesMigration(
        { id: record.id, sourceProvider: record.sourceProvider, emit: insertEvent },
        source,
      );
      if (!busy)
        expect(result.failureReason).toBe(
          "GHES import reached preparing. Operation failed (HTTP 503)",
        );
      const registration = activeMigrationRuns.claim(record.id)!;
      createMigrationRunFinisher(() => {}).settleResult(record.id, registration.token, result);
      expect(getMigration(record.id)?.failureReason).toBe(result.failureReason);
      expect(JSON.stringify(getEvents(record.id))).not.toMatch(/Authorization|inert|signature/);
      expect(result.state).toBe(busy ? "failed" : "reconciliation_required");
      expect(getGhesImportJobByMigrationId(record.id)).toMatchObject({
        failureReason: result.failureReason,
        phase: busy ? "failed" : "preparing",
        ghesImportId: null,
      });
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

  test.each(["failed", "cancelled", "reconciliation_required"] as const)(
    "keeps a legacy %s job with an uncertain GUID",
    async (phase) => {
      const record = migration("legacy-guid");
      insertMigration(record);
      const now = new Date().toISOString();
      insertGhesImportJob({
        id: "old-job",
        migrationId: record.id,
        phase,
        exporterJobId: "export",
        archivePath: "/tmp/archive",
        archiveSha256: "a".repeat(64),
        ghesImportId: "already-prepared",
        sourceWasArchived: true,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      });
      let submitted = 0;
      const source = adapter({
        submit: async () => {
          submitted++;
          return { jobId: "new" };
        },
        inspect: async () => ({ jobId: "new", state: "running" }),
        cancel: async () => {},
      });
      expect(
        (
          await runExporterGhesMigration(
            { id: record.id, sourceProvider: record.sourceProvider, emit: () => {} },
            source,
          )
        ).state,
      ).toBe("reconciliation_required");
      expect(getGhesImportJobByMigrationId(record.id)?.ghesImportId).toBe("already-prepared");
      expect(submitted).toBe(0);
    },
  );

  test.each(["auditing", "unlocking", "cancel-after-import", "source-unlock"] as const)(
    "continues with the same GHES GUID after %s without re-importing",
    async (failure) => {
      const record = { ...migration("post-import"), sourceProvider: "bitbucket-server" as const };
      insertMigration(record);
      let imports = 0;
      const expectedGuid = "migration-guid-123";
      const source = adapter({
        submit: async () => ({ jobId: "export" }),
        inspect: async (jobId) => ({
          jobId,
          state: "succeeded",
          archive: { path: "/tmp/fixture.tar", sha256: "a".repeat(64) },
        }),
        cancel: async () => {},
      });
      source.provider = record.sourceProvider;
      source.localMappingRecords = async () =>
        "model_name,source_url,target_url,state\nrepository,https://bb.example/project,,exported\n";
      const ssh = source.createSshClient({} as never);
      source.createSshClient = () => ssh;
      const cancel = new AbortController();
      let fail = true;
      if (failure === "source-unlock") {
        source.sourceWasLocked = async () => false;
        source.unlockSource = async () => {
          if (fail) throw new Error("Fixture disconnected");
        };
      }
      ssh.import = async (_path, guid) => {
        expect(guid).toBe(expectedGuid);
        imports++;
        if (failure === "cancel-after-import") cancel.abort();
        return { stdout: "", stderr: "" };
      };
      for (const [method, phase] of [
        ["auditFailures", "auditing"],
        ["unlock", "unlocking"],
      ] as const) {
        ssh[method] = async (guid) => {
          expect(guid).toBe(expectedGuid);
          if (fail && failure === phase) throw new Error("Fixture disconnected");
          return { stdout: "", stderr: "" };
        };
      }
      const options = { id: record.id, sourceProvider: record.sourceProvider, emit: () => {} };
      expect(
        (await runExporterGhesMigration({ ...options, signal: cancel.signal }, source)).state,
      ).toBe("reconciliation_required");
      expect(getGhesImportJobByMigrationId(record.id)).toMatchObject({
        phase:
          failure === "source-unlock"
            ? "succeeded"
            : failure === "unlocking"
              ? "unlocking"
              : "auditing",
        ghesImportId: expectedGuid,
      });
      fail = false;
      expect((await runExporterGhesMigration(options, source)).state).toBe("succeeded");
      expect(imports).toBe(1);
    },
  );
});
