import { error } from "@sveltejs/kit";
import { events, get } from "$lib/server/manager";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const migration = get(params.id);
  if (!migration) throw error(404, "Migration not found");

  const migrationEvents = events(params.id);

  return { migration, events: migrationEvents };
};
