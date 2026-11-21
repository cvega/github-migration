import { env } from "node:process";
import { DEFAULT_TARGET_PROFILE_ID, type MigrationTargetProfile } from "$lib/migration-target";
import { isTargetAppConfigured, resolveTargetAuth } from "./auth";
import {
  createSingleClient,
  type GitHubClient,
  isGhecSource,
  normalizeGitHubApiUrl,
  sourceBaseUrl,
} from "./github";

const TARGET_PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(/[\s,]/).filter(Boolean))];
}

function ghecProfile(): MigrationTargetProfile {
  return {
    id: DEFAULT_TARGET_PROFILE_ID,
    platform: "ghec",
    displayName: "GitHub Enterprise Cloud",
    apiUrl: "https://api.github.com",
    webUrl: "https://github.com",
    organizations: parseList(env.GH_TARGET_ORG),
  };
}

function ghesProfile(): MigrationTargetProfile | null {
  const id = env.GHES_TARGET_ID?.trim() || "ghes";
  if (!TARGET_PROFILE_ID.test(id) || id === DEFAULT_TARGET_PROFILE_ID) return null;

  try {
    const apiUrl = normalizeGitHubApiUrl(env.GHES_TARGET_API_URL ?? "");
    if (isGhecSource(apiUrl)) return null;
    return {
      id,
      platform: "ghes",
      displayName: env.GHES_TARGET_NAME?.trim() || new URL(sourceBaseUrl(apiUrl)).hostname,
      apiUrl,
      webUrl: sourceBaseUrl(apiUrl),
      organizations: parseList(env.GHES_TARGET_ORG),
    };
  } catch {
    return null;
  }
}

/** Return non-secret target metadata suitable for server-rendered UI state. */
export function getMigrationTargetProfiles(): MigrationTargetProfile[] {
  const ghes = ghesProfile();
  return ghes ? [ghecProfile(), ghes] : [ghecProfile()];
}

export function getMigrationTargetProfile(id?: string): MigrationTargetProfile | null {
  const profileId = id?.trim() || DEFAULT_TARGET_PROFILE_ID;
  return getMigrationTargetProfiles().find((profile) => profile.id === profileId) ?? null;
}

export function requireMigrationTargetProfile(id?: string): MigrationTargetProfile {
  const profile = getMigrationTargetProfile(id);
  if (!profile) throw new TypeError(`Migration target profile '${id}' is not configured`);
  return profile;
}

export function migrationTargetCredentialError(target: MigrationTargetProfile): string | null {
  if (
    target.platform === "ghec" &&
    !isTargetAppConfigured() &&
    env.GH_TARGET_PAT?.trim() &&
    env.GH_TARGET_PAT.trim() === env.GHES_TARGET_ADMIN_PAT?.trim()
  ) {
    return "GH_TARGET_PAT matches the GHES administrator token. Configure a separate GitHub.com credential for the cloud target.";
  }
  return null;
}

export function getMigrationTargetClient(target: MigrationTargetProfile): GitHubClient {
  const credentialError = migrationTargetCredentialError(target);
  if (credentialError) throw new Error(credentialError);
  if (target.platform === "ghec") return createSingleClient(resolveTargetAuth(), target.apiUrl);
  const token = env.GHES_TARGET_ADMIN_PAT?.trim();
  if (!token) throw new Error("GHES_TARGET_ADMIN_PAT is required for GHES target operations");
  return createSingleClient({ token }, target.apiUrl);
}
