import { env } from "node:process";
import { readPositiveIntegerSetting } from "$lib/server/core/config-issue";
import { GitLabClient, normalizeGitLabApiUrl } from "./client";

export interface GitLabSourceConfig {
  apiUrl: string;
  authAvailable: boolean;
}

export class GitLabSourceConfigurationError extends Error {
  constructor() {
    super("GITLAB_SOURCE_API_URL and GITLAB_SOURCE_PAT must be configured for GitLab operations");
    this.name = "GitLabSourceConfigurationError";
  }
}

/** Return non-secret GitLab source configuration for server-rendered UI state. */
export function getGitLabSourceConfig(): GitLabSourceConfig {
  let apiUrl: string;
  try {
    apiUrl = normalizeGitLabApiUrl(env.GITLAB_SOURCE_API_URL ?? "");
  } catch {
    return { apiUrl: "", authAvailable: false };
  }
  return {
    apiUrl,
    authAvailable: Boolean(env.GITLAB_SOURCE_PAT?.trim()),
  };
}

/** Build a GitLab client exclusively from GitLab-specific server credentials. */
export function getGitLabSourceClient(): GitLabClient {
  const baseUrl = env.GITLAB_SOURCE_API_URL?.trim();
  const token = env.GITLAB_SOURCE_PAT?.trim();
  if (!baseUrl || !token) {
    throw new GitLabSourceConfigurationError();
  }
  return new GitLabClient({ baseUrl, token });
}

/**
 * Upper bound on GitLab API requests (retries and pagination included) that one
 * profile run's metric collection may issue. Sized for roughly ten requests per
 * project at the 10,000-project inventory limit.
 */
export const DEFAULT_GITLAB_PROFILE_REQUEST_BUDGET = 100_000;

/** Read the per-profile metric request budget; throws a value-free config issue when invalid. */
export function getGitLabProfileRequestBudget(): number {
  return readPositiveIntegerSetting(
    "GITLAB_SOURCE_PROFILE_REQUEST_BUDGET",
    env.GITLAB_SOURCE_PROFILE_REQUEST_BUDGET,
    DEFAULT_GITLAB_PROFILE_REQUEST_BUDGET,
  );
}
