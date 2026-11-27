import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test.each([
    ["ack", "abort"],
    ["ack", "deadline"],
    ["backpressure", "abort"],
    ["backpressure", "deadline"],
  ] as const)("interrupts SCP at %s on %s", async (stall, interruption) => {
    const dir = await mkdtemp(join(tmpdir(), "ghes-scp-"));
    const archive = join(dir, "fixture.tar.gz");
    const controller = new AbortController();
    const connection = new EventEmitter();
    let dataWrites = 0;
    let stalled = false;
    let destroyed = 0;
    function reachStall() {
      stalled = true;
      if (interruption === "abort") queueMicrotask(() => controller.abort());
    }
    const channel = Object.assign(new EventEmitter(), {
      write(chunk: string | Buffer) {
        if (typeof chunk === "string") {
          if (stall === "ack") reachStall();
          else queueMicrotask(() => channel.emit("data", Buffer.from([0])));
          return true;
        }
        dataWrites++;
        reachStall();
        return false;
      },
    });
    Object.assign(connection, {
      connect() {
        queueMicrotask(() => connection.emit("ready"));
      },
      exec(_command: string, callback: (error: null, stream: EventEmitter) => void) {
        callback(null, channel);
        channel.once("newListener", () =>
          queueMicrotask(() => channel.emit("data", Buffer.from([0]))),
        );
      },
      destroy() {
        destroyed++;
        channel.emit("close");
      },
      end() {},
    });
    const client = new GhesSshClient(
      config,
      connection as never,
      interruption === "abort" ? 5000 : 350,
    );
    try {
      await writeFile(archive, "offline archive fixture");
      await client.connect(controller.signal);
      await expect(client.uploadArchive(archive)).rejects.toThrow("interrupted");
      expect(stalled).toBe(true);
      expect(dataWrites).toBe(stall === "ack" ? 0 : 1);
      expect(destroyed).toBe(1);
      await Bun.sleep(0);
      for (const event of ["drain", "data", "error", "close"])
        expect(channel.listenerCount(event)).toBe(0);
    } finally {
      client.disconnect();
      await rm(dir, { recursive: true, force: true });
    }
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
