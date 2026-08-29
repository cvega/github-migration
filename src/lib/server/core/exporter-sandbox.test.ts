import { afterEach, describe, expect, test } from "bun:test";
import { getExporterSandboxPolicy } from "./exporter-sandbox";

const KEYS = [
  "EXPORTER_NETWORK",
  "EXPORTER_MEMORY",
  "EXPORTER_CPUS",
  "EXPORTER_PIDS_LIMIT",
  "EXPORTER_TMPFS_SIZE",
] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("exporter sandbox policy", () => {
  test("uses bounded defaults", () => {
    expect(getExporterSandboxPolicy()).toEqual({
      network: "bridge",
      memory: "2g",
      cpus: 2,
      pidsLimit: 256,
      tmpfsSize: "1g",
    });
  });

  test("accepts explicit bounded settings", () => {
    process.env.EXPORTER_NETWORK = "migration-exporters";
    process.env.EXPORTER_MEMORY = "4096MiB";
    process.env.EXPORTER_CPUS = "1.5";
    process.env.EXPORTER_PIDS_LIMIT = "512";
    process.env.EXPORTER_TMPFS_SIZE = "2g";

    expect(getExporterSandboxPolicy()).toEqual({
      network: "migration-exporters",
      memory: "4096mib",
      cpus: 1.5,
      pidsLimit: 512,
      tmpfsSize: "2g",
    });
  });

  test("rejects host networking and unbounded resource values", () => {
    process.env.EXPORTER_NETWORK = "host";
    expect(() => getExporterSandboxPolicy()).toThrow("EXPORTER_NETWORK");
    delete process.env.EXPORTER_NETWORK;

    for (const [key, value] of [
      ["EXPORTER_MEMORY", "unbounded"],
      ["EXPORTER_CPUS", "0"],
      ["EXPORTER_PIDS_LIMIT", "8"],
      ["EXPORTER_TMPFS_SIZE", "0"],
    ] as const) {
      process.env[key] = value;
      expect(() => getExporterSandboxPolicy()).toThrow(key);
      delete process.env[key];
    }
  });
});
