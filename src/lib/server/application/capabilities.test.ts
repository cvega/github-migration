import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getCapabilityReport, getMigrationCapability, logCapabilityReport } from "./capabilities";

const KEYS = [
  "GH_SOURCE_PAT",
  "GH_TARGET_PAT",
  "GITLAB_SOURCE_API_URL",
  "GITLAB_SOURCE_PAT",
  "GITLAB_SOURCE_USERNAME",
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
  "GHES_TARGET_SSH_PORT",
  "GL_EXPORTER_IMAGE",
  "BBS_EXPORTER_IMAGE",
  "EXPORTER_RUNTIME",
  "GL_EXPORTER_RUNTIME",
  "EXPORTER_ARCHIVE_VOLUME",
  "GL_EXPORTER_ARCHIVE_VOLUME",
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

function configureBitbucketGhes(): void {
  process.env.GHES_TARGET_API_URL = "https://ghes.example.com";
  process.env.GHES_TARGET_ADMIN_USERNAME = "site-admin";
  process.env.GHES_TARGET_ADMIN_PAT = "synthetic-admin-token";
  process.env.GHES_TARGET_SSH_PRIVATE_KEY =
    "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----";
  process.env.GHES_TARGET_SSH_HOST_KEY_SHA256 = "synthetic-fingerprint";
  process.env.ARCHIVE_DIR = "/archives";
  process.env.EXPORTER_ARCHIVE_VOLUME = "gh-migrate-archives";
  process.env.BITBUCKET_SERVER_URL = "https://bitbucket.example.com";
  process.env.BITBUCKET_SERVER_USERNAME = "migration-user";
  process.env.BITBUCKET_SERVER_PASSWORD = "synthetic-password";
  process.env.BBS_EXPORTER_IMAGE = "gh-migrate/bbs-exporter:latest";
}

describe("migration capability report", () => {
  test("reports stable blockers for every default-target source route", () => {
    expect(getCapabilityReport().migrations).toEqual([
      {
        sourceProvider: "github",
        targetProfileId: "ghec",
        targetPlatform: "ghec",
        status: "blocked",
        reasons: [
          {
            code: "source-auth-missing",
            message: "Missing GitHub source authentication",
            environment: [
              "GH_SOURCE_PAT",
              "GH_SOURCE_APP_ID",
              "GH_SOURCE_APP_PRIVATE_KEY",
              "GH_SOURCE_APP_INSTALLATION_ID",
            ],
          },
          {
            code: "target-auth-missing",
            message: "Missing GitHub target authentication",
            environment: [
              "GH_TARGET_PAT",
              "GH_TARGET_APP_ID",
              "GH_TARGET_APP_PRIVATE_KEY",
              "GH_TARGET_APP_INSTALLATION_ID",
            ],
          },
        ],
      },
      {
        sourceProvider: "gitlab",
        targetProfileId: "ghec",
        targetPlatform: "ghec",
        status: "blocked",
        reasons: [
          {
            code: "source-auth-missing",
            message: "Missing GitLab source authentication",
            environment: ["GITLAB_SOURCE_API_URL", "GITLAB_SOURCE_PAT"],
          },
          {
            code: "gitlab-archive-storage-missing",
            message: "GitLab migration archive storage is not configured: ARCHIVE_DIR is required",
            environment: ["ARCHIVE_DIR"],
            issues: ["ARCHIVE_DIR is required"],
          },
          {
            code: "target-auth-missing",
            message: "Missing GitHub target authentication",
            environment: [
              "GH_TARGET_PAT",
              "GH_TARGET_APP_ID",
              "GH_TARGET_APP_PRIVATE_KEY",
              "GH_TARGET_APP_INSTALLATION_ID",
            ],
          },
        ],
      },
      {
        sourceProvider: "bitbucket-server",
        targetProfileId: "ghec",
        targetPlatform: "ghec",
        status: "blocked",
        reasons: [
          {
            code: "source-auth-missing",
            message: "Missing Bitbucket Server source authentication",
            environment: [
              "BITBUCKET_SERVER_URL",
              "BITBUCKET_SERVER_USERNAME",
              "BITBUCKET_SERVER_PASSWORD",
            ],
          },
          {
            code: "bitbucket-sftp-missing",
            message:
              "Bitbucket migration SFTP is not configured: BITBUCKET_SERVER_URL is required; BITBUCKET_SERVER_SSH_USERNAME is required; BITBUCKET_SERVER_SSH_PRIVATE_KEY is required; BITBUCKET_SERVER_SSH_HOST_KEY_SHA256 is required; ARCHIVE_DIR is required",
            environment: [
              "BITBUCKET_SERVER_URL",
              "BITBUCKET_SERVER_SSH_USERNAME",
              "BITBUCKET_SERVER_SSH_PRIVATE_KEY",
              "BITBUCKET_SERVER_SSH_HOST_KEY_SHA256",
              "ARCHIVE_DIR",
            ],
            issues: [
              "BITBUCKET_SERVER_URL is required",
              "BITBUCKET_SERVER_SSH_USERNAME is required",
              "BITBUCKET_SERVER_SSH_PRIVATE_KEY is required",
              "BITBUCKET_SERVER_SSH_HOST_KEY_SHA256 is required",
              "ARCHIVE_DIR is required",
            ],
          },
          {
            code: "target-auth-missing",
            message: "Missing GitHub target authentication",
            environment: [
              "GH_TARGET_PAT",
              "GH_TARGET_APP_ID",
              "GH_TARGET_APP_PRIVATE_KEY",
              "GH_TARGET_APP_INSTALLATION_ID",
            ],
          },
        ],
      },
    ]);
  });

  test("reports an unknown target with its remediation setting", () => {
    expect(getMigrationCapability("github", "missing")).toEqual({
      sourceProvider: "github",
      targetProfileId: "missing",
      targetPlatform: null,
      status: "blocked",
      reasons: [
        {
          code: "target-profile-not-configured",
          message: "Migration target profile 'missing' is not configured",
          environment: ["GHES_TARGET_API_URL"],
        },
      ],
    });
  });

  test("accepts request credentials only for the GitHub-to-GHEC route", () => {
    expect(
      getMigrationCapability("github", "ghec", {
        sourceAuthProvided: true,
        targetAuthProvided: true,
      }),
    ).toMatchObject({ status: "ready", reasons: [] });
    expect(
      getMigrationCapability("gitlab", "ghec", {
        sourceAuthProvided: true,
        targetAuthProvided: true,
      }).reasons.map((reason) => reason.code),
    ).toEqual(["source-auth-missing", "gitlab-archive-storage-missing"]);

    process.env.GITLAB_SOURCE_API_URL = "https://gitlab.example.com";
    process.env.GITLAB_SOURCE_PAT = "gitlab-token";
    process.env.ARCHIVE_DIR = "/archives";
    expect(getMigrationCapability("gitlab", "ghec", { targetAuthProvided: true })).toMatchObject({
      status: "ready",
      reasons: [],
    });
  });

  test("distinguishes supported GHES execution by source provider", () => {
    process.env.GHES_TARGET_API_URL = "https://ghes.example.com";
    process.env.GHES_TARGET_ADMIN_USERNAME = "site-admin";
    process.env.GHES_TARGET_ADMIN_PAT = "admin-token";
    process.env.GHES_TARGET_SSH_PRIVATE_KEY =
      "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";
    process.env.GHES_TARGET_SSH_HOST_KEY_SHA256 = "fingerprint";
    process.env.ARCHIVE_DIR = "/archives";
    process.env.EXPORTER_ARCHIVE_VOLUME = "gh-migrate-archives";
    process.env.BITBUCKET_SERVER_URL = "https://bitbucket.example.com";
    process.env.BITBUCKET_SERVER_USERNAME = "migration-user";
    process.env.BITBUCKET_SERVER_PASSWORD = "password";
    process.env.BBS_EXPORTER_IMAGE = "gh-migrate/bbs-exporter:latest";

    const capabilities = getCapabilityReport().migrations.filter(
      (capability) => capability.targetPlatform === "ghes",
    );
    expect(capabilities.map(({ sourceProvider, status }) => [sourceProvider, status])).toEqual([
      ["github", "unsupported"],
      ["gitlab", "unsupported"],
      ["bitbucket-server", "ready"],
    ]);
    expect(getMigrationCapability("github", "ghes")).toEqual({
      sourceProvider: "github",
      targetProfileId: "ghes",
      targetPlatform: "ghes",
      status: "unsupported",
      reasons: [
        {
          code: "migration-route-unsupported",
          message: "GitHub migrations to ghes.example.com are not supported",
          environment: [],
        },
      ],
    });
  });

  test("names only the missing setting when GHES execution is nearly configured", () => {
    configureBitbucketGhes();
    delete process.env.EXPORTER_ARCHIVE_VOLUME;

    expect(getMigrationCapability("bitbucket-server", "ghes")).toMatchObject({
      status: "blocked",
      reasons: [
        {
          code: "ghes-execution-invalid",
          message:
            "GHES migration execution is not fully configured for Bitbucket Server: EXPORTER_ARCHIVE_VOLUME is required",
          environment: ["EXPORTER_ARCHIVE_VOLUME"],
          issues: ["EXPORTER_ARCHIVE_VOLUME is required"],
        },
      ],
    });
  });

  test("states the violated rule without echoing the configured value", () => {
    configureBitbucketGhes();
    process.env.ARCHIVE_DIR = "relative/synthetic-path-value";
    process.env.GHES_TARGET_SSH_PRIVATE_KEY = "synthetic-not-a-key";
    process.env.GHES_TARGET_SSH_PORT = "70000-synthetic";

    const reason = getMigrationCapability("bitbucket-server", "ghes").reasons[0];
    expect(reason?.issues).toEqual([
      "GHES_TARGET_SSH_PORT must be an integer between 1 and 65535",
      "GHES_TARGET_SSH_PRIVATE_KEY must be PEM or base64-encoded PEM",
      "ARCHIVE_DIR must be an absolute path",
    ]);
    expect(reason?.environment).toEqual([
      "GHES_TARGET_SSH_PORT",
      "GHES_TARGET_SSH_PRIVATE_KEY",
      "ARCHIVE_DIR",
    ]);
    expect(JSON.stringify(reason)).not.toContain("synthetic");
  });

  test("keeps GitLab-to-GHES paused regardless of GHES configuration", () => {
    configureBitbucketGhes();
    expect(getMigrationCapability("gitlab", "ghes").reasons).toEqual([
      {
        code: "migration-route-unsupported",
        message: "GitLab-to-GHES migration execution is paused",
        environment: [],
      },
    ]);
  });

  test("reports migration capabilities with obsolete environment settings present", () => {
    process.env.GL_EXPORTER_RUNTIME = "podman";
    process.env.GL_EXPORTER_ARCHIVE_VOLUME = "old-archives";

    const report = getCapabilityReport();
    expect(Object.keys(report)).toEqual(["migrations"]);
    expect(report.migrations).toHaveLength(3);
  });

  test("logs route reason codes and setting names without credential values or alias warnings", () => {
    process.env.GH_SOURCE_PAT = "source-secret";
    process.env.GL_EXPORTER_RUNTIME = "legacy-runtime";
    const messages: string[] = [];
    const logger = {
      info: (message: string) => messages.push(message),
      warn: (message: string) => messages.push(message),
    };
    logCapabilityReport(getCapabilityReport(), logger);

    expect(messages.join("\n")).toContain("github->ghec=blocked(target-auth-missing)");
    expect(messages).toHaveLength(1);
    expect(messages.join("\n")).not.toContain("source-secret");
    expect(messages.join("\n")).not.toContain("legacy-runtime");

    process.env.GH_TARGET_PAT = "target-secret";
    messages.length = 0;
    logCapabilityReport(getCapabilityReport(), logger);
    expect(messages.join("\n")).not.toContain("target-secret");
    expect(messages[0]).toBe(
      "[setup] Migration capabilities: github->ghec=ready; gitlab->ghec=blocked(source-auth-missing,gitlab-archive-storage-missing: ARCHIVE_DIR is required); bitbucket-server->ghec=blocked(source-auth-missing,bitbucket-sftp-missing: BITBUCKET_SERVER_URL is required; BITBUCKET_SERVER_SSH_USERNAME is required; BITBUCKET_SERVER_SSH_PRIVATE_KEY is required; BITBUCKET_SERVER_SSH_HOST_KEY_SHA256 is required; ARCHIVE_DIR is required)",
    );
  });

  test("logs the setting names and rules behind a blocked route without values", () => {
    configureBitbucketGhes();
    delete process.env.EXPORTER_ARCHIVE_VOLUME;
    process.env.GH_TARGET_PAT = "synthetic-target-token";
    const messages: string[] = [];
    logCapabilityReport(getCapabilityReport(), { info: (message) => messages.push(message) });

    expect(messages[0]).toContain(
      "bitbucket-server->ghes=blocked(ghes-execution-invalid: EXPORTER_ARCHIVE_VOLUME is required)",
    );
    expect(messages[0]).not.toContain("synthetic");
  });
});
