/** GET    /api/migrate/migrations/[id] — get migration details.
 *  DELETE /api/migrate/migrations/[id] — cancel a running migration.
 */
import { json } from "@sveltejs/kit";
import { cancel, get } from "$lib/server/manager";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) => {
  const migration = get(params.id);
  if (!migration) return json({ error: "Not found" }, { status: 404 });
  return json(migration);
};

export const DELETE: RequestHandler = async ({ params }) => {
  const migration = get(params.id);
  if (!migration) return json({ error: "Not found" }, { status: 404 });

  if (
    migration.state !== "queued" &&
    migration.state !== "pending" &&
    migration.state !== "running"
  ) {
    return json(
      { error: `Cannot cancel migration in state "${migration.state}"` },
      { status: 409 },
    );
  }

  const cancelled = cancel(params.id);
  if (!cancelled) {
    return json(
      { error: "Could not cancel — migration may have already completed" },
      { status: 409 },
    );
  }

  return json({ status: "cancelled" });
};
