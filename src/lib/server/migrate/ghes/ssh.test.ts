import { describe, expect, test } from "bun:test";
import { GhesSshClient } from "./ssh";

const config = {
  remoteDirectory: "/data/user/tmp",
} as ConstructorParameters<typeof GhesSshClient>[0];

describe("GHES SSH client", () => {
  test("derives only safe remote archive paths", () => {
    const client = new GhesSshClient(config);
    expect(client.remoteArchivePath("/tmp/export-1.tar.gz")).toBe("/data/user/tmp/export-1.tar.gz");
    expect(() => client.remoteArchivePath("/tmp/export.tar")).toThrow(
      "Invalid GHES archive filename",
    );
  });

  test("rejects commands before a pinned SSH connection is established", async () => {
    const client = new GhesSshClient(config);
    await expect(client.conflicts("migration-guid-123")).rejects.toThrow("not connected");
    expect(() => client.conflicts("bad")).toThrow("Invalid ghe-migrator GUID");
  });
});
