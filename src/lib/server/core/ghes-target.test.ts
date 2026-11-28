import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getBitbucketGhesTargetExecutionConfig,
  getGhesTargetExecutionConfig,
  isGhesTargetExecutionConfigured,
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
      expect(isGhesTargetExecutionConfigured()).toBe(false);
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
    expect(isGhesTargetExecutionConfigured(undefined, "bitbucket-server")).toBe(true);
    expect(isGhesTargetExecutionConfigured(undefined, "gitlab")).toBe(false);
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
