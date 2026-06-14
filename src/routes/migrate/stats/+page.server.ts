import { stats } from "$lib/server/migrate/manager";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  return { stats: stats() };
};
