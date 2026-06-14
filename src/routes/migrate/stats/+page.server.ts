import { stats } from "$lib/server/manager";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  return { stats: stats() };
};
