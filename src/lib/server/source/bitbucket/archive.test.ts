import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadBitbucketArchive,
  getBitbucketSftpIssues,
  type SftpArchiveClient,
} from "$lib/server/source/bitbucket/archive";

const roots: string[] = [];
const HOST_KEY = Buffer.from("ssh-rsa bitbucket host key fixture");
const OTHER_HOST_KEY = Buffer.from("different bitbucket host key fixture");
const HOST_FINGERPRINT = createHash("sha256").update(HOST_KEY).digest("base64").replace(/=+$/, "");
const OTHER_HOST_FINGERPRINT = createHash("sha256")
  .update(OTHER_HOST_KEY)
  .digest("base64")
  .replace(/=+$/, "");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      Bun.file(root)
        .delete()
        .catch(() => {}),
    ),
  );
});

async function fixture(
  contents = "archive",
  remoteSize = contents.length,
  hostFingerprint = `SHA256:${HOST_FINGERPRINT}`,
) {
  const root = await mkdtemp(join(tmpdir(), "bitbucket-archive-"));
  roots.push(root);
  const connect = mock(async (_config: Record<string, unknown>) => undefined);
  const statRemote = mock(async (_path: string) => ({ size: remoteSize }));
  const fastGet = mock(async (_remotePath: string, localPath: string) => {
    await Bun.write(localPath, contents);
    return localPath;
  });
  const end = mock(async () => undefined);
  const client: SftpArchiveClient = { connect, stat: statRemote, fastGet, end };
  const config = {
    host: "bitbucket.internal",
    port: 22,
    username: "migration",
    privateKey: "secret-key",
    hostFingerprint,
    sharedHome: "/srv/bitbucket/shared",
    archiveDirectory: root,
    maxArchiveBytes: 1024,
  };
  return {
    root,
    connect,
    statRemote,
    fastGet,
    end,
    dependencies: { config, createClient: () => client, newId: () => "fixed-id" },
  };
}

describe("downloadBitbucketArchive", () => {
  test("verifies the host and atomically stages the expected export", async () => {
    const current = await fixture();
    const path = await downloadBitbucketArchive("42", undefined, current.dependencies);

    expect(path).toBe(join(current.root, "bitbucket-fixed-id.tar"));
    expect(await readFile(path, "utf8")).toBe("archive");
    expect(current.fastGet.mock.calls[0]?.[0]).toBe(
      "/srv/bitbucket/shared/data/migration/export/Bitbucket_export_42.tar",
    );
    const connectConfig = current.connect.mock.calls[0]?.[0] as {
      hostHash?: string;
      hostVerifier(key: Buffer): boolean;
    };
    expect(connectConfig.hostHash).toBeUndefined();
    expect(connectConfig.hostVerifier(HOST_KEY)).toBe(true);
    expect(connectConfig.hostVerifier(OTHER_HOST_KEY)).toBe(false);
    expect(current.end).toHaveBeenCalledTimes(1);
  });

  test("fails closed for malformed, mismatched, and legacy hex fingerprints", async () => {
    const fingerprints = [
      OTHER_HOST_FINGERPRINT,
      "!malformed!",
      HOST_FINGERPRINT.slice(1),
      createHash("sha256").update(HOST_KEY).digest("hex"),
    ];

    for (const fingerprint of fingerprints) {
      const current = await fixture("archive", 7, fingerprint);
      await downloadBitbucketArchive("42", undefined, current.dependencies);
      const connectConfig = current.connect.mock.calls[0]?.[0] as {
        hostVerifier(key: Buffer): boolean;
      };

      expect(() => connectConfig.hostVerifier(HOST_KEY)).not.toThrow();
      expect(connectConfig.hostVerifier(HOST_KEY)).toBe(false);
    }
  });

  test("rejects oversized and mismatched archives without publishing partial files", async () => {
    const oversized = await fixture("archive", 2048);
    await expect(downloadBitbucketArchive("1", undefined, oversized.dependencies)).rejects.toThrow(
      "exceeds",
    );
    expect(oversized.fastGet).not.toHaveBeenCalled();

    const mismatched = await fixture("short", 10);
    await expect(downloadBitbucketArchive("2", undefined, mismatched.dependencies)).rejects.toThrow(
      "size did not match",
    );
    await expect(stat(join(mismatched.root, "bitbucket-fixed-id.tar.partial"))).rejects.toThrow();
  });

  test("rejects untrusted export IDs before connecting", async () => {
    const current = await fixture();
    await expect(
      downloadBitbucketArchive("../42", undefined, current.dependencies),
    ).rejects.toThrow("positive integer");
    expect(current.connect).not.toHaveBeenCalled();
  });
});

describe("Bitbucket SFTP configuration issues", () => {
  const keys = [
    "BITBUCKET_SERVER_URL",
    "BITBUCKET_SERVER_SSH_USERNAME",
    "BITBUCKET_SERVER_SSH_PRIVATE_KEY",
    "BITBUCKET_SERVER_SSH_HOST_KEY_SHA256",
    "BITBUCKET_SERVER_SSH_PORT",
    "BITBUCKET_SERVER_SHARED_HOME",
    "BITBUCKET_SERVER_MAX_ARCHIVE_BYTES",
    "ARCHIVE_DIR",
  ] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const key of keys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function configure(): void {
    process.env.BITBUCKET_SERVER_URL = "https://bitbucket.example.com";
    process.env.BITBUCKET_SERVER_SSH_USERNAME = "migration";
    process.env.BITBUCKET_SERVER_SSH_PRIVATE_KEY = "synthetic-key";
    process.env.BITBUCKET_SERVER_SSH_HOST_KEY_SHA256 = "synthetic-fingerprint";
    process.env.ARCHIVE_DIR = "/archives";
  }

  test("names each missing setting and nothing else", () => {
    configure();
    expect(getBitbucketSftpIssues()).toEqual([]);
    delete process.env.BITBUCKET_SERVER_SSH_PRIVATE_KEY;
    delete process.env.ARCHIVE_DIR;
    expect(getBitbucketSftpIssues().map((issue) => issue.variable)).toEqual([
      "BITBUCKET_SERVER_SSH_PRIVATE_KEY",
      "ARCHIVE_DIR",
    ]);
  });

  test("states the violated rule without echoing invalid values", () => {
    configure();
    process.env.BITBUCKET_SERVER_URL = "https://user:synthetic-secret@";
    process.env.ARCHIVE_DIR = "relative/synthetic-path";
    process.env.BITBUCKET_SERVER_SHARED_HOME = "synthetic-home";
    process.env.BITBUCKET_SERVER_SSH_PORT = "synthetic-port";
    const issues = getBitbucketSftpIssues();
    expect(issues.map((issue) => issue.text)).toEqual([
      "BITBUCKET_SERVER_URL must be a valid URL",
      "ARCHIVE_DIR must be an absolute path",
      "BITBUCKET_SERVER_SHARED_HOME must be an absolute path",
      "BITBUCKET_SERVER_SSH_PORT must be a positive integer",
    ]);
    expect(JSON.stringify(issues)).not.toContain("synthetic");
  });
});
