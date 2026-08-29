import type {
  AuthMode,
  CreateMigrationRequest,
  Migration,
  MigrationOptions,
} from "$lib/migrate/types";
import { supportsMigrationTarget } from "$lib/migration-target";
import {
  isSourceAppConfigured,
  isSourceAuthAvailable,
  isTargetAppConfigured,
  isTargetAuthAvailable,
} from "$lib/server/core/auth";
import { getMigrationTargetProfile } from "$lib/server/core/targets";
import { validateCredentialScope } from "$lib/server/validate";
import {
  getMigrationExecutor,
  getSourceProviderAdapter,
  type SourceProvider,
} from "$lib/source-provider";
import {
  type PersistedRequestOptions,
  tryParsePersistedRequestOptions,
} from "./database/migrations";

export { parseJsonBody } from "$lib/server/validate";

export function validateMigrationTargetSelection(input: {
  sourceProvider?: SourceProvider;
  targetProfileId?: string;
}): string | null {
  const provider = input.sourceProvider ?? "github";
  const adapter = getSourceProviderAdapter(provider);
  const profile = getMigrationTargetProfile(input.targetProfileId);
  if (!profile) return "Target profile is not configured";
  if (!supportsMigrationTarget(provider, profile.platform)) {
    return `${adapter.displayName} cannot target ${profile.displayName}`;
  }
  if (!getMigrationExecutor(provider, profile.platform)) {
    return `${adapter.displayName} migration execution to ${profile.displayName} is not available yet`;
  }
  return null;
}

export function requireCredentialScope(request: CreateMigrationRequest): void {
  const error = validateCredentialScope(request);
  if (error) throw new TypeError(error);
}

export function determineAuthModeFromRequest(request: CreateMigrationRequest): AuthMode {
  if (getMigrationTargetProfile(request.targetProfileId)?.platform === "ghes") return "env-pat";
  if (request.sourceToken || request.targetToken) return "request-pat";
  if (request.sourceApp || request.targetApp) return "request-app";
  if ((request.sourceProvider ?? "github") !== "github") {
    if (isTargetAppConfigured()) return "env-app";
    if (isTargetAuthAvailable()) return "env-pat";
    return "request-pat";
  }
  if (isSourceAppConfigured() && isTargetAppConfigured()) return "env-app";
  if (isSourceAuthAvailable() && isTargetAuthAvailable()) return "env-pat";
  return "request-pat";
}

export const safeParsePersistedRequestOptions = tryParsePersistedRequestOptions;

export function serializeRequestOptions(request: CreateMigrationRequest): string {
  return JSON.stringify({
    sourceApiUrl: request.sourceApiUrl,
    sourceRepo: request.sourceRepo,
    targetProfileId: request.targetProfileId,
    targetOrg: request.targetOrg,
    targetRepo: request.targetRepo,
    noSslVerify: request.noSslVerify,
    skipReleases: request.skipReleases,
    lockSource: request.lockSource,
    archiveSource: request.archiveSource,
    targetRepoVisibility: request.targetRepoVisibility,
    directPassthrough: request.directPassthrough,
  });
}

export function requestFromPersistedOptions(
  options: PersistedRequestOptions,
): CreateMigrationRequest {
  const stringValue = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;
  const booleanValue = (value: unknown): boolean | undefined =>
    typeof value === "boolean" ? value : undefined;
  const visibility = options.targetRepoVisibility;
  return {
    sourceApiUrl: stringValue(options.sourceApiUrl),
    sourceRepo: stringValue(options.sourceRepo) ?? "",
    targetProfileId: stringValue(options.targetProfileId),
    targetOrg: stringValue(options.targetOrg) ?? "",
    targetRepo: stringValue(options.targetRepo),
    noSslVerify: booleanValue(options.noSslVerify),
    skipReleases: booleanValue(options.skipReleases),
    lockSource: booleanValue(options.lockSource),
    archiveSource: booleanValue(options.archiveSource),
    targetRepoVisibility:
      visibility === "private" || visibility === "public" || visibility === "internal"
        ? visibility
        : undefined,
    directPassthrough: booleanValue(options.directPassthrough),
  };
}

export function restartValidationInput(migration: Migration, options: MigrationOptions) {
  return {
    ...options,
    sourceProvider: migration.sourceProvider,
    sourceApiUrl: migration.sourceApiUrl,
    sourceRepo: `${migration.sourceOrg}/${migration.sourceRepo}`,
    targetOrg: migration.targetOrg,
    targetProfileId: migration.targetProfileId,
    targetPlatform: migration.targetPlatform,
  };
}
