import { error, fail } from "@sveltejs/kit";
import { recordAuditEvent } from "$lib/server/core/auth/audit";
import { requireAdmin } from "$lib/server/core/auth/authorization";
import { revokeUserSessions } from "$lib/server/core/auth/sessions";
import {
  findUserById,
  resetUserPassword,
  setUserActive,
  setUserRole,
} from "$lib/server/core/auth/users";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, params }) => {
  const currentUser = requireAdmin(locals);
  const user = findUserById(params.id);
  if (!user) error(404, "User not found");
  return { currentUser, user };
};

function failure(cause: unknown) {
  return fail(400, { error: cause instanceof Error ? cause.message : "User update failed." });
}

export const actions: Actions = {
  role: async ({ getClientAddress, locals, params, request }) => {
    const actor = requireAdmin(locals);
    const role = (await request.formData()).get("role")?.toString();
    if (role !== "admin" && role !== "operator") return fail(400, { error: "Invalid role." });
    try {
      setUserRole(actor.id, params.id, role);
      recordAuditEvent({
        actorUserId: actor.id,
        action: "auth.user.role_changed",
        targetUserId: params.id,
        ipAddress: getClientAddress(),
        metadata: { role },
      });
      return { success: "Role updated. The user has been signed out." };
    } catch (cause) {
      return failure(cause);
    }
  },
  status: async ({ getClientAddress, locals, params, request }) => {
    const actor = requireAdmin(locals);
    const isActive = (await request.formData()).get("isActive") === "true";
    try {
      setUserActive(actor.id, params.id, isActive);
      recordAuditEvent({
        actorUserId: actor.id,
        action: isActive ? "auth.user.enabled" : "auth.user.disabled",
        targetUserId: params.id,
        ipAddress: getClientAddress(),
      });
      return { success: isActive ? "User enabled." : "User disabled and signed out." };
    } catch (cause) {
      return failure(cause);
    }
  },
  reset: async ({ getClientAddress, locals, params }) => {
    const actor = requireAdmin(locals);
    try {
      if (actor.id === params.id)
        throw new Error("Use Change password to update your own password.");
      const temporaryPassword = await resetUserPassword(params.id);
      recordAuditEvent({
        actorUserId: actor.id,
        action: "auth.password.reset",
        targetUserId: params.id,
        ipAddress: getClientAddress(),
      });
      return { success: "Password reset. The user has been signed out.", temporaryPassword };
    } catch (cause) {
      return failure(cause);
    }
  },
  revoke: async ({ getClientAddress, locals, params }) => {
    const actor = requireAdmin(locals);
    try {
      if (actor.id === params.id) throw new Error("Use Sign out to end your own session.");
      if (!findUserById(params.id)) throw new Error("User not found.");
      revokeUserSessions(params.id);
      recordAuditEvent({
        actorUserId: actor.id,
        action: "auth.sessions.revoked",
        targetUserId: params.id,
        ipAddress: getClientAddress(),
      });
      return { success: "Sessions revoked." };
    } catch (cause) {
      return failure(cause);
    }
  },
};
