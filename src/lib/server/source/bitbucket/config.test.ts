import { afterEach, describe, expect, test } from "bun:test";
import {
  BitbucketServerSourceConfigurationError,
  getBitbucketServerSourceClient,
  getBitbucketServerSourceConfig,
} from "./config";

const ENV_KEYS = [
  "BITBUCKET_SERVER_URL",
  "BITBUCKET_SERVER_USERNAME",
  "BITBUCKET_SERVER_PASSWORD",
  "BITBUCKET_SERVER_ALLOW_INSECURE_HTTP",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Bitbucket Server source credentials", () => {
  test("requires an explicit URL, username, and password", () => {
    for (const [url, username, password] of [
      [undefined, "migration-user", "password"],
      ["https://bitbucket.example.com", undefined, "password"],
      ["https://bitbucket.example.com", "migration-user", undefined],
      ["   ", "migration-user", "password"],
      ["https://bitbucket.example.com", "   ", "password"],
    ] as const) {
      if (url === undefined) delete process.env.BITBUCKET_SERVER_URL;
      else process.env.BITBUCKET_SERVER_URL = url;
      if (username === undefined) delete process.env.BITBUCKET_SERVER_USERNAME;
      else process.env.BITBUCKET_SERVER_USERNAME = username;
      if (password === undefined) delete process.env.BITBUCKET_SERVER_PASSWORD;
      else process.env.BITBUCKET_SERVER_PASSWORD = password;

      expect(getBitbucketServerSourceConfig().authAvailable).toBe(false);
      try {
        getBitbucketServerSourceClient();
        throw new Error("expected Bitbucket configuration failure");
      } catch (error) {
        expect(error).toBeInstanceOf(BitbucketServerSourceConfigurationError);
        expect((error as Error).name).toBe("BitbucketServerSourceConfigurationError");
        expect((error as Error).message).toBe(
          "BITBUCKET_SERVER_URL, BITBUCKET_SERVER_USERNAME, and BITBUCKET_SERVER_PASSWORD must be configured",
        );
      }
    }
  });

  test("normalizes safe configuration without exposing credentials", () => {
    process.env.BITBUCKET_SERVER_URL = " https://bitbucket.example.com/ ";
    process.env.BITBUCKET_SERVER_USERNAME = " migration-user ";
    process.env.BITBUCKET_SERVER_PASSWORD = "never-print-this";

    expect(getBitbucketServerSourceConfig()).toEqual({
      apiUrl: "https://bitbucket.example.com/rest/api/1.0",
      authAvailable: true,
    });
    const client = getBitbucketServerSourceClient();
    expect(client.apiUrl).toBe("https://bitbucket.example.com/rest/api/1.0");
    expect(JSON.stringify(client)).not.toContain("never-print-this");
  });

  test("requires HTTPS unless the administrator explicitly opts out", () => {
    process.env.BITBUCKET_SERVER_URL = "http://bitbucket.local";
    process.env.BITBUCKET_SERVER_USERNAME = "migration-user";
    process.env.BITBUCKET_SERVER_PASSWORD = "password";
    expect(getBitbucketServerSourceConfig()).toEqual({ apiUrl: "", authAvailable: false });
    expect(() => getBitbucketServerSourceClient()).toThrow("HTTPS");

    process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP = "TRUE";
    expect(getBitbucketServerSourceConfig()).toEqual({ apiUrl: "", authAvailable: false });

    process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP = "true";
    expect(getBitbucketServerSourceConfig()).toEqual({
      apiUrl: "http://bitbucket.local/rest/api/1.0",
      authAvailable: true,
    });
  });
});
