export type RepositorySizeBand = "S" | "M" | "L" | "XL";

export const REPOSITORY_SIZE_BANDS: ReadonlyArray<{
  band: RepositorySizeBand;
  label: string;
  maxKb: number;
}> = [
  { band: "S", label: "Under 100 MiB", maxKb: 100 * 1024 },
  { band: "M", label: "100 MiB–1 GiB", maxKb: 1024 * 1024 },
  { band: "L", label: "1–5 GiB", maxKb: 5 * 1024 * 1024 },
  { band: "XL", label: "5 GiB and over", maxKb: Number.POSITIVE_INFINITY },
];

export function repositorySizeBand(sizeKb: number): RepositorySizeBand {
  return REPOSITORY_SIZE_BANDS.find((definition) => sizeKb < definition.maxKb)?.band ?? "XL";
}
