import type { RepoSignals } from "./types";

export function releaseScanComplete(
  signals: Pick<RepoSignals, "releaseAssetScanComplete">,
): boolean {
  return signals.releaseAssetScanComplete;
}

export function ruleScanComplete(signals: Pick<RepoSignals, "branchRuleScanComplete">): boolean {
  return signals.branchRuleScanComplete;
}
