import { supportsMigrationTarget, type TargetPlatform } from "$lib/migration-target";
import { isBitbucketSftpConfigured } from "$lib/server/source/bitbucket/archive";
import { getBitbucketServerSourceConfig } from "$lib/server/source/bitbucket/config";
import { isGitLabArchiveStorageConfigured } from "$lib/server/source/gitlab/archive";
import { getGitLabSourceConfig } from "$lib/server/source/gitlab/config";
import { SOURCE_PROVIDERS, type SourceProvider } from "$lib/source-provider";
import { isSourceAuthAvailable, isTargetAuthAvailable } from "./core/auth";
import { isGhesTargetExecutionConfigured } from "./core/ghes-target";
import { getMigrationTargetProfile, getMigrationTargetProfiles } from "./core/targets";

type CapabilityStatus = "ready" | "blocked" | "unsupported";

type CapabilityReasonCode =
  | "target-profile-not-configured"
  | "migration-route-unsupported"
  | "source-auth-missing"
  | "gitlab-archive-storage-missing"
  | "bitbucket-sftp-missing"
  | "target-auth-missing"
  | "ghes-execution-invalid";

interface CapabilityReason {
  code: CapabilityReasonCode;
  message: string;
  environment: string[];
}

export interface MigrationCapability {
  sourceProvider: SourceProvider;
  targetProfileId: string;
  targetPlatform: TargetPlatform | null;
  status: CapabilityStatus;
  reasons: CapabilityReason[];
}

interface DeprecatedEnvironmentAlias {
  alias: string;
  canonical: string;
}

export interface CapabilityReport {
  migrations: MigrationCapability[];
  deprecatedEnvironmentAliases: DeprecatedEnvironmentAlias[];
}

export interface CapabilityContext {
  sourceAuthProvided?: boolean;
  targetAuthProvided?: boolean;
}

interface CapabilityLogger {
  info(message: string): void;
  warn(message: string): void;
}

const SOURCE_AUTH_ENV: Record<SourceProvider, string[]> = {
  github: [
    "GH_SOURCE_PAT",
    "GH_SOURCE_APP_ID",
    "GH_SOURCE_APP_PRIVATE_KEY",
    "GH_SOURCE_APP_INSTALLATION_ID",
  ],
  gitlab: ["GITLAB_SOURCE_API_URL", "GITLAB_SOURCE_PAT"],
  "bitbucket-server": [
    "BITBUCKET_SERVER_URL",
    "BITBUCKET_SERVER_USERNAME",
    "BITBUCKET_SERVER_PASSWORD",
  ],
};

const TARGET_AUTH_ENV = [
  "GH_TARGET_PAT",
  "GH_TARGET_APP_ID",
  "GH_TARGET_APP_PRIVATE_KEY",
  "GH_TARGET_APP_INSTALLATION_ID",
];

const GHES_CONNECTION_ENV = [
  "GHES_TARGET_API_URL",
  "GHES_TARGET_ADMIN_USERNAME",
  "GHES_TARGET_ADMIN_PAT",
  "GHES_TARGET_SSH_PRIVATE_KEY",
  "GHES_TARGET_SSH_HOST_KEY_SHA256",
  "EXPORTER_ARCHIVE_VOLUME",
  "ARCHIVE_DIR",
];

function sourceAuthReady(provider: SourceProvider, context: CapabilityContext): boolean {
  if (provider === "github") {
    return context.sourceAuthProvided === true || isSourceAuthAvailable();
  }
  if (provider === "gitlab") return getGitLabSourceConfig().authAvailable;
  return getBitbucketServerSourceConfig().authAvailable;
}

function sourceDisplayName(provider: SourceProvider): string {
  if (provider === "bitbucket-server") return "Bitbucket Server";
  return provider === "gitlab" ? "GitLab" : "GitHub";
}

function ghesExecutionReady(
  provider: Exclude<SourceProvider, "github">,
  targetProfileId: string,
): boolean {
  return isGhesTargetExecutionConfigured(targetProfileId, provider);
}

function ghesExecutionEnvironment(provider: SourceProvider): string[] {
  if (provider === "gitlab") {
    return [...GHES_CONNECTION_ENV, "GL_EXPORTER_IMAGE", "GITLAB_SOURCE_USERNAME"];
  }
  return [...GHES_CONNECTION_ENV, "BBS_EXPORTER_IMAGE"];
}

