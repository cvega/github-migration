import { env } from "$env/dynamic/private";
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
