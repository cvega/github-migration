import { fail, redirect } from "@sveltejs/kit";
import { recordAuditEvent } from "$lib/server/core/auth/audit";
import { requireUser } from "$lib/server/core/auth/authorization";
import { SESSION_COOKIE, SESSION_MAX_AGE } from "$lib/server/core/auth/sessions";
import { changeOwnPassword } from "$lib/server/core/auth/users";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => ({ user: requireUser(locals) });

export const actions: Actions = {
  default: async ({ cookies, getClientAddress, locals, request, url }) => {
    const user = requireUser(locals);
    const data = await request.formData();
    const currentPassword = data.get("currentPassword")?.toString() ?? "";
    const newPassword = data.get("newPassword")?.toString() ?? "";
    const confirmation = data.get("confirmation")?.toString() ?? "";
    if (newPassword !== confirmation) {
      return fail(400, { error: "New passwords do not match." });
    }

    let token: string | null;
    try {
      token = await changeOwnPassword(user.id, currentPassword, newPassword);
      if (!token) {
        return fail(400, { error: "Current password is incorrect." });
      }
    } catch (error) {
      return fail(400, {
        error: error instanceof Error ? error.message : "Password change failed.",
      });
    }

    cookies.set(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE,
    });
    recordAuditEvent({
      actorUserId: user.id,
      action: "auth.password.changed",
      targetUserId: user.id,
      ipAddress: getClientAddress(),
    });
    redirect(303, "/");
  },
};
