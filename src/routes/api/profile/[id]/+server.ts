import { json } from "@sveltejs/kit";
import type { RepoReadinessFilter } from "$lib/server/profile/database/repos";
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
  const result =
    view === "status"
      ? getProfileStatus(params.id)
      : view === "repos"
        ? getProfileRepoPage(params.id, options)
        : getProfileDetail(params.id, options);
  return result ? json(result) : json({ error: "Profile run not found" }, { status: 404 });
};
