/**
 * Migration duration estimate — a deliberately coarse, size-band model.
 *
 * There is no published Importer throughput figure, so this is a transparent
 * heuristic, not a guarantee. Each repo is bucketed into a size band by its Git
 * disk usage; each band carries a low/high per-repo hour range; the org total is
 * the sum across repos. Wall-clock time then divides that total by how many
 * migrations run concurrently (the migrate queue caps at 10). The detail page
 * lets the user adjust parallelism, so the division is done client-side — this
 * module supplies the band counts and the summed per-repo hours.
 *
 * The band thresholds and hour ranges are centralized constants below; tune them
 * as real migration timings accumulate.
 */
import type { StoredRepoProfile } from "./types";

/** Size-band key, smallest to largest. */
type SizeBand = "S" | "M" | "L" | "XL";

interface BandDef {
  band: SizeBand;
  /** Exclusive upper bound on Git disk usage, in KiB (Infinity for the top band). */
  maxKb: number;
  /** Low/high per-repo migration hour estimate for a repo in this band. */
  lowHours: number;
  highHours: number;
}

/**
 * Bands by Git disk usage (KiB). The hour ranges are rough order-of-magnitude
 * guesses spanning a single repo's archive export + upload + import; they are
 * intentionally wide and meant to be calibrated against real runs.
 */
const TOP_BAND: BandDef = {
  band: "XL",
  maxKb: Number.POSITIVE_INFINITY,
  lowHours: 2,
  highHours: 6,
}; // ≥ 5 GiB
const BANDS: readonly BandDef[] = [
  { band: "S", maxKb: 100 * 1024, lowHours: 0.1, highHours: 0.25 }, // < 100 MiB
  { band: "M", maxKb: 1024 * 1024, lowHours: 0.25, highHours: 0.75 }, // < 1 GiB
  { band: "L", maxKb: 5 * 1024 * 1024, lowHours: 0.75, highHours: 2 }, // < 5 GiB
  TOP_BAND,
];

/** The migrate queue runs at most this many migrations at once (GitHub's cap). */
const DEFAULT_PARALLELISM = 10;

/** Bucket a repo's disk usage (null → 0) into its size band. */
function bandFor(diskUsageKb: number | null): BandDef {
  const kb = diskUsageKb ?? 0;
  return BANDS.find((b) => kb < b.maxKb) ?? TOP_BAND;
}

/** Per-band repo counts. */
type BandCounts = Record<SizeBand, number>;

/**
 * The size-band duration model. Per-repo hours are the *sequential* total
 * work; wall-clock time is `total / parallelism`, computed by the caller so the
 * parallelism knob stays interactive.
 */
export interface DurationEstimate {
  /** Repos per size band. */
  bandCounts: BandCounts;
  /** Sum of per-repo low-end hours across all repos (sequential work). */
  totalRepoHoursLow: number;
  /** Sum of per-repo high-end hours across all repos (sequential work). */
  totalRepoHoursHigh: number;
  /** Parallelism assumed for the headline figure (the migrate queue cap). */
  defaultParallelism: number;
}

/**
 * Estimate migration duration from a run's per-repo profiles.
 *
 * @param repos The run's persisted per-repo profiles (only disk usage is read).
 * @returns     Band counts, summed sequential hours, and the default parallelism.
 */
export function estimateDuration(repos: StoredRepoProfile[]): DurationEstimate {
  const bandCounts: BandCounts = { S: 0, M: 0, L: 0, XL: 0 };
  let totalRepoHoursLow = 0;
  let totalRepoHoursHigh = 0;

  for (const repo of repos) {
    const b = bandFor(repo.signals.diskUsageKb);
    bandCounts[b.band] += 1;
    totalRepoHoursLow += b.lowHours;
    totalRepoHoursHigh += b.highHours;
  }

  return {
    bandCounts,
    totalRepoHoursLow,
    totalRepoHoursHigh,
    defaultParallelism: DEFAULT_PARALLELISM,
  };
}
