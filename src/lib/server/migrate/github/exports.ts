import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "$env/dynamic/private";
import type { CreateMigrationRequest, Migration } from "$lib/migrate/types";
import type { GitHubClients } from "$lib/server/core/github";
import { type GitHubClient, isVersionAtLeast } from "$lib/server/core/github";
import { sleep } from "$lib/server/core/polling";
import { getGitHubSourcePlatform } from "$lib/source-provider";
import { getOrgDatabaseId } from "./migration-source";
import { uploadArchive } from "./upload";

interface GhesMetaResponse {
  installed_version: string;
}

interface GhesMigrationResponse {
  id: number;
  state: string;
}

const MIN_GHES_VERSION = "3.15.0";

export async function checkGhesVersion(client: GitHubClient): Promise<string> {
  const { data } = await client.request("GET /api/v3/meta");
  const version = (data as GhesMetaResponse).installed_version;
  if (!version) throw new Error("Could not determine GHES version");
  if (!isVersionAtLeast(version, MIN_GHES_VERSION)) {
    throw new Error(`GHES version ${version} is below minimum required ${MIN_GHES_VERSION}`);
  }
  return version;
}

export async function startGitArchiveExport(
  client: GitHubClient,
  org: string,
  repo: string,
): Promise<number> {
  const { data } = await client.request("POST /api/v3/orgs/{org}/migrations", {
    org,
    repositories: [repo],
    exclude_metadata: true,
  });
  return (data as GhesMigrationResponse).id;
}

export async function startMetadataArchiveExport(
  client: GitHubClient,
  org: string,
  repo: string,
  skipReleases: boolean,
  lockSource: boolean,
): Promise<number> {
  const { data } = await client.request("POST /api/v3/orgs/{org}/migrations", {
    org,
    repositories: [repo],
    exclude_git_data: true,
    exclude_releases: skipReleases,
    lock_repositories: lockSource,
    exclude_owner_projects: true,
  });
  return (data as GhesMigrationResponse).id;
}

async function getArchiveStatus(
  client: GitHubClient,
  org: string,
  archiveId: number,
): Promise<string> {
  const { data } = await client.request("GET /api/v3/orgs/{org}/migrations/{migration_id}", {
    org,
    migration_id: archiveId,
  });
  return (data as GhesMigrationResponse).state;
}

async function getArchiveUrl(
  client: GitHubClient,
  org: string,
  archiveId: number,
): Promise<string> {
  const { data } = await client.request(
    "GET /api/v3/orgs/{org}/migrations/{migration_id}/archive",
    { org, migration_id: archiveId },
  );
  return typeof data === "string" ? data.trim() : "";
}

export async function waitForArchive(
  client: GitHubClient,
  org: string,
  archiveId: number,
  signal?: AbortSignal,
  pollInterval = 60_000,
  maxWaitMs = 2 * 60 * 60 * 1_000,
): Promise<string> {
  const deadline = Date.now() + maxWaitMs;
  while (!signal?.aborted) {
    const status = await getArchiveStatus(client, org, archiveId);
    if (status === "exported") return getArchiveUrl(client, org, archiveId);
    if (status === "failed") throw new Error(`Archive export ${archiveId} failed`);
    if (Date.now() >= deadline) {
      throw new Error(
        `Archive export ${archiveId} timed out after ${Math.round(maxWaitMs / 60_000)} minutes`,
      );
    }
    await sleep(pollInterval, signal);
  }
  throw new Error("Archive wait aborted");
}

const defaultTransportDependencies = {
  startGitArchiveExport,
  startMetadataArchiveExport,
  waitForArchive,
  getOrgDatabaseId,
  uploadArchive,
};
let transportDependencies = { ...defaultTransportDependencies };
const ARCHIVE_REDIRECT_LIMIT = 5;
const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000;
const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024 * 1024;

type ArchiveOptions = Pick<
  CreateMigrationRequest,
  "directPassthrough" | "lockSource" | "noSslVerify" | "skipReleases"
> & { signal?: AbortSignal };

export function __setArchiveTransportDependenciesForTests(
  overrides: Partial<typeof defaultTransportDependencies>,
): () => void {
  transportDependencies = { ...defaultTransportDependencies, ...overrides };
  return () => {
    transportDependencies = { ...defaultTransportDependencies };
  };
}

async function runArchivePair<Left, Right>(
  parentSignal: AbortSignal | undefined,
  left: (signal: AbortSignal) => Promise<Left>,
  right: (signal: AbortSignal) => Promise<Right>,
): Promise<[Left, Right]> {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  const pending = [left(signal), right(signal)] as const;
  try {
    return await Promise.all(pending);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(pending);
    throw error;
  }
}

async function startArchivePair(
  clients: GitHubClients,
  migration: Migration,
  options: ArchiveOptions,
): Promise<{ gitArchiveId: number; metadataArchiveId: number }> {
  const gitArchiveId = await transportDependencies.startGitArchiveExport(
    clients.source,
    migration.sourceOrg,
    migration.sourceRepo,
  );
  const metadataArchiveId = await transportDependencies.startMetadataArchiveExport(
    clients.source,
    migration.sourceOrg,
    migration.sourceRepo,
    options.skipReleases ?? false,
    options.lockSource ?? false,
  );
  return { gitArchiveId, metadataArchiveId };
}

