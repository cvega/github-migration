#!/usr/bin/env bun

import { closeStore, initStore } from "$lib/server/core/db";
import {
  processNextRepositoryAnalysisJob,
  runRepositoryAnalysisClaimLoop,
} from "$lib/server/profile/repository-analysis/claim-loop";
import { createAnalyzerHealth } from "$lib/server/profile/repository-analysis/health";
import { DOMAIN_STORES } from "$lib/server/schemas";

const dataDirectory = process.env.DATA_DIR || "/data";
const workspaceRoot = process.env.ANALYSIS_DIR || "/analysis";
const operationalCeiling = Number(process.env.ANALYSIS_WORKSPACE_LIMIT_BYTES ?? "");
const controller = new AbortController();

process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

let healthServer: ReturnType<typeof Bun.serve> | undefined;
try {
  initStore(`${dataDirectory}/gh-migrate.db`, DOMAIN_STORES, { runStartupHooks: false });
  console.log(`[profile-analyzer] Watching for repository analysis jobs in ${workspaceRoot}`);
  const options = {
    workspaceRoot,
    leaseOwner: `profile-analyzer-${process.pid}`,
    operationalCeilingBytes:
      Number.isSafeInteger(operationalCeiling) && operationalCeiling > 0
        ? operationalCeiling
        : undefined,
    signal: controller.signal,
  };
  if (process.env.ANALYSIS_RUN_ONCE === "true") {
    const processed = await processNextRepositoryAnalysisJob(options);
    console.log(
      processed ? "[profile-analyzer] One-job run completed" : "[profile-analyzer] No queued jobs",
    );
  } else {
    const port = process.env.ANALYSIS_HEALTH_PORT;
    const health = createAnalyzerHealth();
    if (port) {
      const healthPort = Number(port);
      if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65_535) {
        throw new Error("ANALYSIS_HEALTH_PORT must be an integer between 1 and 65535");
      }
      healthServer = Bun.serve({
        hostname: "127.0.0.1",
        port: healthPort,
        routes: { "/health": { GET: health.response } },
        fetch: () => new Response(null, { status: 404 }),
      });
    }
    await runRepositoryAnalysisClaimLoop({ ...options, onProgress: health.reportProgress });
  }
} finally {
  await healthServer?.stop(true);
  closeStore();
}
