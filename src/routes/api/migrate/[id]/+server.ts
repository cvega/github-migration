import { json } from "@sveltejs/kit";
import { cancelOwnJob } from "$lib/server/application/self-service/jobs";
import { getVisibleJob } from "$lib/server/application/self-service/visible-jobs";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import { cancel, get } from "$lib/server/migrate/manager";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params, locals }) => {
  const migration =
    locals?.user?.role === "operator" ? getVisibleJob(locals.user.id, params.id) : get(params.id);
  return migration ? json(migration) : json({ error: "Not found" }, { status: 404 });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
  if (locals?.user?.role === "operator") {
    return cancelOwnJob(locals.user.id, params.id)
      ? json({ status: "cancelled" })
      : json({ error: "Migration is unavailable for cancellation" }, { status: 404 });
  }
  const migration = get(params.id);
  if (!migration) return json({ error: "Not found" }, { status: 404 });
  if (!cancel(params.id)) {
    return json(
      { error: `Cannot cancel migration in state "${migration.state}"` },
      { status: 409 },
    );
  }
  recordOperatorAuditEvent(locals, {
    action: "migration.cancelled",
    resourceType: "migration",
    resourceId: params.id,
  });
  return json({ status: "cancelled" });
};
