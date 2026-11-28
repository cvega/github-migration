import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { env } from "node:process";
import {
  type ConfigIssue,
  ConfigIssueError,
  collectConfigIssues,
  readPositiveIntegerSetting,
} from "$lib/server/core/config-issue";
import type { GitLabClient } from "./client";

type GitLabArchiveClient = Pick<GitLabClient, "downloadProjectExport">;

interface GitLabArchiveConfig {
  archiveDirectory: string;
  maxArchiveBytes: number;
  downloadTimeoutMs: number;
}

interface GitLabArchiveDependencies {
  config: GitLabArchiveConfig;
  newId(): string;
}

const DEFAULT_MAX_ARCHIVE_BYTES = 40 * 1024 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000;

function archiveDirectory(): string {
  const directory = env.ARCHIVE_DIR?.trim();
  if (!directory) throw new ConfigIssueError("ARCHIVE_DIR", "required");
  if (!isAbsolute(directory)) throw new ConfigIssueError("ARCHIVE_DIR", "absolute-path");
  return resolve(directory);
}

const maxArchiveBytes = () =>
  readPositiveIntegerSetting(
    "GITLAB_SOURCE_MAX_ARCHIVE_BYTES",
    env.GITLAB_SOURCE_MAX_ARCHIVE_BYTES,
    DEFAULT_MAX_ARCHIVE_BYTES,
  );
const downloadTimeoutMs = () =>
  readPositiveIntegerSetting(
    "GITLAB_SOURCE_ARCHIVE_DOWNLOAD_TIMEOUT_MS",
    env.GITLAB_SOURCE_ARCHIVE_DOWNLOAD_TIMEOUT_MS,
    DEFAULT_DOWNLOAD_TIMEOUT_MS,
  );

function defaultDependencies(): GitLabArchiveDependencies {
  return {
    config: {
      archiveDirectory: archiveDirectory(),
      maxArchiveBytes: maxArchiveBytes(),
      downloadTimeoutMs: downloadTimeoutMs(),
    },
    newId: () => Bun.randomUUIDv7(),
  };
}

/** Settings and fixed rules that keep GitLab archive storage from working; never values. */
export function getGitLabArchiveStorageIssues(): ConfigIssue[] {
  return collectConfigIssues([archiveDirectory, maxArchiveBytes, downloadTimeoutMs]);
}

export async function downloadGitLabArchive(
  client: GitLabArchiveClient,
  projectPath: string,
  signal?: AbortSignal,
  dependencies?: GitLabArchiveDependencies,
): Promise<string> {
  signal?.throwIfAborted();
  const deps = dependencies ?? defaultDependencies();
  const root = resolve(deps.config.archiveDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const finalPath = resolve(root, `gitlab-${deps.newId()}.tar.gz`);
  const partialPath = `${finalPath}.partial`;
  if (resolve(finalPath, "..") !== root || resolve(partialPath, "..") !== root) {
    throw new Error("GitLab archive path escaped ARCHIVE_DIR");
  }

  try {
    await client.downloadProjectExport(projectPath, partialPath, {
      signal,
      maxBytes: deps.config.maxArchiveBytes,
      timeoutMs: deps.config.downloadTimeoutMs,
    });
    signal?.throwIfAborted();
    const downloaded = await lstat(partialPath);
    if (!downloaded.isFile() || downloaded.isSymbolicLink()) {
      throw new Error("Downloaded GitLab archive was not a regular file");
    }
    if (downloaded.size < 1) throw new Error("Downloaded GitLab archive was empty");
    if (downloaded.size > deps.config.maxArchiveBytes) {
      throw new RangeError(`GitLab archive exceeds the ${deps.config.maxArchiveBytes}-byte limit`);
    }
    await rename(partialPath, finalPath);
    return finalPath;
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => {});
    await rm(finalPath, { force: true }).catch(() => {});
    throw error;
  }
}
