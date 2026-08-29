import { listAuditEvents } from "$lib/server/core/auth/audit";
import { requireAdmin } from "$lib/server/core/auth/authorization";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  requireAdmin(locals);
  return { events: listAuditEvents(200) };
};