export function getMigrationCapability(
  sourceProvider: SourceProvider,
  targetProfileId = "ghec",
  context: CapabilityContext = {},
): MigrationCapability {
  const targetProfile = getMigrationTargetProfile(targetProfileId);
  if (!targetProfile) {
    return {
      sourceProvider,
      targetProfileId,
      targetPlatform: null,
      status: "blocked",
      reasons: [
        {
          code: "target-profile-not-configured",
          message: `Migration target profile '${targetProfileId}' is not configured`,
          environment: ["GHES_TARGET_API_URL"],
        },
      ],
    };
  }

  if (!supportsMigrationTarget(sourceProvider, targetProfile.platform)) {
    return {
      sourceProvider,
      targetProfileId: targetProfile.id,
      targetPlatform: targetProfile.platform,
      status: "unsupported",
      reasons: [
        {
          code: "migration-route-unsupported",
          message: `${sourceDisplayName(sourceProvider)} migrations to ${targetProfile.displayName} are not supported`,
          environment: [],
        },
      ],
    };
  }

  const reasons: CapabilityReason[] = [];
  if (!sourceAuthReady(sourceProvider, context)) {
    reasons.push({
      code: "source-auth-missing",
      message: `Missing ${sourceDisplayName(sourceProvider)} source authentication`,
      environment: SOURCE_AUTH_ENV[sourceProvider],
    });
  }

  if (targetProfile.platform === "ghec") {
    if (sourceProvider === "gitlab" && !isGitLabArchiveStorageConfigured()) {
      reasons.push({
        code: "gitlab-archive-storage-missing",
        message: "GitLab migration archive storage is not configured",
        environment: ["ARCHIVE_DIR"],
      });
    }
    if (sourceProvider === "bitbucket-server" && !isBitbucketSftpConfigured()) {
      reasons.push({
        code: "bitbucket-sftp-missing",
        message: "Bitbucket migration SFTP is not configured",
        environment: [
          "BITBUCKET_SERVER_SSH_USERNAME",
          "BITBUCKET_SERVER_SSH_PRIVATE_KEY",
          "BITBUCKET_SERVER_SSH_HOST_KEY_SHA256",
          "ARCHIVE_DIR",
        ],
      });
    }
    if (context.targetAuthProvided !== true && !isTargetAuthAvailable()) {
      reasons.push({
        code: "target-auth-missing",
        message: "Missing GitHub target authentication",
        environment: TARGET_AUTH_ENV,
      });
    }
  } else if (
    !ghesExecutionReady(sourceProvider as Exclude<SourceProvider, "github">, targetProfile.id)
  ) {
    reasons.push({
      code: "ghes-execution-invalid",
      message: `GHES migration execution is not fully configured for ${sourceDisplayName(sourceProvider)}`,
      environment: ghesExecutionEnvironment(sourceProvider),
    });
  }

  return {
    sourceProvider,
    targetProfileId: targetProfile.id,
    targetPlatform: targetProfile.platform,
    status: reasons.length === 0 ? "ready" : "blocked",
    reasons,
  };
}

function deprecatedEnvironmentAliases(): DeprecatedEnvironmentAlias[] {
  const aliases = [
    ["GL_EXPORTER_RUNTIME", "EXPORTER_RUNTIME"],
    ["GL_EXPORTER_ARCHIVE_VOLUME", "EXPORTER_ARCHIVE_VOLUME"],
  ] as const;
  return aliases
    .filter(
      ([alias, canonical]) =>
        Boolean(process.env[alias]?.trim()) && !process.env[canonical]?.trim(),
    )
    .map(([alias, canonical]) => ({ alias, canonical }));
}

export function getCapabilityReport(): CapabilityReport {
  return {
    migrations: getMigrationTargetProfiles().flatMap((target) =>
      SOURCE_PROVIDERS.map((provider) => getMigrationCapability(provider, target.id)),
    ),
    deprecatedEnvironmentAliases: deprecatedEnvironmentAliases(),
  };
}

export function logCapabilityReport(
  report: CapabilityReport,
  logger: CapabilityLogger = console,
): void {
  const routes = report.migrations.map((capability) => {
    const route = `${capability.sourceProvider}->${capability.targetProfileId}`;
    if (capability.status === "ready") return `${route}=ready`;
    const reasonCodes = capability.reasons.map((reason) => reason.code).join(",");
    return `${route}=${capability.status}(${reasonCodes})`;
  });
  logger.info(`[setup] Migration capabilities: ${routes.join("; ")}`);

  for (const { alias, canonical } of report.deprecatedEnvironmentAliases) {
    logger.warn(`[setup] ${alias} is deprecated; configure ${canonical} instead`);
  }
}
