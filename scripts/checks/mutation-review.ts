import { resolve } from "node:path";
import { type MutationLaneId, mutationLanes } from "./mutation-manifest";

const repositoryRoot = resolve(import.meta.dir, "../..");
const ledgerPath = "tests/mutation/reviewed-survivors.json";

export type SurvivorDisposition =
  | "behavioral-gap"
  | "design-signal"
  | "equivalent"
  | "non-contract"
  | "tooling-limitation";

interface SourcePosition {
  line: number;
  column: number;
}

interface ReportMutant {
  id: string;
  location: { start: SourcePosition; end: SourcePosition };
  mutatorName: string;
  replacement: string;
  status: string;
}

interface MutationReport {
  files?: Record<string, { mutants?: ReportMutant[] }>;
}

export interface SurvivorReview {
  id: string;
  lane: MutationLaneId;
  sourcePath: string;
  sourceHash: string;
  mutator: string;
  location: { start: SourcePosition; end: SourcePosition };
  replacement: string;
  disposition: SurvivorDisposition;
  rationale: string;
  followUp?: string;
  reviewedAt: string;
}

interface SurvivorLedger {
  version: 1;
  reviews: SurvivorReview[];
}

interface SurvivorClassification {
  id: string;
  disposition: SurvivorDisposition;
  rationale: string;
  followUp?: string;
  reviewedAt: string;
}

interface SurvivorClassificationFile {
  version: 1;
  classifications: SurvivorClassification[];
}

export interface CurrentMutant {
  id: string;
  lane: MutationLaneId;
  sourcePath: string;
  sourceHash: string;
  mutator: string;
  location: { start: SourcePosition; end: SourcePosition };
  replacement: string;
  status: "Survived" | "Timeout";
}

export interface SurvivorReviewSummary {
  current: CurrentMutant[];
  unreviewed: CurrentMutant[];
  invalidated: SurvivorReview[];
  disappeared: SurvivorReview[];
  openGaps: SurvivorReview[];
  counts: Record<SurvivorDisposition, number>;
  errors: string[];
}

const dispositions: SurvivorDisposition[] = [
  "behavioral-gap",
  "design-signal",
  "equivalent",
  "non-contract",
  "tooling-limitation",
];

function sha256(content: string | ArrayBuffer): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

export function survivorIdentity(input: {
  lane: string;
  sourcePath: string;
  sourceHash: string;
  mutator: string;
  location: { start: SourcePosition; end: SourcePosition };
  replacement: string;
}): string {
  return sha256(
    JSON.stringify([
      input.lane,
      input.sourcePath,
      input.sourceHash,
      input.mutator,
      input.location,
      input.replacement,
    ]),
  );
}

async function currentMutants(root: string): Promise<CurrentMutant[]> {
  const current: CurrentMutant[] = [];
  for (const lane of mutationLanes) {
    const reportFile = Bun.file(resolve(root, lane.reportDirectory, "mutation.json"));
    if (!(await reportFile.exists())) continue;
    const report = (await reportFile.json()) as MutationReport;
    for (const [sourcePath, file] of Object.entries(report.files ?? {})) {
      const sourceHash = sha256(await Bun.file(resolve(root, sourcePath)).arrayBuffer());
      for (const mutant of file.mutants ?? []) {
        if (mutant.status !== "Survived" && mutant.status !== "Timeout") continue;
        const identityInput = {
          lane: lane.id,
          sourcePath,
          sourceHash,
          mutator: mutant.mutatorName,
          location: mutant.location,
          replacement: mutant.replacement,
        };
        current.push({
          id: survivorIdentity(identityInput),
          ...identityInput,
          status: mutant.status,
        });
      }
    }
  }
  return current;
}

