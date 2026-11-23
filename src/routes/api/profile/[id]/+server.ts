import { json } from "@sveltejs/kit";
import {
  getBitbucketActivityPage,
  getBitbucketLfsReportRows,
} from "$lib/server/profile/database/inventories";
import type { RepoReadinessFilter } from "$lib/server/profile/database/repos";
import { getProfileRun } from "$lib/server/profile/database/runs";
import {
  getProfileDetail,
  getProfileRepoPage,
  getProfileStatus,
} from "$lib/server/profile/service";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params, url }) => {
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
        repositories: getBitbucketLfsReportRows(run.id),
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
    return json(getBitbucketActivityPage(params.id, page));
  }
  const result =
    view === "status"
      ? getProfileStatus(params.id)
      : view === "repos"
        ? getProfileRepoPage(params.id, options)
        : getProfileDetail(params.id, options);
  return result ? json(result) : json({ error: "Profile run not found" }, { status: 404 });
};
