import { redirect } from "@sveltejs/kit";
import { recordAuditEvent } from "$lib/server/core/auth/audit";
import { revokeSession, SESSION_COOKIE } from "$lib/server/core/auth/sessions";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ cookies, getClientAddress, locals }) => {
  const token = cookies.get(SESSION_COOKIE);
  if (token) revokeSession(token);
  if (locals.user) {
    recordAuditEvent({
      actorUserId: locals.user.id,
      action: "auth.logout",
      ipAddress: getClientAddress(),
    });
  }
  cookies.delete(SESSION_COOKIE, { path: "/" });
  redirect(302, "/login");
};
