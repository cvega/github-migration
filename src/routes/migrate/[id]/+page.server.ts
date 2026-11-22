import { error, fail } from "@sveltejs/kit";
import type { Counts } from "$lib/migrate/types";
import { events, get } from "$lib/server/migrate/manager";
import { fetchMigrationTargetCounts } from "$lib/server/migrate/target-counts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const migration = get(params.id);
  if (!migration) throw error(404, "Migration not found");

  const migrationEvents = events(params.id);

  return {
    migration,
    events: migrationEvents,
    eventCursor: migrationEvents.at(-1)?.id ?? 0,
  };
};

export const actions: Actions = {
  refreshCounts: async ({ params }) => {
    const migration = get(params.id);
    if (!migration) return fail(404, { countsError: "Migration not found." });
    if (migration.state !== "succeeded") {
      return fail(409, { countsError: "Counts can only be fetched for a successful migration." });
    }
    if (migration.targetCounts) return { countsCollected: true };

    let counts: Counts;
    try {
      counts = await fetchMigrationTargetCounts(migration);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`Could not fetch target resource counts for migration ${params.id}: ${reason}`);
      return fail(502, { countsError: `Could not fetch target resource counts: ${reason}` });
    }
    if (get(migration.id)?.state !== "succeeded") {
      return fail(409, { countsError: "The migration changed. Reload to see its latest counts." });
    }
    return { currentTarget: { id: migration.id, observedAt: new Date().toISOString(), counts } };
  },
};
