import { error, fail } from "@sveltejs/kit";
import type { Counts } from "$lib/migrate/types";
import { isPausedPersistedRoute } from "$lib/migration-target";
import { ownJobActions } from "$lib/server/application/self-service/jobs";
import { getVisibleDetail } from "$lib/server/application/self-service/visible-events";
import { requireAdminIfAuthEnabled } from "$lib/server/core/auth/authorization";
import { getGhesImportJobByMigrationId } from "$lib/server/migrate/database/import-jobs";
import {
  ghesQueueBlockers,
  hasUnreconciledGhesImport,
} from "$lib/server/migrate/database/migrations";
import { requiresManualImportReview } from "$lib/server/migrate/ghes/job";
import { events, get } from "$lib/server/migrate/manager";
import {
  fetchMigrationTargetCounts,
  targetCountFailureReason,
} from "$lib/server/migrate/target-counts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  if (locals?.user?.role === "operator") {
    const detail = getVisibleDetail(locals.user.id, params.id);
    if (!detail) error(404, "Migration not found");
    return {
      ...detail,
      waitingForReview: ghesQueueBlockers(detail.migration).length > 0,
      manualReview: requiresManualImportReview(getGhesImportJobByMigrationId(params.id)),
      scoped: true,
      ...ownJobActions(locals.user.id, params.id),
    };
  }
  const migration = get(params.id);
  if (!migration) throw error(404, "Migration not found");

  const migrationEvents = events(params.id);

  return {
    scoped: false,
    manualReview: requiresManualImportReview(getGhesImportJobByMigrationId(params.id)),
    blockers: ghesQueueBlockers(migration),
    canReviewRemote: !isPausedPersistedRoute(migration) || hasUnreconciledGhesImport(params.id),
    canCancel: true,
    canRestart: true,
    migration,
    events: migrationEvents,
    eventCursor: migrationEvents.at(-1)?.id ?? 0,
  };
};

export const actions: Actions = {
  refreshCounts: async ({ params, locals }) => {
    if (locals?.user?.role === "operator") return fail(403, { countsError: "Not permitted." });
    requireAdminIfAuthEnabled(locals);
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
      const reason = targetCountFailureReason(error);
      console.warn(`Could not fetch target resource counts for migration ${params.id}: ${reason}`);
      return fail(502, { countsError: `Could not fetch target resource counts: ${reason}` });
    }
    if (get(migration.id)?.state !== "succeeded") {
      return fail(409, { countsError: "The migration changed. Reload to see its latest counts." });
    }
    return { currentTarget: { id: migration.id, observedAt: new Date().toISOString(), counts } };
  },
};
