import { isAbsolute, resolve } from "node:path";
import { env } from "node:process";
import type { MigrationTargetProfile } from "$lib/migration-target";
import { type ExporterSandboxPolicy, getExporterSandboxPolicy } from "./exporter-sandbox";
import { getMigrationTargetProfile } from "./targets";

export interface GhesTargetConnectionConfig {
  profile: MigrationTargetProfile & { platform: "ghes" };
  siteAdminUsername: string;
  siteAdminToken: string;
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshPrivateKey: string;
  sshHostFingerprint: string;
  remoteDirectory: string;
}

interface GhesExporterConfig extends GhesTargetConnectionConfig {
  exporterRuntime: string;
  exporterImage: string;
  exporterArchiveVolume: string;
  archiveDirectory: string;
  sandbox: ExporterSandboxPolicy;
}

export interface GhesTargetExecutionConfig extends GhesExporterConfig {
  gitlabUsername: string;
  gitlabToken: string;
}

export interface BitbucketGhesTargetExecutionConfig extends GhesExporterConfig {
  bitbucketUsername: string;
  bitbucketPassword: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError("GHES_TARGET_SSH_PORT must be an integer between 1 and 65535");
  }
  return parsed;
}

function decodePrivateKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) return trimmed;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
  if (!decoded.startsWith("-----BEGIN")) {
    throw new TypeError("GHES_TARGET_SSH_PRIVATE_KEY must be PEM or base64-encoded PEM");
  }
  return decoded;
}

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required for GHES migration execution`);
  return trimmed;
}

function getGhesTargetConnectionConfig(profileId?: string): GhesTargetConnectionConfig {
  const effectiveProfileId = profileId?.trim() || env.GHES_TARGET_ID?.trim() || "ghes";
  const profile = getMigrationTargetProfile(effectiveProfileId);
  if (profile?.platform !== "ghes") {
    throw new TypeError(`GHES target profile '${effectiveProfileId}' is not configured`);
  }

  const remoteDirectory = env.GHES_TARGET_REMOTE_DIR?.trim() || "/home/admin";
  if (!isAbsolute(remoteDirectory)) {
    throw new TypeError("GHES_TARGET_REMOTE_DIR must be an absolute path");
  }

  return {
    profile: profile as MigrationTargetProfile & { platform: "ghes" },
    siteAdminUsername: required("GHES_TARGET_ADMIN_USERNAME", env.GHES_TARGET_ADMIN_USERNAME),
    siteAdminToken: required("GHES_TARGET_ADMIN_PAT", env.GHES_TARGET_ADMIN_PAT),
    sshHost: env.GHES_TARGET_SSH_HOST?.trim() || new URL(profile.webUrl).hostname,
    sshPort: positiveInteger(env.GHES_TARGET_SSH_PORT, 122),
    sshUsername: env.GHES_TARGET_SSH_USERNAME?.trim() || "admin",
    sshPrivateKey: decodePrivateKey(
      required("GHES_TARGET_SSH_PRIVATE_KEY", env.GHES_TARGET_SSH_PRIVATE_KEY),
    ),
    sshHostFingerprint: required(
      "GHES_TARGET_SSH_HOST_KEY_SHA256",
      env.GHES_TARGET_SSH_HOST_KEY_SHA256,
    ).replace(/^SHA256:/i, ""),
    remoteDirectory: remoteDirectory.replace(/\/+$/, ""),
  };
}

function getExporterConfig(): Pick<
  GhesExporterConfig,
  "exporterRuntime" | "exporterArchiveVolume" | "archiveDirectory" | "sandbox"
> {
  const exporterRuntime =
    env.EXPORTER_RUNTIME?.trim() || env.GL_EXPORTER_RUNTIME?.trim() || "docker";
  if (!/^[A-Za-z0-9._/-]+$/.test(exporterRuntime)) {
    throw new TypeError("EXPORTER_RUNTIME is invalid");
  }
  const archiveDirectory = required("ARCHIVE_DIR", env.ARCHIVE_DIR);
  if (!isAbsolute(archiveDirectory)) throw new TypeError("ARCHIVE_DIR must be an absolute path");
  return {
    exporterRuntime,
    exporterArchiveVolume: required(
      "EXPORTER_ARCHIVE_VOLUME",
      env.EXPORTER_ARCHIVE_VOLUME ?? env.GL_EXPORTER_ARCHIVE_VOLUME,
    ),
    archiveDirectory: resolve(archiveDirectory),
    sandbox: getExporterSandboxPolicy(),
  };
}

export function getGhesTargetExecutionConfig(profileId?: string): GhesTargetExecutionConfig {
  return {
    ...getGhesTargetConnectionConfig(profileId),
    ...getExporterConfig(),
    exporterImage: required("GL_EXPORTER_IMAGE", env.GL_EXPORTER_IMAGE),
    gitlabUsername: required("GITLAB_SOURCE_USERNAME", env.GITLAB_SOURCE_USERNAME),
    gitlabToken: required("GITLAB_SOURCE_PAT", env.GITLAB_SOURCE_PAT),
  };
}

export function getBitbucketGhesTargetExecutionConfig(
  profileId?: string,
): BitbucketGhesTargetExecutionConfig {
  return {
    ...getGhesTargetConnectionConfig(profileId),
    ...getExporterConfig(),
    exporterImage: required("BBS_EXPORTER_IMAGE", env.BBS_EXPORTER_IMAGE),
    bitbucketUsername: required("BITBUCKET_SERVER_USERNAME", env.BITBUCKET_SERVER_USERNAME),
    bitbucketPassword: required("BITBUCKET_SERVER_PASSWORD", env.BITBUCKET_SERVER_PASSWORD),
  };
}

export function isGhesTargetExecutionConfigured(
  profileId?: string,
  sourceProvider: "gitlab" | "bitbucket-server" = "gitlab",
): boolean {
  try {
    if (sourceProvider === "gitlab") getGhesTargetExecutionConfig(profileId);
    else getBitbucketGhesTargetExecutionConfig(profileId);
    return true;
  } catch {
    return false;
  }
}
