import {
  GITLAB_GHES_PAUSE_REASON,
  supportsMigrationTarget,
  type TargetPlatform,
} from "$lib/migration-target";
import { getBitbucketSftpIssues } from "$lib/server/source/bitbucket/archive";
import { getBitbucketServerSourceConfig } from "$lib/server/source/bitbucket/config";
import { getGitLabArchiveStorageIssues } from "$lib/server/source/gitlab/archive";
import { getGitLabSourceConfig } from "$lib/server/source/gitlab/config";
import { SOURCE_PROVIDERS, type SourceProvider } from "$lib/source-provider";
import { isSourceAuthAvailable, isTargetAuthAvailable } from "../core/auth";
import type { ConfigIssue } from "../core/config-issue";
import { getGhesTargetConfigIssues } from "../core/ghes-target";
import { getMigrationTargetProfile, getMigrationTargetProfiles } from "../core/targets";

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
  /** Named settings and fixed rules behind the reason; never configured values. */
  issues?: string[];
}

export interface MigrationCapability {
  sourceProvider: SourceProvider;
  targetProfileId: string;
  targetPlatform: TargetPlatform | null;
  status: CapabilityStatus;
  reasons: CapabilityReason[];
}

export interface CapabilityReport {
  migrations: MigrationCapability[];
}

export interface CapabilityContext {
  sourceAuthProvided?: boolean;
  targetAuthProvided?: boolean;
}

interface CapabilityLogger {
  info(message: string): void;
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

function configIssueReason(
  code: CapabilityReasonCode,
  summary: string,
  issues: ConfigIssue[],
): CapabilityReason {
  const texts = issues.map((issue) => issue.text);
  const variables = issues.flatMap((issue) => (issue.variable ? [issue.variable] : []));
  return {
    code,
    message: `${summary}: ${texts.join("; ")}`,
    environment: [...new Set(variables)],
    issues: texts,
  };
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
          message:
            sourceProvider === "gitlab" && targetProfile.platform === "ghes"
              ? GITLAB_GHES_PAUSE_REASON
              : `${sourceDisplayName(sourceProvider)} migrations to ${targetProfile.displayName} are not supported`,
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
    const archiveIssues =
      sourceProvider === "gitlab"
        ? getGitLabArchiveStorageIssues()
        : sourceProvider === "bitbucket-server"
          ? getBitbucketSftpIssues()
          : [];
    if (archiveIssues.length > 0) {
      reasons.push(
        sourceProvider === "gitlab"
          ? configIssueReason(
              "gitlab-archive-storage-missing",
              "GitLab migration archive storage is not configured",
              archiveIssues,
            )
          : configIssueReason(
              "bitbucket-sftp-missing",
              "Bitbucket migration SFTP is not configured",
              archiveIssues,
            ),
      );
    }
    if (context.targetAuthProvided !== true && !isTargetAuthAvailable()) {
      reasons.push({
        code: "target-auth-missing",
        message: "Missing GitHub target authentication",
        environment: TARGET_AUTH_ENV,
      });
    }
  } else {
    const ghesIssues = getGhesTargetConfigIssues(
      targetProfile.id,
      sourceProvider as Exclude<SourceProvider, "github">,
    );
    if (ghesIssues.length > 0) {
      reasons.push(
        configIssueReason(
          "ghes-execution-invalid",
          `GHES migration execution is not fully configured for ${sourceDisplayName(sourceProvider)}`,
          ghesIssues,
        ),
      );
    }
  }

  return {
    sourceProvider,
    targetProfileId: targetProfile.id,
    targetPlatform: targetProfile.platform,
    status: reasons.length === 0 ? "ready" : "blocked",
    reasons,
  };
}

export function getCapabilityReport(): CapabilityReport {
  return {
    migrations: getMigrationTargetProfiles().flatMap((target) =>
      SOURCE_PROVIDERS.map((provider) => getMigrationCapability(provider, target.id)),
    ),
  };
}

export function logCapabilityReport(
  report: CapabilityReport,
  logger: CapabilityLogger = console,
): void {
  const routes = report.migrations.map((capability) => {
    const route = `${capability.sourceProvider}->${capability.targetProfileId}`;
    if (capability.status === "ready") return `${route}=ready`;
    const reasonCodes = capability.reasons
      .map((reason) =>
        reason.issues ? `${reason.code}: ${reason.issues.join("; ")}` : reason.code,
      )
      .join(",");
    return `${route}=${capability.status}(${reasonCodes})`;
  });
  logger.info(`[setup] Migration capabilities: ${routes.join("; ")}`);
}
