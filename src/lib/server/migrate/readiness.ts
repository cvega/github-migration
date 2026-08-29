import {
  type CapabilityContext,
  type CapabilityReport,
  getCapabilityReport,
  getMigrationCapability,
  type MigrationCapability,
} from "$lib/server/capability-report";
import type { SourceProvider } from "$lib/source/types";

export type { CapabilityContext, CapabilityReport, MigrationCapability };

export function getMigrationReadiness(
  sourceProvider: SourceProvider,
  targetProfileId = "ghec",
  context: CapabilityContext = {},
): MigrationCapability {
  return getMigrationCapability(sourceProvider, targetProfileId, context);
}

export function getMigrationReadinessReport(): CapabilityReport {
  return getCapabilityReport();
}
