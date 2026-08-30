import { getFormDefaults } from "$lib/server/core/auth";
import { getInputSourceProvider } from "$lib/server/core/credential-scope";
import { normalizeGitHubApiUrl } from "$lib/server/core/github";
import type { MigrationSourceRuntime } from "$lib/server/migrate/ports/source-runtime";
import { downloadBitbucketArchive } from "$lib/server/source/bitbucket/archive";
import {
  BitbucketServerApiError,
  normalizeBitbucketServerApiUrl,
} from "$lib/server/source/bitbucket/client";
import {
  getBitbucketServerSourceClient,
  getBitbucketServerSourceConfig,
} from "$lib/server/source/bitbucket/config";
import { downloadGitLabArchive } from "$lib/server/source/gitlab/archive";
import { GitLabApiError, normalizeGitLabApiUrl } from "$lib/server/source/gitlab/client";
import { getGitLabSourceClient, getGitLabSourceConfig } from "$lib/server/source/gitlab/config";

export function createMigrationSourceRuntime(): MigrationSourceRuntime {
  return {
    resolveEffectiveSourceApiUrl: (input) => {
      const provider = getInputSourceProvider(input);
      const requested = typeof input.sourceApiUrl === "string" ? input.sourceApiUrl.trim() : "";
      if (provider === "gitlab") {
        return normalizeGitLabApiUrl(requested || getGitLabSourceConfig().apiUrl);
      }
      if (provider === "bitbucket-server") {
        return normalizeBitbucketServerApiUrl(
          requested || getBitbucketServerSourceConfig().apiUrl,
          { allowInsecureHttp: process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP === "true" },
        );
      }
      const serverUrl =
        !input.sourceToken && !input.sourceApp ? getFormDefaults().sourceApiUrl : "";
      return normalizeGitHubApiUrl(requested || serverUrl || "https://api.github.com");
    },
    getGitLabMigrationSourceClient: getGitLabSourceClient,
    getGitLabGhesSourceClient: getGitLabSourceClient,
    getBitbucketMigrationSourceClient: getBitbucketServerSourceClient,
    getBitbucketMigrationSourceConfig: getBitbucketServerSourceConfig,
    downloadGitLabMigrationArchive: downloadGitLabArchive,
    downloadBitbucketMigrationArchive: downloadBitbucketArchive,
    isDefinitiveGitLabApiError: (error) => error instanceof GitLabApiError && error.status > 0,
    isDefinitiveBitbucketApiError: (error) =>
      error instanceof BitbucketServerApiError && error.status > 0,
  };
}
