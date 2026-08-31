import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

function decodePrivateKey(raw: string): string {
  const decoded = Buffer.from(raw, "base64").toString("utf-8");
  return decoded.startsWith("-----BEGIN ") ? decoded : raw;
}

export async function getRepositoryAnalysisSourceToken(sourceApiUrl: string): Promise<string> {
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
    const result = (await client.auth({ type: "installation" })) as { token: string };
    return result.token;
  }

  const pat = process.env.GH_SOURCE_PAT?.trim();
  if (pat) return pat;
  throw new Error("Repository analysis requires recoverable source credentials");
}
