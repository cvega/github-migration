import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadGitLabArchive } from "./archive";

describe("downloadGitLabArchive", () => {
  test("publishes a completed archive atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitlab-archive-"));
    const calls: unknown[][] = [];
    try {
      const path = await downloadGitLabArchive(
        {
          downloadProjectExport: async (...args) => {
            calls.push(args);
            await writeFile(args[1], "archive");
          },
        },
        "platform/services/widget",
        undefined,
        {
          config: { archiveDirectory: root, maxArchiveBytes: 1024, downloadTimeoutMs: 5000 },
          newId: () => "export-id",
        },
      );

      expect(path).toBe(join(root, "gitlab-export-id.tar.gz"));
      expect(await Bun.file(path).text()).toBe("archive");
      expect(calls[0]?.[0]).toBe("platform/services/widget");
      expect(calls[0]?.[2]).toMatchObject({ maxBytes: 1024, timeoutMs: 5000 });
      expect(await Bun.file(`${path}.partial`).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes partial and final files after a failed download", async () => {
    const root = await mkdtemp(join(tmpdir(), "gitlab-archive-"));
    const finalPath = join(root, "gitlab-failed-id.tar.gz");
    try {
      await expect(
        downloadGitLabArchive(
          {
            downloadProjectExport: async (_project, partialPath) => {
              await writeFile(partialPath, "partial");
              throw new Error("download failed");
            },
          },
          "platform/widget",
          undefined,
          {
            config: { archiveDirectory: root, maxArchiveBytes: 1024, downloadTimeoutMs: 5000 },
            newId: () => "failed-id",
          },
        ),
      ).rejects.toThrow("download failed");
      expect(await Bun.file(finalPath).exists()).toBe(false);
      expect(await Bun.file(`${finalPath}.partial`).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
