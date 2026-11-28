import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { env } from "node:process";
import SftpClient from "ssh2-sftp-client";
import {
  type ConfigIssue,
  ConfigIssueError,
  collectConfigIssues,
} from "$lib/server/core/config-issue";
import { verifySshHostKey } from "$lib/server/core/ssh-host-key";

interface SftpArchiveConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  hostFingerprint: string;
  sharedHome: string;
  archiveDirectory: string;
  maxArchiveBytes: number;
}

export interface SftpArchiveClient {
  connect(config: Record<string, unknown>): Promise<unknown>;
  stat(path: string): Promise<{ size?: number | string }>;
  fastGet(remotePath: string, localPath: string): Promise<string>;
  end(): Promise<unknown>;
}

interface ArchiveDependencies {
  config: SftpArchiveConfig;
  createClient(): SftpArchiveClient;
  newId(): string;
}

const DEFAULT_SHARED_HOME = "/var/atlassian/application-data/bitbucket/shared";
const DEFAULT_MAX_ARCHIVE_BYTES = 40 * 1024 * 1024 * 1024;

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ConfigIssueError(name, "positive-integer");
  }
  return parsed;
}

function decodePrivateKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) return trimmed;
  return Buffer.from(trimmed, "base64").toString("utf8");
}

function required(name: string, raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) throw new ConfigIssueError(name, "required");
  return value;
}

function sourceUrl(): URL {
  const value = required("BITBUCKET_SERVER_URL", env.BITBUCKET_SERVER_URL);
  try {
    return new URL(value);
  } catch {
    throw new ConfigIssueError("BITBUCKET_SERVER_URL", "valid-url");
  }
}

function archiveDirectory(): string {
  const directory = required("ARCHIVE_DIR", env.ARCHIVE_DIR);
  if (!isAbsolute(directory)) throw new ConfigIssueError("ARCHIVE_DIR", "absolute-path");
  return resolve(directory);
}

function sharedHome(): string {
  const home = env.BITBUCKET_SERVER_SHARED_HOME?.trim() || DEFAULT_SHARED_HOME;
  if (!isAbsolute(home))
    throw new ConfigIssueError("BITBUCKET_SERVER_SHARED_HOME", "absolute-path");
  return home.replace(/\/+$/, "");
}

const sshPort = () =>
  positiveInteger("BITBUCKET_SERVER_SSH_PORT", env.BITBUCKET_SERVER_SSH_PORT, 22);
const maxArchiveBytes = () =>
  positiveInteger(
    "BITBUCKET_SERVER_MAX_ARCHIVE_BYTES",
    env.BITBUCKET_SERVER_MAX_ARCHIVE_BYTES,
    DEFAULT_MAX_ARCHIVE_BYTES,
  );

function loadSftpArchiveConfig(): SftpArchiveConfig {
  const url = sourceUrl();
  const username = required("BITBUCKET_SERVER_SSH_USERNAME", env.BITBUCKET_SERVER_SSH_USERNAME);
  const privateKey = required(
    "BITBUCKET_SERVER_SSH_PRIVATE_KEY",
    env.BITBUCKET_SERVER_SSH_PRIVATE_KEY,
  );
  const hostFingerprint = required(
    "BITBUCKET_SERVER_SSH_HOST_KEY_SHA256",
    env.BITBUCKET_SERVER_SSH_HOST_KEY_SHA256,
  );
  const archive = archiveDirectory();
  return {
    host: env.BITBUCKET_SERVER_SSH_HOST?.trim() || url.hostname,
    port: sshPort(),
    username,
    privateKey: decodePrivateKey(privateKey),
    hostFingerprint: hostFingerprint.replace(/^SHA256:/i, ""),
    sharedHome: sharedHome(),
    archiveDirectory: archive,
    maxArchiveBytes: maxArchiveBytes(),
  };
}

/** Settings and fixed rules that keep Bitbucket SFTP from working; never values. */
export function getBitbucketSftpIssues(): ConfigIssue[] {
  return collectConfigIssues([
    sourceUrl,
    () => required("BITBUCKET_SERVER_SSH_USERNAME", env.BITBUCKET_SERVER_SSH_USERNAME),
    () => required("BITBUCKET_SERVER_SSH_PRIVATE_KEY", env.BITBUCKET_SERVER_SSH_PRIVATE_KEY),
    () =>
      required("BITBUCKET_SERVER_SSH_HOST_KEY_SHA256", env.BITBUCKET_SERVER_SSH_HOST_KEY_SHA256),
    archiveDirectory,
    sharedHome,
    sshPort,
    maxArchiveBytes,
  ]);
}

function defaultDependencies(): ArchiveDependencies {
  return {
    config: loadSftpArchiveConfig(),
    createClient: () => new SftpClient() as SftpArchiveClient,
    newId: () => Bun.randomUUIDv7(),
  };
}

function safeSize(value: number | string | undefined): number {
  const size = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(size) || (size ?? -1) < 0) {
    throw new Error("Bitbucket archive size was invalid");
  }
  return size as number;
}

export async function downloadBitbucketArchive(
  exportId: string,
  signal?: AbortSignal,
  dependencies?: ArchiveDependencies,
): Promise<string> {
  if (!/^[1-9]\d*$/.test(exportId)) {
    throw new TypeError("Bitbucket export ID must be a positive integer");
  }
  signal?.throwIfAborted();
  const deps = dependencies ?? defaultDependencies();
  const root = resolve(deps.config.archiveDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const baseName = `bitbucket-${deps.newId()}.tar`;
  const finalPath = resolve(root, baseName);
  const partialPath = `${finalPath}.partial`;
  if (resolve(finalPath, "..") !== root || resolve(partialPath, "..") !== root) {
    throw new Error("Bitbucket archive path escaped ARCHIVE_DIR");
  }
  const remotePath = join(
    deps.config.sharedHome,
    "data/migration/export",
    `Bitbucket_export_${exportId}.tar`,
  ).replaceAll("\\", "/");
  const sftp = deps.createClient();
  const abort = () => {
    void sftp.end().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    await sftp.connect({
      host: deps.config.host,
      port: deps.config.port,
      username: deps.config.username,
      privateKey: deps.config.privateKey,
      hostVerifier: (key: Buffer) => verifySshHostKey(key, deps.config.hostFingerprint),
    });
    signal?.throwIfAborted();
    const remoteSize = safeSize((await sftp.stat(remotePath)).size);
    if (remoteSize > deps.config.maxArchiveBytes) {
      throw new RangeError(
        `Bitbucket archive exceeds the ${deps.config.maxArchiveBytes}-byte limit`,
      );
    }
    await sftp.fastGet(remotePath, partialPath);
    signal?.throwIfAborted();
    const downloaded = await lstat(partialPath);
    if (!downloaded.isFile() || downloaded.isSymbolicLink()) {
      throw new Error("Downloaded Bitbucket archive was not a regular file");
    }
    if (downloaded.size !== remoteSize) {
      throw new Error("Downloaded Bitbucket archive size did not match the source");
    }
    await rename(partialPath, finalPath);
    return finalPath;
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => {});
    await rm(finalPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    await sftp.end().catch(() => {});
  }
}
