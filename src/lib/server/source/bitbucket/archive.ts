import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import SftpClient from "ssh2-sftp-client";
import { env } from "$env/dynamic/private";
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

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new TypeError("Expected a positive integer");
  return parsed;
}

function decodePrivateKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) return trimmed;
  return Buffer.from(trimmed, "base64").toString("utf8");
}

function loadSftpArchiveConfig(): SftpArchiveConfig {
  const sourceUrl = env.BITBUCKET_SERVER_URL?.trim();
  const username = env.BITBUCKET_SERVER_SSH_USERNAME?.trim();
  const privateKey = env.BITBUCKET_SERVER_SSH_PRIVATE_KEY?.trim();
  const hostFingerprint = env.BITBUCKET_SERVER_SSH_HOST_KEY_SHA256?.trim();
  const archiveDirectory = env.ARCHIVE_DIR?.trim();
  if (!sourceUrl || !username || !privateKey || !hostFingerprint || !archiveDirectory) {
    throw new Error(
      "Bitbucket SFTP requires BITBUCKET_SERVER_URL, BITBUCKET_SERVER_SSH_USERNAME, BITBUCKET_SERVER_SSH_PRIVATE_KEY, BITBUCKET_SERVER_SSH_HOST_KEY_SHA256, and ARCHIVE_DIR",
    );
  }
  const url = new URL(sourceUrl);
  if (!isAbsolute(archiveDirectory)) throw new TypeError("ARCHIVE_DIR must be an absolute path");
  const sharedHome = env.BITBUCKET_SERVER_SHARED_HOME?.trim() || DEFAULT_SHARED_HOME;
  if (!isAbsolute(sharedHome)) {
    throw new TypeError("BITBUCKET_SERVER_SHARED_HOME must be an absolute path");
  }
  return {
    host: env.BITBUCKET_SERVER_SSH_HOST?.trim() || url.hostname,
    port: positiveInteger(env.BITBUCKET_SERVER_SSH_PORT, 22),
    username,
    privateKey: decodePrivateKey(privateKey),
    hostFingerprint: hostFingerprint.replace(/^SHA256:/i, ""),
    sharedHome: sharedHome.replace(/\/+$/, ""),
    archiveDirectory: resolve(archiveDirectory),
    maxArchiveBytes: positiveInteger(
      env.BITBUCKET_SERVER_MAX_ARCHIVE_BYTES,
      DEFAULT_MAX_ARCHIVE_BYTES,
    ),
  };
}

export function isBitbucketSftpConfigured(): boolean {
  try {
    loadSftpArchiveConfig();
    return true;
  } catch {
    return false;
  }
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
