import { env } from "node:process";
import { ConfigIssueError } from "./config-issue";

export interface ExporterSandboxPolicy {
  network: string;
  memory: string;
  cpus: number;
  pidsLimit: number;
  tmpfsSize: string;
}

function dockerSize(name: string, value: string | undefined, fallback: string): string {
  const normalized = value?.trim().toLowerCase() || fallback;
  if (!/^[1-9]\d*(?:[kmgt]i?b?|b)?$/.test(normalized)) {
    throw new ConfigIssueError(name, "docker-size");
  }
  return normalized;
}

function cpus(value: string | undefined): number {
  const normalized = value?.trim() || "2";
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new ConfigIssueError("EXPORTER_CPUS", "cpus");
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 64) {
    throw new ConfigIssueError("EXPORTER_CPUS", "cpus");
  }
  return parsed;
}

function pidsLimit(value: string | undefined): number {
  const normalized = value?.trim() || "256";
  if (!/^\d+$/.test(normalized)) {
    throw new ConfigIssueError("EXPORTER_PIDS_LIMIT", "pids-limit");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 16 || parsed > 4096) {
    throw new ConfigIssueError("EXPORTER_PIDS_LIMIT", "pids-limit");
  }
  return parsed;
}

function network(value: string | undefined): string {
  const normalized = value?.trim() || "bridge";
  if (
    normalized === "host" ||
    normalized.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(normalized)
  ) {
    throw new ConfigIssueError("EXPORTER_NETWORK", "docker-network");
  }
  return normalized;
}

const settings = {
  network: () => network(env.EXPORTER_NETWORK),
  memory: () => dockerSize("EXPORTER_MEMORY", env.EXPORTER_MEMORY, "2g"),
  cpus: () => cpus(env.EXPORTER_CPUS),
  pidsLimit: () => pidsLimit(env.EXPORTER_PIDS_LIMIT),
  tmpfsSize: () => dockerSize("EXPORTER_TMPFS_SIZE", env.EXPORTER_TMPFS_SIZE, "1g"),
};

/** One validation per sandbox setting, so callers can report each independently. */
export const exporterSandboxChecks: ReadonlyArray<() => unknown> = Object.values(settings);

export function getExporterSandboxPolicy(): ExporterSandboxPolicy {
  return {
    network: settings.network(),
    memory: settings.memory(),
    cpus: settings.cpus(),
    pidsLimit: settings.pidsLimit(),
    tmpfsSize: settings.tmpfsSize(),
  };
}
