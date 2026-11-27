import type { RepoSignals } from "./types";

// Historical scans lacked pagination metadata. A release may have unseen assets
// even when all releases fit on one page.
export function releaseScanComplete(
  signals: Pick<RepoSignals, "releaseAssetScanComplete"> & { releasesCount: number | null },
): boolean {
  return signals.releaseAssetScanComplete ?? signals.releasesCount === 0;
}

export function ruleScanComplete(
  signals: Pick<RepoSignals, "branchRuleScanComplete"> & {
    branchProtectionRuleCount: number | null;
  },
): boolean {
  return (
    signals.branchRuleScanComplete ??
    (signals.branchProtectionRuleCount !== null && signals.branchProtectionRuleCount <= 50)
  );
}
