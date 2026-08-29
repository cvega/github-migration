import { expect, test } from "bun:test";
import { GitLabExporterWorker } from "./gitlab";

test("uses a deterministic GitLab exporter container identity", () => {
  const worker = new GitLabExporterWorker({} as never);
  expect(
    worker.identify({
      migrationId: "Migration 1",
      sourceProvider: "gitlab",
      sourceApiUrl: "https://gitlab.example/api/v4",
      sourceOrg: "group",
      sourceRepo: "project",
      lockSource: true,
    }),
  ).toBe("gh-migrate-gl-migration-1");
});
