#!/usr/bin/env bun

import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { profileStore } from "$lib/server/profile/database/schema";
import {
  processNextRepositoryAnalysisJob,
  runRepositoryAnalysisClaimLoop,
} from "$lib/server/profile/repository-analysis/claim-loop";

const dataDirectory = process.env.DATA_DIR || "/data";
const workspaceRoot = process.env.ANALYSIS_DIR || "/analysis";
const operationalCeiling = Number(process.env.ANALYSIS_WORKSPACE_LIMIT_BYTES ?? "");
const controller = new AbortController();

process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

initStore(`${dataDirectory}/gh-migrate.db`, []);
profileStore.applySchema(getDb());
console.log(`[profile-analyzer] Watching for repository analysis jobs in ${workspaceRoot}`);
try {
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
    await runRepositoryAnalysisClaimLoop(options);
  }
} finally {
  closeStore();
}
