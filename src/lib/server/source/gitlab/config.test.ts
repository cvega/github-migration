import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_GITLAB_PROFILE_REQUEST_BUDGET,
  GitLabSourceConfigurationError,
  getGitLabProfileRequestBudget,
  getGitLabSourceClient,
  getGitLabSourceConfig,
} from "./config";

const ENV_KEYS = [
  "GITLAB_SOURCE_API_URL",
  "GITLAB_SOURCE_PAT",
  "GH_SOURCE_API_URL",
  "GH_SOURCE_PAT",
  "GITLAB_SOURCE_PROFILE_REQUEST_BUDGET",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("GitLab source credentials", () => {
  test("requires explicit GitLab settings and never infers them from GitHub settings", () => {
    delete process.env.GITLAB_SOURCE_API_URL;
    delete process.env.GITLAB_SOURCE_PAT;
    process.env.GH_SOURCE_API_URL = "https://gitlab.example.com/api/v4";
    process.env.GH_SOURCE_PAT = "gitlab-looking-token";

    expect(getGitLabSourceConfig()).toEqual({ apiUrl: "", authAvailable: false });
    expect(() => getGitLabSourceClient()).toThrow(GitLabSourceConfigurationError);
  });

  test("requires both the GitLab URL and PAT", () => {
    process.env.GITLAB_SOURCE_API_URL = "https://gitlab.example.com";
    delete process.env.GITLAB_SOURCE_PAT;
    expect(getGitLabSourceConfig().authAvailable).toBe(false);
    expect(() => getGitLabSourceClient()).toThrow("GITLAB_SOURCE_PAT");

    delete process.env.GITLAB_SOURCE_API_URL;
    process.env.GITLAB_SOURCE_PAT = "secret-token";
    expect(getGitLabSourceConfig().authAvailable).toBe(false);
    expect(() => getGitLabSourceClient()).toThrow(GitLabSourceConfigurationError);
  });

  test("rejects whitespace-only GitLab settings with the typed configuration error", () => {
    for (const [apiUrl, token, expectedApiUrl] of [
      ["   ", "secret-token", ""],
      ["https://gitlab.example.com", "   ", "https://gitlab.example.com/api/v4"],
    ] as const) {
      process.env.GITLAB_SOURCE_API_URL = apiUrl;
      process.env.GITLAB_SOURCE_PAT = token;

      expect(getGitLabSourceConfig()).toEqual({ apiUrl: expectedApiUrl, authAvailable: false });
      try {
        getGitLabSourceClient();
        throw new Error("expected GitLab configuration failure");
      } catch (error) {
        expect(error).toBeInstanceOf(GitLabSourceConfigurationError);
        expect((error as Error).name).toBe("GitLabSourceConfigurationError");
      }
    }
  });

  test("normalizes the configured API URL without exposing the PAT", () => {
    process.env.GITLAB_SOURCE_API_URL = "  https://code.example.com/gitlab/  ";
    process.env.GITLAB_SOURCE_PAT = " secret-token ";

    expect(getGitLabSourceConfig()).toEqual({
      apiUrl: "https://code.example.com/gitlab/api/v4",
      authAvailable: true,
    });
    const client = getGitLabSourceClient();
    expect(client.apiUrl).toBe("https://code.example.com/gitlab/api/v4");
    expect("token" in client).toBe(false);
    expect(JSON.stringify(client)).not.toContain("secret-token");
  });

  test("rejects unsafe configured URLs", () => {
    process.env.GITLAB_SOURCE_API_URL = "http://gitlab.example.com";
    process.env.GITLAB_SOURCE_PAT = "secret-token";

    expect(getGitLabSourceConfig()).toEqual({ apiUrl: "", authAvailable: false });
    expect(() => getGitLabSourceClient()).toThrow("must use HTTPS");

    process.env.GITLAB_SOURCE_API_URL = "https://secret@gitlab.example.com";
    expect(getGitLabSourceConfig()).toEqual({ apiUrl: "", authAvailable: false });
  });
});

describe("GitLab profile request budget", () => {
  test("defaults when unset or blank and accepts a positive integer", () => {
    delete process.env.GITLAB_SOURCE_PROFILE_REQUEST_BUDGET;
    expect(getGitLabProfileRequestBudget()).toBe(DEFAULT_GITLAB_PROFILE_REQUEST_BUDGET);
    process.env.GITLAB_SOURCE_PROFILE_REQUEST_BUDGET = "   ";
    expect(getGitLabProfileRequestBudget()).toBe(DEFAULT_GITLAB_PROFILE_REQUEST_BUDGET);
    process.env.GITLAB_SOURCE_PROFILE_REQUEST_BUDGET = " 2500 ";
    expect(getGitLabProfileRequestBudget()).toBe(2_500);
  });

  test("rejects invalid values with a safe issue that never echoes the value", () => {
    for (const value of ["0", "-5", "1.5", "ten", "9007199254740993"]) {
      process.env.GITLAB_SOURCE_PROFILE_REQUEST_BUDGET = value;
      try {
        getGitLabProfileRequestBudget();
        throw new Error(`expected ${value} to be rejected`);
      } catch (error) {
        expect((error as Error).message).toBe(
          "GITLAB_SOURCE_PROFILE_REQUEST_BUDGET must be a positive integer",
        );
      }
    }
  });
});
