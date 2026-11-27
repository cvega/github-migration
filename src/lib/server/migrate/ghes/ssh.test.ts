import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { GhesMigratorBusyError, GhesSshClient } from "./ssh";

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

  test.each([0, 1])("recognizes a prepare lock rejection with exit code %i", async (code) => {
    const channel = new EventEmitter();
    const stderr = new EventEmitter();
    const connection = new EventEmitter();
    Object.assign(channel, {
      stderr,
      end: () =>
        queueMicrotask(() => {
          stderr.emit("data", Buffer.from("ghe-migrator already running, please wait\n"));
          channel.emit("exit", code);
          channel.emit("close");
        }),
    });
    Object.assign(connection, {
      connect: () => {
        queueMicrotask(() => connection.emit("ready"));
        return connection;
      },
      exec: (_command: string, callback: (error: null, channel: EventEmitter) => void) =>
        callback(null, channel),
      end: () => {},
    });
    const client = new GhesSshClient(config, connection as never);
    await client.connect();
    await expect(client.prepare("/remote/archive")).rejects.toThrow(GhesMigratorBusyError);
  });
});
