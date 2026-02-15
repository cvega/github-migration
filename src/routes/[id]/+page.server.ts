import type { PageServerLoad } from "./$types";
import { get, events } from "$lib/server/manager";
import { error } from "@sveltejs/kit";

export const load: PageServerLoad = async ({ params }) => {
  const migration = get(params.id);
  if (!migration) throw error(404, "Migration not found");

  const migrationEvents = events(params.id);

  return { migration, events: migrationEvents };
};
