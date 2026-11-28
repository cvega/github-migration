import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadGitLabArchive, getGitLabArchiveStorageIssues } from "./archive";

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

describe("GitLab archive storage configuration issues", () => {
  const keys = [
    "ARCHIVE_DIR",
    "GITLAB_SOURCE_MAX_ARCHIVE_BYTES",
    "GITLAB_SOURCE_ARCHIVE_DOWNLOAD_TIMEOUT_MS",
  ] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const key of keys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("reports missing, invalid and valid settings by name and rule only", () => {
    expect(getGitLabArchiveStorageIssues().map((issue) => issue.text)).toEqual([
      "ARCHIVE_DIR is required",
    ]);

    process.env.ARCHIVE_DIR = "relative/synthetic-value";
    expect(getGitLabArchiveStorageIssues().map((issue) => issue.text)).toEqual([
      "ARCHIVE_DIR must be an absolute path",
    ]);

    process.env.ARCHIVE_DIR = "/archives";
    process.env.GITLAB_SOURCE_MAX_ARCHIVE_BYTES = "synthetic-not-a-number";
    const issues = getGitLabArchiveStorageIssues();
    expect(issues.map((issue) => issue.text)).toEqual([
      "GITLAB_SOURCE_MAX_ARCHIVE_BYTES must be a positive integer",
    ]);
    expect(JSON.stringify(issues)).not.toContain("synthetic");

    delete process.env.GITLAB_SOURCE_MAX_ARCHIVE_BYTES;
    expect(getGitLabArchiveStorageIssues()).toEqual([]);
  });
});
