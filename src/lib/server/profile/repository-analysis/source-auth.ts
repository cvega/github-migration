import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { getGitHubSourceConfig } from "$lib/server/core/auth";
import { validateProfileCredentialScope } from "$lib/server/core/credential-scope";
import { getSourceProjectIdentity } from "$lib/source-provider";
import { RepositoryAnalysisError } from "./analyze-repository";

function decodePrivateKey(raw: string): string {
  const decoded = Buffer.from(raw, "base64").toString("utf-8");
  return decoded.startsWith("-----BEGIN ") ? decoded : raw;
}

export async function getRepositoryAnalysisSourceToken(
  sourceApiUrl: string,
  nameWithOwner: string,
): Promise<string> {
  const configured = getGitHubSourceConfig();
  if (!configured.apiUrl || sourceApiUrl !== configured.apiUrl) {
    throw new RepositoryAnalysisError("Profile no longer matches the configured GitHub source");
  }
  const { namespace } = getSourceProjectIdentity("github", nameWithOwner);
  if (validateProfileCredentialScope("github", namespace)) {
    throw new RepositoryAnalysisError("Repository is outside the current GitHub profile scope");
  }
  const appId = process.env.GH_SOURCE_APP_ID?.trim();
  const privateKey = process.env.GH_SOURCE_APP_PRIVATE_KEY?.trim();
  const installationId = process.env.GH_SOURCE_APP_INSTALLATION_ID?.trim();
  if (appId && privateKey && installationId) {
    const client = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId,
        privateKey: decodePrivateKey(privateKey),
        installationId,
      },
      baseUrl: sourceApiUrl,
    });
    const result = await client.auth({ type: "installation" });
    if (
      result &&
      typeof result === "object" &&
      "token" in result &&
      typeof result.token === "string" &&
      result.token.trim()
    )
      return result.token;
    throw new RepositoryAnalysisError("GitHub did not return an installation token");
  }

  const pat = process.env.GH_SOURCE_PAT?.trim();
  if (pat) return pat;
  throw new RepositoryAnalysisError("Repository analysis requires recoverable source credentials");
}
