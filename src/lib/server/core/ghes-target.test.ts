import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getBitbucketGhesTargetExecutionConfig,
  getGhesTargetConfigIssues,
  getGhesTargetExecutionConfig,
} from "./ghes-target";

const KEYS = [
  "GHES_TARGET_API_URL",
  "GHES_TARGET_ID",
  "GHES_TARGET_ADMIN_USERNAME",
  "GHES_TARGET_ADMIN_PAT",
  "GHES_TARGET_SSH_HOST",
  "GHES_TARGET_SSH_PORT",
  "GHES_TARGET_SSH_USERNAME",
  "GHES_TARGET_SSH_PRIVATE_KEY",
  "GHES_TARGET_SSH_HOST_KEY_SHA256",
  "GHES_TARGET_REMOTE_DIR",
  "GL_EXPORTER_RUNTIME",
  "EXPORTER_RUNTIME",
  "EXPORTER_ARCHIVE_VOLUME",
  "GL_EXPORTER_IMAGE",
  "GL_EXPORTER_ARCHIVE_VOLUME",
  "BBS_EXPORTER_IMAGE",
  "EXPORTER_NETWORK",
  "EXPORTER_MEMORY",
  "EXPORTER_CPUS",
  "EXPORTER_PIDS_LIMIT",
  "EXPORTER_TMPFS_SIZE",
  "ARCHIVE_DIR",
  "GITLAB_SOURCE_USERNAME",
  "GITLAB_SOURCE_PAT",
  "BITBUCKET_SERVER_USERNAME",
  "BITBUCKET_SERVER_PASSWORD",
] as const;
const saved = new Map<string, string | undefined>();
const PEM = "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";

beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.GHES_TARGET_API_URL = "https://ghes.example.com";
  process.env.GHES_TARGET_ADMIN_USERNAME = "site-admin";
  process.env.GHES_TARGET_ADMIN_PAT = "secret-token";
  process.env.GHES_TARGET_SSH_PRIVATE_KEY = Buffer.from(PEM).toString("base64");
  process.env.GHES_TARGET_SSH_HOST_KEY_SHA256 = "SHA256:pinned-fingerprint";
  process.env.GL_EXPORTER_IMAGE = "github/gl-exporter:latest";
  process.env.EXPORTER_ARCHIVE_VOLUME = "gh-migrate-archives";
  process.env.BBS_EXPORTER_IMAGE = "github/bbs-exporter:latest";
  process.env.ARCHIVE_DIR = "/archives";
  process.env.GITLAB_SOURCE_USERNAME = "gitlab-admin";
  process.env.GITLAB_SOURCE_PAT = "gitlab-token";
  process.env.BITBUCKET_SERVER_USERNAME = "bbs-admin";
  process.env.BITBUCKET_SERVER_PASSWORD = "bbs-password";
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("GHES target execution configuration", () => {
  test("normalizes defaults and decodes the SSH private key", () => {
    process.env.GL_EXPORTER_RUNTIME = "podman";
    expect(getGhesTargetExecutionConfig()).toMatchObject({
      siteAdminUsername: "site-admin",
      siteAdminToken: "secret-token",
      sshHost: "ghes.example.com",
      sshPort: 122,
      sshUsername: "admin",
      sshPrivateKey: PEM,
      sshHostFingerprint: "pinned-fingerprint",
      remoteDirectory: "/home/admin",
      exporterRuntime: "docker",
      exporterImage: "github/gl-exporter:latest",
      exporterArchiveVolume: "gh-migrate-archives",
      archiveDirectory: "/archives",
      sandbox: {
        network: "bridge",
        memory: "2g",
        cpus: 2,
        pidsLimit: 256,
        tmpfsSize: "1g",
      },
      gitlabUsername: "gitlab-admin",
      gitlabToken: "gitlab-token",
    });
  });

  test("fails closed when required execution settings are missing", () => {
    process.env.GL_EXPORTER_ARCHIVE_VOLUME = "old-archives";
    for (const key of [
      "GHES_TARGET_ADMIN_PAT",
      "GHES_TARGET_SSH_PRIVATE_KEY",
      "GHES_TARGET_SSH_HOST_KEY_SHA256",
      "GL_EXPORTER_IMAGE",
      "EXPORTER_ARCHIVE_VOLUME",
      "GITLAB_SOURCE_USERNAME",
    ] as const) {
      const value = process.env[key];
      delete process.env[key];
      expect(getGhesTargetConfigIssues(undefined, "gitlab")).toEqual([
        { variable: key, text: `${key} is required` },
      ]);
      process.env[key] = value;
    }
  });

  test("loads Bitbucket exporter settings independently from GitLab", () => {
    process.env.EXPORTER_RUNTIME = " podman ";
    delete process.env.GL_EXPORTER_IMAGE;
    delete process.env.GITLAB_SOURCE_USERNAME;
    delete process.env.GITLAB_SOURCE_PAT;

    expect(getBitbucketGhesTargetExecutionConfig()).toMatchObject({
      exporterRuntime: "podman",
      exporterImage: "github/bbs-exporter:latest",
      exporterArchiveVolume: "gh-migrate-archives",
      bitbucketUsername: "bbs-admin",
      bitbucketPassword: "bbs-password",
    });
    expect(getGhesTargetConfigIssues(undefined, "bitbucket-server")).toEqual([]);
    expect(getGhesTargetConfigIssues(undefined, "gitlab")).toEqual([
      { variable: "GL_EXPORTER_IMAGE", text: "GL_EXPORTER_IMAGE is required" },
      { variable: "GITLAB_SOURCE_USERNAME", text: "GITLAB_SOURCE_USERNAME is required" },
      { variable: "GITLAB_SOURCE_PAT", text: "GITLAB_SOURCE_PAT is required" },
    ]);
  });

  test("names only the missing archive volume for either source provider", () => {
    delete process.env.EXPORTER_ARCHIVE_VOLUME;
    const expected = [
      { variable: "EXPORTER_ARCHIVE_VOLUME", text: "EXPORTER_ARCHIVE_VOLUME is required" },
    ];
    expect(getGhesTargetConfigIssues(undefined, "bitbucket-server")).toEqual(expected);
    expect(getGhesTargetConfigIssues(undefined, "gitlab")).toEqual(expected);
  });

  test("reports each failing settings group independently", () => {
    delete process.env.EXPORTER_ARCHIVE_VOLUME;
    delete process.env.GHES_TARGET_ADMIN_PAT;
    delete process.env.BBS_EXPORTER_IMAGE;
    expect(
      getGhesTargetConfigIssues(undefined, "bitbucket-server").map((issue) => issue.variable),
    ).toEqual(["GHES_TARGET_ADMIN_PAT", "EXPORTER_ARCHIVE_VOLUME", "BBS_EXPORTER_IMAGE"]);
  });

  test("states the violated rule without echoing invalid values", () => {
    const sentinel = "synthetic-invalid-value-7f3a";
    const cases: Array<[string, string, string]> = [
      ["ARCHIVE_DIR", `relative/${sentinel}`, "ARCHIVE_DIR must be an absolute path"],
      [
        "GHES_TARGET_SSH_PRIVATE_KEY",
        sentinel,
        "GHES_TARGET_SSH_PRIVATE_KEY must be PEM or base64-encoded PEM",
      ],
      [
        "GHES_TARGET_SSH_PORT",
        `70000${sentinel}`,
        "GHES_TARGET_SSH_PORT must be an integer between 1 and 65535",
      ],
      ["GHES_TARGET_REMOTE_DIR", sentinel, "GHES_TARGET_REMOTE_DIR must be an absolute path"],
      [
        "EXPORTER_NETWORK",
        "host",
        "EXPORTER_NETWORK must be a Docker network name other than 'host'",
      ],
      ["EXPORTER_RUNTIME", `bad runtime ${sentinel}`, "EXPORTER_RUNTIME is invalid"],
    ];
    for (const provider of ["gitlab", "bitbucket-server"] as const) {
      for (const [name, value, text] of cases) {
        const saved = process.env[name];
        process.env[name] = value;
        const issues = getGhesTargetConfigIssues(undefined, provider).filter(
          (issue) => issue.variable === name,
        );
        expect(issues).toEqual([{ variable: name, text }]);
        expect(JSON.stringify(getGhesTargetConfigIssues(undefined, provider))).not.toContain(
          sentinel,
        );
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      }
    }
  });

  test("does not leak secrets when the target URL is malformed", () => {
    process.env.GHES_TARGET_API_URL = "https://user:synthetic-secret@";
    const issues = getGhesTargetConfigIssues(undefined, "bitbucket-server");
    expect(issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(issues)).not.toContain("synthetic-secret");
  });

  test("rejects invalid SSH and remote path settings", () => {
    process.env.GHES_TARGET_SSH_PORT = "70000";
    expect(() => getGhesTargetExecutionConfig()).toThrow(/SSH_PORT/);
    process.env.GHES_TARGET_SSH_PORT = "122";
    process.env.GHES_TARGET_REMOTE_DIR = "relative/path";
    expect(() => getGhesTargetExecutionConfig()).toThrow(/absolute/);
  });

  test("validates configurable exporter sandbox limits", () => {
    process.env.EXPORTER_NETWORK = "migration-exporters";
    process.env.EXPORTER_MEMORY = "4g";
    process.env.EXPORTER_CPUS = "1.5";
    process.env.EXPORTER_PIDS_LIMIT = "128";
    process.env.EXPORTER_TMPFS_SIZE = "512m";
    expect(getGhesTargetExecutionConfig().sandbox).toEqual({
      network: "migration-exporters",
      memory: "4g",
      cpus: 1.5,
      pidsLimit: 128,
      tmpfsSize: "512m",
    });

    process.env.EXPORTER_NETWORK = "host";
    expect(() => getGhesTargetExecutionConfig()).toThrow(/EXPORTER_NETWORK/);
    process.env.EXPORTER_NETWORK = "bridge";
    process.env.EXPORTER_MEMORY = "unbounded";
    expect(() => getGhesTargetExecutionConfig()).toThrow(/EXPORTER_MEMORY/);
    process.env.EXPORTER_MEMORY = "2g";
    process.env.EXPORTER_CPUS = "0";
    expect(() => getGhesTargetExecutionConfig()).toThrow(/EXPORTER_CPUS/);
    process.env.EXPORTER_CPUS = "2";
    process.env.EXPORTER_PIDS_LIMIT = "0";
    expect(() => getGhesTargetExecutionConfig()).toThrow(/EXPORTER_PIDS_LIMIT/);
  });
});
