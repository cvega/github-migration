import { isAbsolute, resolve } from "node:path";
import { env } from "node:process";
import type { MigrationTargetProfile } from "$lib/migration-target";
import { type ConfigIssue, ConfigIssueError, collectConfigIssues } from "./config-issue";
import {
  type ExporterSandboxPolicy,
  exporterSandboxChecks,
  getExporterSandboxPolicy,
} from "./exporter-sandbox";
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

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new ConfigIssueError(name, "required");
  return trimmed;
}

function remoteDirectory(): string {
  const directory = env.GHES_TARGET_REMOTE_DIR?.trim() || "/home/admin";
  if (!isAbsolute(directory)) throw new ConfigIssueError("GHES_TARGET_REMOTE_DIR", "absolute-path");
  return directory.replace(/\/+$/, "");
}

function sshPort(): number {
  const value = env.GHES_TARGET_SSH_PORT;
  if (!value?.trim()) return 122;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new ConfigIssueError("GHES_TARGET_SSH_PORT", "port");
  }
  return parsed;
}

function sshPrivateKey(): string {
  const trimmed = required("GHES_TARGET_SSH_PRIVATE_KEY", env.GHES_TARGET_SSH_PRIVATE_KEY);
  if (trimmed.startsWith("-----BEGIN")) return trimmed;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
  if (!decoded.startsWith("-----BEGIN")) {
    throw new ConfigIssueError("GHES_TARGET_SSH_PRIVATE_KEY", "pem-private-key");
  }
  return decoded;
}

function sshHostFingerprint(): string {
  return required("GHES_TARGET_SSH_HOST_KEY_SHA256", env.GHES_TARGET_SSH_HOST_KEY_SHA256).replace(
    /^SHA256:/i,
    "",
  );
}

function ghesProfile(profileId?: string): MigrationTargetProfile & { platform: "ghes" } {
  const effectiveProfileId = profileId?.trim() || env.GHES_TARGET_ID?.trim() || "ghes";
  const profile = getMigrationTargetProfile(effectiveProfileId);
  if (profile?.platform !== "ghes") {
    throw new TypeError(`GHES target profile '${effectiveProfileId}' is not configured`);
  }
  return profile as MigrationTargetProfile & { platform: "ghes" };
}

export function getGhesTargetConnectionConfig(profileId?: string): GhesTargetConnectionConfig {
  const profile = ghesProfile(profileId);
  return {
    profile,
    siteAdminUsername: required("GHES_TARGET_ADMIN_USERNAME", env.GHES_TARGET_ADMIN_USERNAME),
    siteAdminToken: required("GHES_TARGET_ADMIN_PAT", env.GHES_TARGET_ADMIN_PAT),
    sshHost: env.GHES_TARGET_SSH_HOST?.trim() || new URL(profile.webUrl).hostname,
    sshPort: sshPort(),
    sshUsername: env.GHES_TARGET_SSH_USERNAME?.trim() || "admin",
    sshPrivateKey: sshPrivateKey(),
    sshHostFingerprint: sshHostFingerprint(),
    remoteDirectory: remoteDirectory(),
  };
}

function exporterRuntime(): string {
  const runtime = env.EXPORTER_RUNTIME?.trim() || "docker";
  if (!/^[A-Za-z0-9._/-]+$/.test(runtime)) {
    throw new ConfigIssueError("EXPORTER_RUNTIME", "exporter-runtime");
  }
  return runtime;
}

function archiveDirectory(): string {
  const directory = required("ARCHIVE_DIR", env.ARCHIVE_DIR);
  if (!isAbsolute(directory)) throw new ConfigIssueError("ARCHIVE_DIR", "absolute-path");
  return resolve(directory);
}

function getExporterConfig(): Pick<
  GhesExporterConfig,
  "exporterRuntime" | "exporterArchiveVolume" | "archiveDirectory" | "sandbox"
> {
  return {
    exporterRuntime: exporterRuntime(),
    exporterArchiveVolume: required("EXPORTER_ARCHIVE_VOLUME", env.EXPORTER_ARCHIVE_VOLUME),
    archiveDirectory: archiveDirectory(),
    sandbox: getExporterSandboxPolicy(),
  };
}

const gitlabSettings = {
  exporterImage: () => required("GL_EXPORTER_IMAGE", env.GL_EXPORTER_IMAGE),
  gitlabUsername: () => required("GITLAB_SOURCE_USERNAME", env.GITLAB_SOURCE_USERNAME),
  gitlabToken: () => required("GITLAB_SOURCE_PAT", env.GITLAB_SOURCE_PAT),
};

const bitbucketSettings = {
  exporterImage: () => required("BBS_EXPORTER_IMAGE", env.BBS_EXPORTER_IMAGE),
  bitbucketUsername: () => required("BITBUCKET_SERVER_USERNAME", env.BITBUCKET_SERVER_USERNAME),
  bitbucketPassword: () => required("BITBUCKET_SERVER_PASSWORD", env.BITBUCKET_SERVER_PASSWORD),
};

export function getGhesTargetExecutionConfig(profileId?: string): GhesTargetExecutionConfig {
  return {
    ...getGhesTargetConnectionConfig(profileId),
    ...getExporterConfig(),
    exporterImage: gitlabSettings.exporterImage(),
    gitlabUsername: gitlabSettings.gitlabUsername(),
    gitlabToken: gitlabSettings.gitlabToken(),
  };
}

export function getBitbucketGhesTargetExecutionConfig(
  profileId?: string,
): BitbucketGhesTargetExecutionConfig {
  return {
    ...getGhesTargetConnectionConfig(profileId),
    ...getExporterConfig(),
    exporterImage: bitbucketSettings.exporterImage(),
    bitbucketUsername: bitbucketSettings.bitbucketUsername(),
    bitbucketPassword: bitbucketSettings.bitbucketPassword(),
  };
}

/**
 * Explain why GHES execution is not configured for a source provider. Issues
 * name settings and fixed rules only, never configured values; an empty list
 * means the same loaders used at execution time accept the configuration.
 */
export function getGhesTargetConfigIssues(
  profileId?: string,
  sourceProvider: "gitlab" | "bitbucket-server" = "gitlab",
): ConfigIssue[] {
  return collectConfigIssues([
    () => ghesProfile(profileId),
    () => required("GHES_TARGET_ADMIN_USERNAME", env.GHES_TARGET_ADMIN_USERNAME),
    () => required("GHES_TARGET_ADMIN_PAT", env.GHES_TARGET_ADMIN_PAT),
    sshPort,
    sshPrivateKey,
    sshHostFingerprint,
    remoteDirectory,
    exporterRuntime,
    archiveDirectory,
    () => required("EXPORTER_ARCHIVE_VOLUME", env.EXPORTER_ARCHIVE_VOLUME),
    ...exporterSandboxChecks,
    ...Object.values(sourceProvider === "gitlab" ? gitlabSettings : bitbucketSettings),
  ]);
}
