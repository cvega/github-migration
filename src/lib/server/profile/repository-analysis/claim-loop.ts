import {
  claimRepositoryAnalysisJob,
  completeRepositoryAnalysisJob,
  failRepositoryAnalysisJob,
  renewRepositoryAnalysisJobLease,
} from "../database/repository-analysis-jobs";
import { analyzeRepository, RepositoryAnalysisError } from "./analyze-repository";
import { getRepositoryAnalysisSourceToken } from "./source-auth";

const LEASE_MS = 60_000;

export interface RepositoryAnalysisLoopOptions {
  workspaceRoot: string;
  leaseOwner: string;
  operationalCeilingBytes?: number;
  idleMs?: number;
  signal?: AbortSignal;
}

export interface RepositoryAnalysisLoopDependencies {
  analyze: typeof analyzeRepository;
  getSourceToken: typeof getRepositoryAnalysisSourceToken;
  newId(): string;
}

const DEFAULT_DEPS: RepositoryAnalysisLoopDependencies = {
  analyze: analyzeRepository,
  getSourceToken: getRepositoryAnalysisSourceToken,
  newId: () => Bun.randomUUIDv7(),
};

export async function processNextRepositoryAnalysisJob(
  options: RepositoryAnalysisLoopOptions,
  dependencies: RepositoryAnalysisLoopDependencies = DEFAULT_DEPS,
): Promise<boolean> {
  const job = claimRepositoryAnalysisJob({ leaseOwner: options.leaseOwner, leaseMs: LEASE_MS });
  if (!job) return false;
  console.log(`[profile-analyzer] Analyzing ${job.nameWithOwner} (attempt ${job.attempt})`);
  const heartbeat = setInterval(() => {
    renewRepositoryAnalysisJobLease({
      jobId: job.id,
      attempt: job.attempt,
      leaseOwner: options.leaseOwner,
      leaseMs: LEASE_MS,
    });
  }, LEASE_MS / 2);
  try {
    const result = await dependencies.analyze(
      job,
      {
        workspaceRoot: options.workspaceRoot,
        operationalCeilingBytes: options.operationalCeilingBytes,
      },
      { getSourceToken: dependencies.getSourceToken },
    );
    completeRepositoryAnalysisJob({
      job,
      leaseOwner: options.leaseOwner,
      resultId: dependencies.newId(),
      result,
    });
    console.log(`[profile-analyzer] Completed ${job.nameWithOwner}`);
  } catch (error) {
    const reason =
      error instanceof RepositoryAnalysisError
        ? error.message
        : "Repository analysis failed; check source access and analyzer configuration";
    try {
      failRepositoryAnalysisJob({ job, leaseOwner: options.leaseOwner, reason });
    } catch (leaseError) {
      console.warn(
        `[profile-analyzer] ${job.nameWithOwner} stopped after its lease ended`,
        leaseError,
      );
    }
    console.error(`[profile-analyzer] Failed ${job.nameWithOwner}: ${reason}`);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

export async function runRepositoryAnalysisClaimLoop(
  options: RepositoryAnalysisLoopOptions,
  dependencies: RepositoryAnalysisLoopDependencies = DEFAULT_DEPS,
): Promise<void> {
  const idleMs = options.idleMs ?? 1_000;
  while (!options.signal?.aborted) {
    const processed = await processNextRepositoryAnalysisJob(options, dependencies);
    if (!processed) await Bun.sleep(idleMs);
  }
}
