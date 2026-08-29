import { type RepositorySizeBand, repositorySizeBand } from "$lib/repository-size";
import type { StoredRepoProfile } from "../types";

interface BandEstimate {
  lowHours: number;
  highHours: number;
}

const BAND_ESTIMATES: Record<RepositorySizeBand, BandEstimate> = {
  S: { lowHours: 0.1, highHours: 0.25 },
  M: { lowHours: 0.25, highHours: 0.75 },
  L: { lowHours: 0.75, highHours: 2 },
  XL: { lowHours: 2, highHours: 6 },
};

const DEFAULT_PARALLELISM = 10;

type BandCounts = Record<RepositorySizeBand, number>;

export interface DurationEstimate {
  bandCounts: BandCounts;
  totalRepoHoursLow: number;
  totalRepoHoursHigh: number;
  defaultParallelism: number;
}

export function estimateDuration(repos: Iterable<StoredRepoProfile>): DurationEstimate {
  const bandCounts: BandCounts = { S: 0, M: 0, L: 0, XL: 0 };
  let totalRepoHoursLow = 0;
  let totalRepoHoursHigh = 0;

  for (const repo of repos) {
    const band = repositorySizeBand(repo.signals.diskUsageKb ?? 0);
    const estimate = BAND_ESTIMATES[band];
    bandCounts[band] += 1;
    totalRepoHoursLow += estimate.lowHours;
    totalRepoHoursHigh += estimate.highHours;
  }

  return {
    bandCounts,
    totalRepoHoursLow,
    totalRepoHoursHigh,
    defaultParallelism: DEFAULT_PARALLELISM,
  };
}
