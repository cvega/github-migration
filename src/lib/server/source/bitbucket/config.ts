import { env } from "node:process";
import { BitbucketServerClient, normalizeBitbucketServerApiUrl } from "./client";

export interface BitbucketServerSourceConfig {
  apiUrl: string;
  authAvailable: boolean;
}

export class BitbucketServerSourceConfigurationError extends Error {
  constructor() {
    super(
      "BITBUCKET_SERVER_URL, BITBUCKET_SERVER_USERNAME, and BITBUCKET_SERVER_PASSWORD must be configured",
    );
    this.name = "BitbucketServerSourceConfigurationError";
  }
}

function allowInsecureHttp(): boolean {
  return env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP === "true";
}

export function getBitbucketServerSourceConfig(): BitbucketServerSourceConfig {
  let apiUrl: string;
  try {
    apiUrl = normalizeBitbucketServerApiUrl(env.BITBUCKET_SERVER_URL ?? "", {
      allowInsecureHttp: allowInsecureHttp(),
    });
  } catch {
    return { apiUrl: "", authAvailable: false };
  }
  return {
    apiUrl,
    authAvailable: Boolean(env.BITBUCKET_SERVER_USERNAME?.trim() && env.BITBUCKET_SERVER_PASSWORD),
  };
}

export function getBitbucketServerSourceClient(): BitbucketServerClient {
  const baseUrl = env.BITBUCKET_SERVER_URL?.trim();
  const username = env.BITBUCKET_SERVER_USERNAME?.trim();
  const password = env.BITBUCKET_SERVER_PASSWORD;
  if (!baseUrl || !username || !password) throw new BitbucketServerSourceConfigurationError();
  return new BitbucketServerClient({
    baseUrl,
    username,
    password,
    allowInsecureHttp: allowInsecureHttp(),
  });
}
