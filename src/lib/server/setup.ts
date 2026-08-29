import { getBitbucketServerSourceConfig } from "$lib/server/source/bitbucket/config";
import { getGitLabSourceConfig } from "$lib/server/source/gitlab/config";
import type { SourceProvider } from "$lib/source-provider";
import {
  type CapabilityReport,
  getCapabilityReport,
  type MigrationCapability,
} from "./capability-report";
import { getFormDefaults, getGitHubSourceConfig, isTargetAuthAvailable } from "./core/auth";

/**
 * Server-owned provider readiness exposed to onboarding without credential
 * values. Profiling needs any configured source API credential. Automated
 * migration additionally needs a migration-ready source (including native
 * archive transport) and target GitHub credentials.
 */

export interface SetupReadiness {
  sourceAuthReady: boolean;
  gitlabSourceAuthReady: boolean;
  gitlabSourceApiUrl: string;
  gitlabMigrationReady: boolean;
  bitbucketSourceAuthReady: boolean;
  bitbucketSourceApiUrl: string;
  bitbucketMigrationReady: boolean;
  targetAuthReady: boolean;
  sourceApiUrl: string;
  sourceOrgs: string[];
  targetOrgs: string[];
  profileReady: boolean;
  automationReady: boolean;
  complete: boolean;
  needsOnboarding: boolean;
  capabilityReport: CapabilityReport;
}

function ghecSourceReady(report: CapabilityReport, sourceProvider: SourceProvider): boolean {
  const capability = report.migrations.find(
    (candidate) =>
      candidate.sourceProvider === sourceProvider && candidate.targetPlatform === "ghec",
  );
  return (
    capability !== undefined &&
    capability.status !== "unsupported" &&
    capability.reasons.every((reason) => reason.code === "target-auth-missing")
  );
}

/**
 * Summarize server-owned configuration without exposing credential values.
 * `needsOnboarding` is true only before operational history exists and while no
 * provider is ready to profile; `complete` aliases full automation readiness.
 */
export function getSetupReadiness(hasOperationalHistory: boolean): SetupReadiness {
  const defaults = getFormDefaults();
  const githubSource = getGitHubSourceConfig();
  const sourceAuthReady = githubSource.authAvailable;
  const gitlabSource = getGitLabSourceConfig();
  const bitbucketSource = getBitbucketServerSourceConfig();
  const targetAuthReady = isTargetAuthAvailable();
  const capabilityReport = getCapabilityReport();
  const gitlabMigrationReady = ghecSourceReady(capabilityReport, "gitlab");
  const bitbucketMigrationReady = ghecSourceReady(capabilityReport, "bitbucket-server");
  const automationReady = capabilityReport.migrations.some(
    (capability: MigrationCapability) => capability.status === "ready",
  );
  const profileReady =
    sourceAuthReady || gitlabSource.authAvailable || bitbucketSource.authAvailable;

  return {
    sourceAuthReady,
    gitlabSourceAuthReady: gitlabSource.authAvailable,
    gitlabSourceApiUrl: gitlabSource.apiUrl,
    gitlabMigrationReady,
    bitbucketSourceAuthReady: bitbucketSource.authAvailable,
    bitbucketSourceApiUrl: bitbucketSource.apiUrl,
    bitbucketMigrationReady,
    targetAuthReady,
    sourceApiUrl: githubSource.apiUrl,
    sourceOrgs: defaults.sourceOrgs,
    targetOrgs: defaults.targetOrgs,
    profileReady,
    automationReady,
    complete: automationReady,
    needsOnboarding: !hasOperationalHistory && !profileReady,
    capabilityReport,
  };
}
