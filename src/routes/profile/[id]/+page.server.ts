import { error } from "@sveltejs/kit";
import type { RepoReadinessFilter } from "$lib/server/profile/database/repos";
import { getProfileDetail } from "$lib/server/profile/service";
import type { PageServerLoad } from "./$types";

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
  });
  if (!detail) error(404, "Profile run not found");
  return detail;
};
