import { findMissingProfileProjectPaths } from "./database/repos";
import { findRepositoriesAwaitingAnalysis } from "./database/repository-analysis-runs";
import type { ProfileRun } from "./types";

export function profileSelectionError(
  run: ProfileRun,
  paths: readonly string[],
  inventory = { findMissingProfileProjectPaths, findRepositoriesAwaitingAnalysis },
): string | null {
  const [missing] = inventory.findMissingProfileProjectPaths(run.id, paths);
  if (missing) return `Repository '${missing}' is not part of the profile run`;
  if (run.sourceProvider === "github") {
    const [flagged] = inventory.findRepositoriesAwaitingAnalysis(run.id, paths);
    if (flagged) return `Repository '${flagged}' requires successful Git analysis`;
  }
  return null;
}
