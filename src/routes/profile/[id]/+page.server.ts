import { error, fail } from "@sveltejs/kit";
import {
  getOwnProfileDetail,
  ownSourceChoices,
  resolveOwnProfile,
} from "$lib/server/application/self-service/profiles";
import { isSourceAuthAvailable } from "$lib/server/core/auth";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { getDb } from "$lib/server/core/db";
import type { RepoReadinessFilter } from "$lib/server/profile/database/repos";
import { retryRepositoryAnalysisJob } from "$lib/server/profile/database/repository-analysis-jobs";
import {
  cancelRepositoryAnalysis,
  startRepositoryAnalysis,
} from "$lib/server/profile/database/repository-analysis-runs";
import { getProfileDetail } from "$lib/server/profile/service";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params, url, locals }) => {
  if (locals?.authEnabled && !locals.user) error(401);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const readiness = url.searchParams.get("readiness");
  const readinessFilter: RepoReadinessFilter =
    readiness === "ready" || readiness === "warnings" || readiness === "blockers"
      ? readiness
      : "all";
  const options = {
    page,
    search: (url.searchParams.get("search") ?? "").slice(0, 100),
    readiness: readinessFilter,
    analysisRunId: url.searchParams.get("analysisRunId") ?? undefined,
  };
  if (locals?.user?.role === "operator") {
    const profile = resolveOwnProfile(locals.user.id, params.id);
    if (!profile) error(404, "Profile run not found");
    return {
      ...getOwnProfileDetail(profile.run, options),
      repositoryAnalysisAvailable: false,
      assignments: profile.grants.map(({ id, targetProfileId, targetOrg, canMigrate }) => ({
        id,
        targetProfileId,
        targetOrg,
        canMigrate,
      })),
      sourceChoices: ownSourceChoices(locals.user.id),
    };
  }
  const detail = getProfileDetail(params.id, options);
  if (!detail) error(404, "Profile run not found");
  return {
    ...detail,
    repositoryAnalysisAvailable: isSourceAuthAvailable(),
    assignments: null,
    sourceChoices: [],
  };
};

function actionFailure(cause: unknown) {
  return fail(400, {
    analysisError: cause instanceof Error ? cause.message : "Repository analysis failed",
  });
}

function requireAnalysisAccess(locals: App.Locals) {
  if (locals?.user?.role === "operator" || (locals?.authEnabled && locals.user?.role !== "admin"))
    error(403);
}

export const actions: Actions = {
  startAnalysis: ({ params, locals }) => {
    requireAnalysisAccess(locals);
    if (!isSourceAuthAvailable()) {
      return fail(400, {
        analysisError: "Repository analysis requires server-managed source credentials",
      });
    }
    try {
      return getDb().transaction(() => {
        const detail = startRepositoryAnalysis(params.id);
        if (detail.created) {
          recordOperatorAuditEvent(locals, {
            action: "profile.analysis.started",
            resourceType: "analysis",
            resourceId: detail.run.id,
            metadata: { profileRunId: params.id },
          });
        }
        return {
          analysisSuccess: `Queued ${detail.run.selectedRepoCount} repositories for analysis`,
        };
      })();
    } catch (cause) {
      return actionFailure(cause);
    }
  },
  cancelAnalysis: async ({ params, request, locals }) => {
    requireAnalysisAccess(locals);
    const analysisRunId = (await request.formData()).get("analysisRunId")?.toString();
    if (!analysisRunId) return fail(400, { analysisError: "Analysis run ID is required" });
    try {
      return getDb().transaction(() => {
        cancelRepositoryAnalysis(params.id, analysisRunId);
        recordOperatorAuditEvent(locals, {
          action: "profile.analysis.cancelled",
          resourceType: "analysis",
          resourceId: analysisRunId,
          metadata: { profileRunId: params.id },
        });
        return { analysisSuccess: "Repository analysis cancelled" };
      })();
    } catch (cause) {
      return actionFailure(cause);
    }
  },
  retryAnalysisJob: async ({ params, request, locals }) => {
    requireAnalysisAccess(locals);
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
      return getDb().transaction(() => {
        retryRepositoryAnalysisJob({ profileRunId: params.id, analysisRunId, jobId });
        recordOperatorAuditEvent(locals, {
          action: "profile.analysis.job.retried",
          resourceType: "analysis",
          resourceId: analysisRunId,
          metadata: { profileRunId: params.id, jobId },
        });
        return { analysisSuccess: "Repository queued for analysis" };
      })();
    } catch (cause) {
      return actionFailure(cause);
    }
  },
};