export async function resolveMigrationArchives(
  clients: GitHubClients,
  migration: Migration,
  options: ArchiveOptions,
  emitStep: (message: string) => void,
): Promise<{ gitArchiveUrl: string; metadataArchiveUrl: string }> {
  if (getGitHubSourcePlatform(migration.sourceApiUrl) === "ghec") {
    emitStep("GHEC to GHEC migration - no archive export needed");
    return { gitArchiveUrl: "", metadataArchiveUrl: "" };
  }

  emitStep(
    options.directPassthrough
      ? "Exporting archives from source (direct transfer)"
      : "Exporting archives from source",
  );
  const { gitArchiveId, metadataArchiveId } = await startArchivePair(clients, migration, options);
  if (options.directPassthrough) {
    const gitArchiveUrl = await transportDependencies.waitForArchive(
      clients.source,
      migration.sourceOrg,
      gitArchiveId,
      options.signal,
    );
    const metadataArchiveUrl = await transportDependencies.waitForArchive(
      clients.source,
      migration.sourceOrg,
      metadataArchiveId,
      options.signal,
    );
    assertTrustedArchiveHost(gitArchiveUrl, migration.sourceApiUrl);
    assertTrustedArchiveHost(metadataArchiveUrl, migration.sourceApiUrl);
    return { gitArchiveUrl, metadataArchiveUrl };
  }

  emitStep("Waiting for archive exports to complete");
  const [gitSourceUrl, metadataSourceUrl] = await runArchivePair(
    options.signal,
    (signal) =>
      transportDependencies.waitForArchive(
        clients.source,
        migration.sourceOrg,
        gitArchiveId,
        signal,
      ),
    (signal) =>
      transportDependencies.waitForArchive(
        clients.source,
        migration.sourceOrg,
        metadataArchiveId,
        signal,
      ),
  );

  emitStep("Downloading archives from source");
  const archiveBase = env.ARCHIVE_DIR || tmpdir();
  mkdirSync(archiveBase, { recursive: true });
  const temporaryDirectory = mkdtempSync(join(archiveBase, "gh-migrate-"));
  try {
    const gitPath = join(temporaryDirectory, "git-archive.tar.gz");
    const metadataPath = join(temporaryDirectory, "metadata-archive.tar.gz");
    const sourceToken = await clients.getSourceToken();
    await runArchivePair(
      options.signal,
      (signal) =>
        downloadArchiveToFile(gitSourceUrl, sourceToken, gitPath, {
          noSslVerify: options.noSslVerify,
          sourceApiUrl: migration.sourceApiUrl,
          signal,
        }),
      (signal) =>
        downloadArchiveToFile(metadataSourceUrl, sourceToken, metadataPath, {
          noSslVerify: options.noSslVerify,
          sourceApiUrl: migration.sourceApiUrl,
          signal,
        }),
    );

    emitStep("Uploading archives to GitHub storage");
    const organizationId = await transportDependencies.getOrgDatabaseId(
      clients.targetGraphql,
      migration.targetOrg,
    );
    const targetToken = await clients.getTargetToken();
    const gitArchiveUrl = await transportDependencies.uploadArchive(
      Bun.file(gitPath),
      "git-archive.tar.gz",
      organizationId,
      targetToken,
      undefined,
      options.signal,
    );
    const metadataArchiveUrl = await transportDependencies.uploadArchive(
      Bun.file(metadataPath),
      "metadata-archive.tar.gz",
      organizationId,
      targetToken,
      undefined,
      options.signal,
    );
    emitStep("Archives uploaded");
    return { gitArchiveUrl, metadataArchiveUrl };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function assertTrustedArchiveHost(downloadUrl: string, sourceApiUrl: string): void {
  const download = new URL(downloadUrl);
  const source = new URL(sourceApiUrl);
  if (download.origin !== source.origin) {
    throw new Error(
      `Refusing to send credentials to ${download.origin} - expected ${source.origin}`,
    );
  }
}

async function downloadArchiveToFile(
  url: string,
  token: string,
  destinationPath: string,
  options: {
    noSslVerify?: boolean;
    sourceApiUrl: string;
    signal?: AbortSignal;
    maxBytes?: number;
    timeoutMs?: number;
  },
): Promise<void> {
  const maxBytes = options.maxBytes ?? ARCHIVE_MAX_BYTES;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? ARCHIVE_DOWNLOAD_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let currentUrl = url;
  let response: Response | undefined;
  let writer: ReturnType<ReturnType<typeof Bun.file>["writer"]> | undefined;
  try {
    for (let redirects = 0; redirects <= ARCHIVE_REDIRECT_LIMIT; redirects += 1) {
      assertTrustedArchiveHost(currentUrl, options.sourceApiUrl);
      response = await fetch(currentUrl, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
        signal,
        ...(options.noSslVerify ? { tls: { rejectUnauthorized: false } } : {}),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new Error("Archive redirect did not include a location");
      if (redirects === ARCHIVE_REDIRECT_LIMIT) {
        throw new Error("Archive download exceeded the redirect limit");
      }
      currentUrl = new URL(location, currentUrl).toString();
    }
    if (!response?.ok) throw new Error(`Download failed: ${response?.status ?? "no response"}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`Archive exceeds the ${maxBytes}-byte download limit`);
    }
    if (!response.body) throw new Error("Archive download returned an empty body");

    writer = Bun.file(destinationPath).writer();
    let bytesWritten = 0;
    const reader = response.body.getReader();
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytesWritten += value.byteLength;
      if (bytesWritten > maxBytes) {
        await reader.cancel();
        throw new Error(`Archive exceeds the ${maxBytes}-byte download limit`);
      }
      writer.write(value);
    }
    await writer.flush();
  } catch (error) {
    rmSync(destinationPath, { force: true });
    throw error;
  } finally {
    writer?.end();
  }
}
