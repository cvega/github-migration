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
import {
  type CredentialScopeInput,
  getInputSourceProvider,
  validateCredentialScope,
} from "$lib/server/core/credential-scope";
import { getMigrationTargetProfile } from "$lib/server/core/targets";
import {
  getMigrationExecutor,
  getSourceProviderAdapter,
  type SourceProvider,
} from "$lib/source-provider";
import { tryParsePersistedRequestOptions } from "./database/migrations";
import { resolveEffectiveSourceApiUrl } from "./ports/source-runtime";

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

export function validatePersistedServerCredentialScope(input: CredentialScopeInput): string | null {
  const scopeError = validateCredentialScope(input);
  if (scopeError) return scopeError;
  try {
    if (
      resolveEffectiveSourceApiUrl(input) !==
      resolveEffectiveSourceApiUrl({ sourceProvider: getInputSourceProvider(input) })
    ) {
      return "Persisted source API URL no longer matches the server-configured source";
    }
  } catch {
    return "Persisted source API URL is invalid";
  }
  return null;
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

/** Keep the admitted route and repository identity authoritative on every dispatch. */
export function requestForMigration(
  migration: Migration,
  options: Partial<CreateMigrationRequest> = {},
): CreateMigrationRequest {
  return {
    ...options,
    sourceProvider: migration.sourceProvider,
    sourceApiUrl: migration.sourceApiUrl,
    sourceRepo: `${migration.sourceOrg}/${migration.sourceRepo}`,
    targetProfileId: migration.targetProfileId,
    targetOrg: migration.targetOrg,
    targetRepo: migration.targetRepo,
  };
}

export function restartValidationInput(migration: Migration, options: MigrationOptions) {
  return {
    ...requestForMigration(migration, options),
    targetPlatform: migration.targetPlatform,
  };
}
