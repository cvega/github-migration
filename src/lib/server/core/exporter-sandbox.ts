import { env } from "$env/dynamic/private";

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
    throw new TypeError(`${name} must be a positive Docker size such as 512m or 2g`);
  }
  return normalized;
}

function cpus(value: string | undefined): number {
  const normalized = value?.trim() || "2";
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new TypeError("EXPORTER_CPUS must be a number between 0.1 and 64");
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 64) {
    throw new TypeError("EXPORTER_CPUS must be a number between 0.1 and 64");
  }
  return parsed;
}

function pidsLimit(value: string | undefined): number {
  const normalized = value?.trim() || "256";
  if (!/^\d+$/.test(normalized)) {
    throw new TypeError("EXPORTER_PIDS_LIMIT must be an integer between 16 and 4096");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 16 || parsed > 4096) {
    throw new TypeError("EXPORTER_PIDS_LIMIT must be an integer between 16 and 4096");
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
    throw new TypeError("EXPORTER_NETWORK must be a Docker network name other than 'host'");
  }
  return normalized;
}

export function getExporterSandboxPolicy(): ExporterSandboxPolicy {
  return {
    network: network(env.EXPORTER_NETWORK),
    memory: dockerSize("EXPORTER_MEMORY", env.EXPORTER_MEMORY, "2g"),
    cpus: cpus(env.EXPORTER_CPUS),
    pidsLimit: pidsLimit(env.EXPORTER_PIDS_LIMIT),
    tmpfsSize: dockerSize("EXPORTER_TMPFS_SIZE", env.EXPORTER_TMPFS_SIZE, "1g"),
  };
}
