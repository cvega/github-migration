import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getSetupReadiness } from "./setup";

const KEYS = [
  "GH_SOURCE_PAT",
  "GH_TARGET_PAT",
  "GH_SOURCE_APP_ID",
  "GH_SOURCE_APP_PRIVATE_KEY",
  "GH_SOURCE_APP_INSTALLATION_ID",
  "GH_TARGET_APP_ID",
  "GH_TARGET_APP_PRIVATE_KEY",
  "GH_TARGET_APP_INSTALLATION_ID",
  "GH_SOURCE_API_URL",
  "GH_SOURCE_ORG",
  "GH_TARGET_ORG",
  "GITLAB_SOURCE_API_URL",
  "GITLAB_SOURCE_PAT",
  "BITBUCKET_SERVER_URL",
  "BITBUCKET_SERVER_USERNAME",
  "BITBUCKET_SERVER_PASSWORD",
  "BITBUCKET_SERVER_SSH_USERNAME",
  "BITBUCKET_SERVER_SSH_PRIVATE_KEY",
  "BITBUCKET_SERVER_SSH_HOST_KEY_SHA256",
  "ARCHIVE_DIR",
  "GHES_TARGET_API_URL",
  "GHES_TARGET_ADMIN_USERNAME",
  "GHES_TARGET_ADMIN_PAT",
  "GHES_TARGET_SSH_PRIVATE_KEY",
  "GHES_TARGET_SSH_HOST_KEY_SHA256",
  "BBS_EXPORTER_IMAGE",
  "EXPORTER_ARCHIVE_VOLUME",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("getSetupReadiness", () => {
  test("sends a fresh unconfigured installation to onboarding", () => {
    expect(getSetupReadiness(false)).toMatchObject({
      sourceAuthReady: false,
      gitlabSourceAuthReady: false,
      gitlabSourceApiUrl: "",
      gitlabMigrationReady: false,
      bitbucketSourceAuthReady: false,
      bitbucketSourceApiUrl: "",
      bitbucketMigrationReady: false,
      targetAuthReady: false,
      sourceApiUrl: "https://api.github.com",
      sourceOrgs: [],
      targetOrgs: [],
      profileReady: false,
      automationReady: false,
      complete: false,
      needsOnboarding: true,
    });
  });

  test("allows profiling when only source auth is configured", () => {
    process.env.GH_SOURCE_PAT = "source-token";
    process.env.GH_SOURCE_API_URL = "https://ghes.example.com/api/v3";
    process.env.GH_SOURCE_ORG = "acme, globex";

    const setup = getSetupReadiness(false);
    expect(setup.profileReady).toBe(true);
    expect(setup.automationReady).toBe(false);
    expect(setup.sourceApiUrl).toBe("https://ghes.example.com/api/v3");
    expect(setup.sourceOrgs).toEqual(["acme", "globex"]);
    expect(setup.needsOnboarding).toBe(false);
  });

  test("allows inventory profiling when only GitLab auth is configured", () => {
    process.env.GITLAB_SOURCE_API_URL = "https://gitlab.example.com";
    process.env.GITLAB_SOURCE_PAT = "gitlab-token";

    const setup = getSetupReadiness(false);
    expect(setup.sourceAuthReady).toBe(false);
    expect(setup.gitlabSourceAuthReady).toBe(true);
    expect(setup.gitlabSourceApiUrl).toBe("https://gitlab.example.com/api/v4");
    expect(setup.profileReady).toBe(true);
    expect(setup.automationReady).toBe(false);
    expect(setup.complete).toBe(false);
    expect(setup.needsOnboarding).toBe(false);
  });

  test("allows inventory profiling when only Bitbucket Server auth is configured", () => {
    process.env.BITBUCKET_SERVER_URL = "https://bitbucket.example.com";
    process.env.BITBUCKET_SERVER_USERNAME = "migration-user";
    process.env.BITBUCKET_SERVER_PASSWORD = "bitbucket-password";

    const setup = getSetupReadiness(false);
    expect(setup.sourceAuthReady).toBe(false);
    expect(setup.bitbucketSourceAuthReady).toBe(true);
    expect(setup.bitbucketSourceApiUrl).toBe("https://bitbucket.example.com/rest/api/1.0");
    expect(setup.bitbucketMigrationReady).toBe(false);
    expect(setup.profileReady).toBe(true);
    expect(setup.automationReady).toBe(false);
    expect(JSON.stringify(setup)).not.toContain("bitbucket-password");
  });

  test("is complete when source and target credentials are configured", () => {
    process.env.GH_SOURCE_PAT = "source-token";
    process.env.GH_TARGET_PAT = "target-token";

    const setup = getSetupReadiness(false);
    expect(setup.automationReady).toBe(true);
    expect(setup.complete).toBe(true);
    expect(setup.needsOnboarding).toBe(false);
  });

  test("is automation ready with Bitbucket REST, SFTP, and target credentials", () => {
    process.env.BITBUCKET_SERVER_URL = "https://bitbucket.example.com";
    process.env.BITBUCKET_SERVER_USERNAME = "migration-user";
    process.env.BITBUCKET_SERVER_PASSWORD = "bitbucket-password";
    process.env.BITBUCKET_SERVER_SSH_USERNAME = "bitbucket";
    process.env.BITBUCKET_SERVER_SSH_PRIVATE_KEY = "private-key";
    process.env.BITBUCKET_SERVER_SSH_HOST_KEY_SHA256 = "fingerprint";
    process.env.ARCHIVE_DIR = "/tmp/bitbucket-archives";
    process.env.GH_TARGET_PAT = "target-token";

    expect(getSetupReadiness(false).bitbucketMigrationReady).toBe(true);
    expect(getSetupReadiness(false).automationReady).toBe(true);
    delete process.env.BITBUCKET_SERVER_SSH_HOST_KEY_SHA256;
    expect(getSetupReadiness(false).automationReady).toBe(false);
  });

  test("is automation ready with GitLab export storage and target credentials", () => {
    process.env.GITLAB_SOURCE_API_URL = "https://gitlab.example.com";
    process.env.GITLAB_SOURCE_PAT = "gitlab-token";
    process.env.ARCHIVE_DIR = "/tmp/gitlab-archives";
    process.env.GH_TARGET_PAT = "target-token";

    const setup = getSetupReadiness(false);
    expect(setup.gitlabMigrationReady).toBe(true);
    expect(setup.automationReady).toBe(true);
    delete process.env.ARCHIVE_DIR;
    expect(getSetupReadiness(false).gitlabMigrationReady).toBe(false);
  });

  test("is automation ready when only a Bitbucket-to-GHES route is configured", () => {
    process.env.BITBUCKET_SERVER_URL = "https://bitbucket.example.com";
    process.env.BITBUCKET_SERVER_USERNAME = "migration-user";
    process.env.BITBUCKET_SERVER_PASSWORD = "bitbucket-password";
    process.env.ARCHIVE_DIR = "/tmp/bitbucket-archives";
    process.env.GHES_TARGET_API_URL = "https://ghes.example.com";
    process.env.GHES_TARGET_ADMIN_USERNAME = "site-admin";
    process.env.GHES_TARGET_ADMIN_PAT = "site-admin-token";
    process.env.GHES_TARGET_SSH_PRIVATE_KEY =
      "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";
    process.env.GHES_TARGET_SSH_HOST_KEY_SHA256 = "fingerprint";
    process.env.BBS_EXPORTER_IMAGE = "gh-migrate/bbs-exporter:latest";
    process.env.EXPORTER_ARCHIVE_VOLUME = "gh-migrate-archives";

    const setup = getSetupReadiness(false);
    expect(setup.targetAuthReady).toBe(false);
    expect(setup.automationReady).toBe(true);
    expect(
      setup.capabilityReport.migrations.find(
        (capability) =>
          capability.sourceProvider === "bitbucket-server" && capability.targetPlatform === "ghes",
      )?.status,
    ).toBe("ready");
  });

  test("does not force an established installation back through onboarding", () => {
    expect(getSetupReadiness(true).needsOnboarding).toBe(false);
  });

  test("does not expose or accept unsafe configured source URLs", () => {
    process.env.GH_SOURCE_PAT = "source-token";
    process.env.GH_SOURCE_API_URL = "https://secret@ghes.example.com";
    process.env.GITLAB_SOURCE_PAT = "gitlab-token";
    process.env.GITLAB_SOURCE_API_URL = "https://gitlab.example.com?private_token=secret";

    const setup = getSetupReadiness(false);
    expect(setup.sourceAuthReady).toBe(false);
    expect(setup.sourceApiUrl).toBe("");
    expect(setup.gitlabSourceAuthReady).toBe(false);
    expect(setup.gitlabSourceApiUrl).toBe("");
    expect(JSON.stringify(setup)).not.toContain("secret");
  });
});
