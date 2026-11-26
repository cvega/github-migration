import { expect, test } from "bun:test";
import { GitLabExporterWorker } from "./gitlab";

const worker = new GitLabExporterWorker({
  exporterRuntime: "docker",
  exporterImage: "local/gl-exporter:test",
  exporterArchiveVolume: "test-archives",
  archiveDirectory: "/archives",
  sandbox: { network: "none", memory: "1g", cpus: 1, pidsLimit: 128, tmpfsSize: "64m" },
  gitlabUsername: "test-user",
  gitlabToken: "test-token",
});
const request = {
  migrationId: "Migration 1",
  sourceProvider: "gitlab" as const,
  sourceApiUrl: "https://gitlab.example/api/v4",
  sourceOrg: "parent/subgroup",
  sourceRepo: "project",
  lockSource: false,
};

test("uses a deterministic GitLab exporter container identity", () => {
  expect(worker.identify(request)).toBe("gh-migrate-gl-migration-1");
});

test.each([false, true])("invokes the release executable with lockSource=%s", (lockSource) => {
  const output = "/workspace/export.tar.gz";
  const command = worker.definition.command({ ...request, lockSource }, output);
  expect(command.arguments).toEqual([
    "gl_exporter",
    "--namespace",
    "parent/subgroup",
    "--project",
    "project",
    "--out-file",
    output,
    `--lock-projects=${lockSource}`,
  ]);
  expect(command.environment).toEqual([
    "GITLAB_API_ENDPOINT=https://gitlab.example/api/v4",
    "GITLAB_USERNAME=test-user",
    "GITLAB_API_PRIVATE_TOKEN=test-token",
  ]);
});
