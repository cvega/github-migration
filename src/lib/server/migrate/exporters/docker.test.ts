import { expect, test } from "bun:test";
import { type DockerExporterDependencies, DockerExporterWorker } from "./docker";

test.each([0, 1, null])("inspects the sandboxed exporter with exit code %s", async (exitCode) => {
  const calls: Array<{
    args: string[];
    environment?: Record<string, string>;
  }> = [];
  const removed: string[] = [];
  const dependencies: DockerExporterDependencies = {
    run: async (args, _signal, environment) => {
      calls.push({ args, environment });
      if (args[1] === "inspect") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Status: exitCode === null ? "created" : "exited",
            Running: false,
            ExitCode: exitCode,
            Error: "Authorization: Bearer inert-placeholder",
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    hash: async () => "a".repeat(64),
    stat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    statDirectory: async () => ({ isDirectory: () => true, uid: 100, gid: 101 }),
    remove: async (path) => {
      removed.push(path);
    },
  };
  const worker = new DockerExporterWorker(
    {
      exporterRuntime: "docker",
      exporterImage: "example/exporter:1",
      exporterArchiveVolume: "migration-archives",
      archiveDirectory: "/archives",
      sandbox: {
        cpus: 2,
        memory: "2g",
        network: "none",
        pidsLimit: 128,
        tmpfsSize: "64m",
      },
    },
    {
      provider: "gitlab",
      jobPrefix: "gh-migrate-gl",
      displayName: "GitLab",
      command: (_request, output) => ({
        environment: ["EXPORT_TOKEN=secret-value"],
        arguments: ["export", "--output", output],
      }),
    },
    dependencies,
  );
  const request = {
    migrationId: "Migration 1",
    sourceProvider: "gitlab" as const,
    sourceApiUrl: "https://gitlab.example/api/v4",
    sourceOrg: "platform",
    sourceRepo: "service",
    lockSource: true,
  };

  const submission = await worker.submit(request);
  const status = await worker.inspect(submission.jobId);

  expect(submission).toEqual({ jobId: "gh-migrate-gl-migration-1" });
  expect(removed).toEqual(["/archives/gh-migrate-gl-migration-1.tar.gz"]);
  expect(calls.map(({ args }) => args[1])).toEqual(["create", "start", "inspect"]);
  expect(calls[0]?.args).toContain("--read-only");
  expect(calls[0]?.args).toContain("--user");
  expect(calls[0]?.args).toContain("100:101");
  expect(calls[0]?.args).toContain("no-new-privileges");
  expect(calls[0]?.args).toContain("none");
  expect(calls[0]?.args).toContain("EXPORT_TOKEN");
  expect(calls[0]?.args).not.toContain("secret-value");
  expect(calls[0]?.environment).toEqual({ EXPORT_TOKEN: "secret-value" });
  expect(status).toEqual(
    exitCode === null
      ? {
          jobId: submission.jobId,
          state: "failed",
          failureReason: "Exporter container was never started",
        }
      : exitCode
        ? {
            jobId: submission.jobId,
            state: "failed",
            failureReason: "Exporter container exited unsuccessfully",
          }
        : {
            jobId: "gh-migrate-gl-migration-1",
            state: "succeeded",
            archive: {
              path: "/archives/gh-migrate-gl-migration-1.tar.gz",
              sha256: "a".repeat(64),
            },
          },
  );
});