export async function reviewSummary(root = repositoryRoot): Promise<SurvivorReviewSummary> {
  const ledger = (await Bun.file(resolve(root, ledgerPath)).json()) as SurvivorLedger;
  const current = await currentMutants(root);
  const errors: string[] = [];
  if (ledger.version !== 1 || !Array.isArray(ledger.reviews)) {
    errors.push("Survivor ledger must use schema version 1 with a reviews array");
  }
  const duplicateIds = ledger.reviews
    .map((review) => review.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  for (const id of new Set(duplicateIds)) errors.push(`Duplicate survivor review: ${id}`);
  for (const review of ledger.reviews) {
    if (!dispositions.includes(review.disposition))
      errors.push(`${review.id}: invalid disposition`);
    if (!review.rationale.trim()) errors.push(`${review.id}: rationale is required`);
    if (
      (review.disposition === "behavioral-gap" || review.disposition === "design-signal") &&
      !review.followUp?.trim()
    ) {
      errors.push(`${review.id}: ${review.disposition} requires a follow-up`);
    }
  }

  const currentById = new Map(current.map((mutant) => [mutant.id, mutant]));
  const reviewedById = new Map(ledger.reviews.map((review) => [review.id, review]));
  const unreviewed = current.filter((mutant) => !reviewedById.has(mutant.id));
  const invalidated = ledger.reviews.filter((review) => {
    const sameMutation = current.find(
      (mutant) =>
        mutant.lane === review.lane &&
        mutant.sourcePath === review.sourcePath &&
        mutant.mutator === review.mutator &&
        JSON.stringify(mutant.location) === JSON.stringify(review.location) &&
        mutant.replacement === review.replacement,
    );
    return sameMutation !== undefined && sameMutation.sourceHash !== review.sourceHash;
  });
  const invalidatedIds = new Set(invalidated.map((review) => review.id));
  const disappeared = ledger.reviews.filter(
    (review) => !currentById.has(review.id) && !invalidatedIds.has(review.id),
  );
  const openGaps = ledger.reviews.filter(
    (review) =>
      currentById.has(review.id) &&
      (review.disposition === "behavioral-gap" || review.disposition === "design-signal"),
  );
  const counts = Object.fromEntries(
    dispositions.map((disposition) => [
      disposition,
      ledger.reviews.filter(
        (review) => currentById.has(review.id) && review.disposition === disposition,
      ).length,
    ]),
  ) as Record<SurvivorDisposition, number>;
  return { current, unreviewed, invalidated, disappeared, openGaps, counts, errors };
}

export async function importSurvivorReviews(
  importPath: string,
  root = repositoryRoot,
): Promise<number> {
  const ledger = (await Bun.file(resolve(root, ledgerPath)).json()) as SurvivorLedger;
  const imported = (await Bun.file(resolve(importPath)).json()) as SurvivorLedger;
  if (imported.version !== 1 || !Array.isArray(imported.reviews)) {
    throw new Error("Imported survivor reviews must use schema version 1 with a reviews array");
  }
  const merged = new Map(ledger.reviews.map((review) => [review.id, review]));
  for (const review of imported.reviews) merged.set(review.id, review);
  await Bun.write(
    resolve(root, ledgerPath),
    `${JSON.stringify({ version: 1, reviews: [...merged.values()] }, null, 2)}\n`,
  );
  return imported.reviews.length;
}

export function resolveSurvivorClassifications(
  classifications: SurvivorClassification[],
  current: CurrentMutant[],
): SurvivorReview[] {
  const currentById = new Map(current.map((mutant) => [mutant.id, mutant]));
  const seen = new Set<string>();
  return classifications.map((classification) => {
    if (seen.has(classification.id)) {
      throw new Error(`Duplicate survivor classification: ${classification.id}`);
    }
    seen.add(classification.id);
    const mutant = currentById.get(classification.id);
    if (!mutant)
      throw new Error(`Classification does not match a current mutant: ${classification.id}`);
    const { status: _status, ...identity } = mutant;
    return { ...identity, ...classification };
  });
}

export async function importSurvivorClassifications(
  importPath: string,
  root = repositoryRoot,
): Promise<number> {
  const imported = (await Bun.file(resolve(importPath)).json()) as SurvivorClassificationFile;
  if (imported.version !== 1 || !Array.isArray(imported.classifications)) {
    throw new Error(
      "Imported classifications must use schema version 1 with a classifications array",
    );
  }
  const reviews = resolveSurvivorClassifications(
    imported.classifications,
    await currentMutants(root),
  );
  const draftPath = resolve(root, ledgerPath);
  const ledger = (await Bun.file(draftPath).json()) as SurvivorLedger;
  const merged = new Map(ledger.reviews.map((review) => [review.id, review]));
  for (const review of reviews) merged.set(review.id, review);
  await Bun.write(
    draftPath,
    `${JSON.stringify({ version: 1, reviews: [...merged.values()] }, null, 2)}\n`,
  );
  return reviews.length;
}

export function refreshInvalidatedSurvivorReviews(
  reviews: SurvivorReview[],
  current: CurrentMutant[],
  reviewedAt: string,
): { reviews: SurvivorReview[]; refreshed: number } {
  const currentIds = new Set(current.map((mutant) => mutant.id));
  let refreshed = 0;
  const updated = reviews.map((review) => {
    if (currentIds.has(review.id)) return review;
    const matches = current.filter(
      (mutant) =>
        mutant.lane === review.lane &&
        mutant.sourcePath === review.sourcePath &&
        mutant.mutator === review.mutator &&
        JSON.stringify(mutant.location) === JSON.stringify(review.location) &&
        mutant.replacement === review.replacement,
    );
    if (matches.length === 0) return review;
    if (matches.length > 1) throw new Error(`Ambiguous invalidated survivor review: ${review.id}`);
    const match = matches[0];
    if (!match) return review;
    const { status: _status, ...identity } = match;
    refreshed += 1;
    return { ...review, ...identity, reviewedAt };
  });
  return { reviews: updated, refreshed };
}

export async function refreshInvalidatedReviews(root = repositoryRoot): Promise<number> {
  const path = resolve(root, ledgerPath);
  const ledger = (await Bun.file(path).json()) as SurvivorLedger;
  const result = refreshInvalidatedSurvivorReviews(
    ledger.reviews,
    await currentMutants(root),
    new Date().toISOString().slice(0, 10),
  );
  await Bun.write(path, `${JSON.stringify({ version: 1, reviews: result.reviews }, null, 2)}\n`);
  return result.refreshed;
}

function printMutant(mutant: CurrentMutant): string {
  return `${mutant.lane} ${mutant.status} ${mutant.sourcePath}:${mutant.location.start.line} ${mutant.mutator} ${mutant.id}`;
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const strict = args.includes("--check");
  const summaryOnly = args.includes("--summary");
  const refreshInvalidated = args.includes("--refresh-invalidated");
  const importIndex = args.indexOf("--import");
  const importPath = importIndex === -1 ? undefined : args[importIndex + 1];
  const classifyIndex = args.indexOf("--classify");
  const classifyPath = classifyIndex === -1 ? undefined : args[classifyIndex + 1];
  const knownArgs = new Set([
    "--check",
    "--summary",
    "--refresh-invalidated",
    "--import",
    importPath,
    "--classify",
    classifyPath,
  ]);
  const unknownArg = args.find((arg) => !knownArgs.has(arg));
  if (unknownArg) throw new Error(`Unknown argument: ${unknownArg}`);
  if (importIndex !== -1 && !importPath) throw new Error("--import requires a review file path");
  if (classifyIndex !== -1 && !classifyPath) {
    throw new Error("--classify requires a classification file path");
  }
  if (importPath && classifyPath) throw new Error("Use either --import or --classify, not both");
  if (refreshInvalidated && (importPath || classifyPath)) {
    throw new Error("Refresh invalidated reviews separately from imports");
  }
  if (importPath) {
    const imported = await importSurvivorReviews(importPath);
    console.log(`Imported survivor reviews: ${imported}`);
  }
  if (classifyPath) {
    const imported = await importSurvivorClassifications(classifyPath);
    console.log(`Imported survivor classifications: ${imported}`);
  }
  if (refreshInvalidated) {
    const refreshed = await refreshInvalidatedReviews();
    console.log(`Refreshed invalidated survivor reviews: ${refreshed}`);
  }
  const summary = await reviewSummary();
  console.log(`Current survivors/timeouts: ${summary.current.length}`);
  console.log(`Unreviewed: ${summary.unreviewed.length}`);
  console.log(`Invalidated: ${summary.invalidated.length}`);
  console.log(`Disappeared: ${summary.disappeared.length}`);
  console.log(`Open gaps: ${summary.openGaps.length}`);
  for (const disposition of dispositions)
    console.log(`${disposition}: ${summary.counts[disposition]}`);
  if (!summaryOnly) {
    for (const mutant of summary.unreviewed) console.log(`UNREVIEWED ${printMutant(mutant)}`);
  }
  for (const error of summary.errors) console.error(`ERROR ${error}`);
  if (
    summary.errors.length > 0 ||
    summary.invalidated.length > 0 ||
    (strict && (summary.unreviewed.length > 0 || summary.openGaps.length > 0))
  ) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
