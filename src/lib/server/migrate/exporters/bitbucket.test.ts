import { expect, test } from "bun:test";
import { BitbucketExporterWorker } from "./bitbucket";

test("uses a deterministic Bitbucket exporter container identity", () => {
  const worker = new BitbucketExporterWorker({} as never);
  expect(
    worker.identify({
      migrationId: "Migration 1",
      sourceProvider: "bitbucket-server",
      sourceApiUrl: "https://bitbucket.example/rest/api/1.0",
      sourceOrg: "PROJ",
      sourceRepo: "repo",
      lockSource: false,
    }),
  ).toBe("gh-migrate-bbs-migration-1");
});
