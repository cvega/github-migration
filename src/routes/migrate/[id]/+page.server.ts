import { error } from "@sveltejs/kit";
import { effectiveCleanupMode, loadCleanupConfig } from "$lib/server/cleanup";
import { events, get } from "$lib/server/manager";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const migration = get(params.id);
  if (!migration) throw error(404, "Migration not found");

  const migrationEvents = events(params.id);

  // Cheap, no-network pre-check for whether to surface the cleanup UI. The
  // authoritative decision (incl. live identity) happens server-side in the
  // cleanup endpoint; this only decides whether to show the button at all.
  const cleanupMode = effectiveCleanupMode(loadCleanupConfig());
  const cleanupCandidate =
    (migration.state === "failed" || migration.state === "cancelled") &&
    migration.targetPreexisted === false &&
    migration.targetRepoNodeId != null;

  return {
    migration,
    events: migrationEvents,
    cleanup: { mode: cleanupMode, candidate: cleanupCandidate },
  };
};
