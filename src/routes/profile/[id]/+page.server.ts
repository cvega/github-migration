import { error, fail } from "@sveltejs/kit";
import { isSourceAuthAvailable } from "$lib/server/core/auth";
import type { RepoReadinessFilter } from "$lib/server/profile/database/repos";
import { retryRepositoryAnalysisJob } from "$lib/server/profile/database/repository-analysis-jobs";
import {
  cancelRepositoryAnalysis,
  startRepositoryAnalysis,
} from "$lib/server/profile/database/repository-analysis-runs";
import { getProfileDetail } from "$lib/server/profile/service";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params, url }) => {
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const readiness = url.searchParams.get("readiness");
  const readinessFilter: RepoReadinessFilter =
    readiness === "ready" || readiness === "warnings" || readiness === "blockers"
      ? readiness
      : "all";
  const detail = getProfileDetail(params.id, {
    page,
    search: (url.searchParams.get("search") ?? "").slice(0, 100),
    readiness: readinessFilter,
    analysisRunId: url.searchParams.get("analysisRunId") ?? undefined,
  });
  if (!detail) error(404, "Profile run not found");
  return { ...detail, repositoryAnalysisAvailable: isSourceAuthAvailable() };
};

function actionFailure(cause: unknown) {
  return fail(400, {
    analysisError: cause instanceof Error ? cause.message : "Repository analysis failed",
  });
}

export const actions: Actions = {
  startAnalysis: ({ params }) => {
    if (!isSourceAuthAvailable()) {
      return fail(400, {
        analysisError: "Repository analysis requires server-managed source credentials",
      });
    }
    try {
      const detail = startRepositoryAnalysis(params.id);
      return {
        analysisSuccess: `Queued ${detail.run.selectedRepoCount} repositories for analysis`,
      };
    } catch (cause) {
      return actionFailure(cause);
    }
  },
  cancelAnalysis: async ({ params, request }) => {
    const analysisRunId = (await request.formData()).get("analysisRunId")?.toString();
    if (!analysisRunId) return fail(400, { analysisError: "Analysis run ID is required" });
    try {
      cancelRepositoryAnalysis(params.id, analysisRunId);
      return { analysisSuccess: "Repository analysis cancelled" };
    } catch (cause) {
      return actionFailure(cause);
    }
  },
  retryAnalysisJob: async ({ params, request }) => {
    if (!isSourceAuthAvailable()) {
      return fail(400, {
        analysisError: "Repository analysis requires server-managed source credentials",
      });
    }
    const data = await request.formData();
    const analysisRunId = data.get("analysisRunId")?.toString();
    const jobId = data.get("jobId")?.toString();
    if (!analysisRunId || !jobId) {
      return fail(400, { analysisError: "Analysis run ID and job ID are required" });
    }
    try {
      retryRepositoryAnalysisJob({ profileRunId: params.id, analysisRunId, jobId });
      return { analysisSuccess: "Repository queued for analysis" };
    } catch (cause) {
      return actionFailure(cause);
    }
  },
};
