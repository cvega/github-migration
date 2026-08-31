import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { getRepositoryAnalysisSourceToken } from "./source-auth";

const AUTH_ENV_KEYS = [
  "GH_SOURCE_PAT",
  "GH_SOURCE_APP_ID",
  "GH_SOURCE_APP_PRIVATE_KEY",
  "GH_SOURCE_APP_INSTALLATION_ID",
] as const;
const originalFetch = globalThis.fetch;
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
let savedEnvironment: Record<(typeof AUTH_ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  savedEnvironment = {} as typeof savedEnvironment;
  for (const key of AUTH_ENV_KEYS) {
    savedEnvironment[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of AUTH_ENV_KEYS) {
    const value = savedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("repository analysis source authentication", () => {
  test("requests a GitHub App installation token from the GHES API", async () => {
    process.env.GH_SOURCE_APP_ID = "111";
    process.env.GH_SOURCE_APP_PRIVATE_KEY = Buffer.from(privateKey).toString("base64");
    process.env.GH_SOURCE_APP_INSTALLATION_ID = "222";
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = input instanceof Request ? input.url : input.toString();
      return new Response(
        JSON.stringify({
          token: "installation-token",
          expires_at: "2026-08-30T13:00:00Z",
          permissions: {},
          repository_selection: "all",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(getRepositoryAnalysisSourceToken("https://ghes.example.com/api/v3")).resolves.toBe(
      "installation-token",
    );
    expect(requestedUrl).toBe(
      "https://ghes.example.com/api/v3/app/installations/222/access_tokens",
    );
  });

  test("falls back to the configured source PAT", async () => {
    process.env.GH_SOURCE_PAT = "source-pat";
    await expect(getRepositoryAnalysisSourceToken("https://api.github.com")).resolves.toBe(
      "source-pat",
    );
  });

  test("fails when no recoverable source credentials are configured", async () => {
    await expect(getRepositoryAnalysisSourceToken("https://api.github.com")).rejects.toThrow(
      "Repository analysis requires recoverable source credentials",
    );
  });
});
