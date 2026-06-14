/** Profile workspace landing — start a run and list existing runs. */
import { getFormDefaults, isSourceAuthAvailable } from "$lib/server/core/auth";
import { listProfileRuns } from "$lib/server/profile/store";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  return {
    runs: listProfileRuns(),
    sourceAuthAvailable: isSourceAuthAvailable(),
    sourceOrgs: getFormDefaults().sourceOrgs,
  };
};
