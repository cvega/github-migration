import { json } from "@sveltejs/kit";
import { cancel, get } from "$lib/server/migrate/manager";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
  const migration = get(params.id);
  return migration ? json(migration) : json({ error: "Not found" }, { status: 404 });
};

export const DELETE: RequestHandler = ({ params }) => {
  const migration = get(params.id);
  if (!migration) return json({ error: "Not found" }, { status: 404 });
  if (!cancel(params.id)) {
    return json(
      { error: `Cannot cancel migration in state "${migration.state}"` },
      { status: 409 },
    );
  }
  return json({ status: "cancelled" });
};
