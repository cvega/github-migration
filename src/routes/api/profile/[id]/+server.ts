import { json } from "@sveltejs/kit";
import { MAX_PROFILE_PLAN_REPOS } from "$lib/profile/migration-plan";
import { parseJsonBody } from "$lib/server/application/request-body";
import { submitOwnBatch } from "$lib/server/application/self-service/jobs";
import {
  getOwnProfileDetail,
  getScopedProfileStatus,
  resolveOwnProfile,
} from "$lib/server/application/self-service/profiles";
import {
  getBitbucketActivityPage,
  getBitbucketLfsReportRows,
} from "$lib/server/profile/database/inventories";
import type { RepoReadinessFilter } from "$lib/server/profile/database/repos";
import { getProfileRun } from "$lib/server/profile/database/runs";
import { profileSelectionError } from "$lib/server/profile/selection";
import {
  getProfileDetail,
  getProfileRepoPage,
  getProfileStatus,
} from "$lib/server/profile/service";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params, url, locals }) => {
  if (locals?.authEnabled && !locals.user)
    return json({ error: "Authentication required" }, { status: 401 });
  const operator = locals?.user?.role === "operator" ? locals.user : null;
  const own = operator && resolveOwnProfile(operator.id, params.id);
  if (operator && !own) return json({ error: "Profile run not found" }, { status: 404 });
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
  const view = url.searchParams.get("view");
  if (view === "lfs") {
    const run = getProfileRun(params.id);
    if (run?.sourceProvider !== "bitbucket-server")
      return json({ error: "Bitbucket profile not found" }, { status: 404 });
    return json(
      {
        profileId: run.id,
        project: run.org,
        scope:
          "Tracking rules in the default branch's root .gitattributes; not LFS object counts or bytes.",
        repositories: getBitbucketLfsReportRows(run.id, own?.run.org),
      },
      {
        headers: {
          "Content-Disposition": `attachment; filename="lfs-tracking-${encodeURIComponent(run.id)}.json"`,
        },
      },
    );
  }
  if (view === "activity") {
    if (getProfileRun(params.id)?.sourceProvider !== "bitbucket-server")
      return json({ error: "Bitbucket profile not found" }, { status: 404 });
    return json(getBitbucketActivityPage(params.id, page, own?.run.org));
  }
  if (own) {
    if (view === "repos")
      return json(getProfileRepoPage(params.id, { ...options, namespace: own.run.org }));
    return json(
      view === "status" ? getScopedProfileStatus(own.run) : getOwnProfileDetail(own.run, options),
    );
  }
  const result =
    view === "status"
      ? getProfileStatus(params.id)
      : view === "repos"
        ? getProfileRepoPage(params.id, options)
        : getProfileDetail(params.id, options);
  return result ? json(result) : json({ error: "Profile run not found" }, { status: 404 });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (locals?.user?.role !== "operator")
    return json({ error: "Operator required" }, { status: 403 });
  const body = await parseJsonBody(request);
  if ("error" in body) return json({ error: body.error }, { status: body.status });
  const own = resolveOwnProfile(locals.user.id, params.id);
  if (!own) return json({ error: "Profile run not found" }, { status: 404 });
  const { repos, grantId } = body.data;
  if (typeof grantId !== "string" || !grantId)
    return json(
      { error: "Choose a destination for this source. Refresh the report if needed." },
      { status: 400 },
    );
  if (
    Object.keys(body.data).some((key) => key !== "repos" && key !== "grantId") ||
    !Array.isArray(repos) ||
    !repos.length ||
    repos.length > MAX_PROFILE_PLAN_REPOS ||
    !repos.every(
      (name) =>
        typeof name === "string" &&
        /^[a-zA-Z0-9._-]{1,100}$/.test(name) &&
        name !== "." &&
        name !== "..",
    )
  ) {
    return json({ error: "Invalid repository selection" }, { status: 400 });
  }
  const grant = own.grants.find((g) => g.id === grantId);
  if (!grant?.canMigrate) return json({ error: "Migration not permitted" }, { status: 403 });
  const selectionError = profileSelectionError(
    own.run,
    repos.map((name) => `${own.run.org}/${name}`),
  );
  if (selectionError) return json({ error: selectionError }, { status: 400 });
  try {
    const batch = submitOwnBatch(locals.user.id, {
      grantId: grant.id,
      repos,
    });
    return json({ id: batch.batchId }, { status: 201 });
  } catch {
    return json(
      { error: "Unable to submit this selection to the assigned destination" },
      { status: 400 },
    );
  }
};
