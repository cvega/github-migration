import { fail } from "@sveltejs/kit";
import { recordAuditEvent } from "$lib/server/core/auth/audit";
import { requireAdmin } from "$lib/server/core/auth/authorization";
import type { UserRole } from "$lib/server/core/auth/model";
import { createUser, listUsers } from "$lib/server/core/auth/users";
import type { Actions, PageServerLoad } from "./$types";

const USERS_PER_PAGE = 10;

export const load: PageServerLoad = ({ locals, url }) => {
  requireAdmin(locals);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const role = url.searchParams.get("role") ?? "all";
  const status = url.searchParams.get("status") ?? "all";
  const requestedPage = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const normalizedQuery = query.toLowerCase();
  const filteredUsers = listUsers().filter(
    (user) =>
      (role === "all" || user.role === role) &&
      (status === "all" || (status === "active") === user.isActive) &&
      (!normalizedQuery ||
        user.username.toLowerCase().includes(normalizedQuery) ||
        user.displayName?.toLowerCase().includes(normalizedQuery)),
  );
  const total = filteredUsers.length;
  const totalPages = Math.max(1, Math.ceil(total / USERS_PER_PAGE));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * USERS_PER_PAGE;
  return {
    users: filteredUsers.slice(offset, offset + USERS_PER_PAGE),
    filters: { query, role, status },
    pagination: { page, totalPages, total, limit: USERS_PER_PAGE },
  };
};

export const actions: Actions = {
  create: async ({ getClientAddress, locals, request }) => {
    const actor = requireAdmin(locals);
    const data = await request.formData();
    const username = data.get("username")?.toString() ?? "";
    const displayName = data.get("displayName")?.toString() ?? "";
    const roleValue = data.get("role")?.toString();
    const role: UserRole = roleValue === "admin" ? "admin" : "operator";
    try {
      const created = await createUser({ username, displayName, role });
      recordAuditEvent({
        actorUserId: actor.id,
        action: "auth.user.created",
        targetUserId: created.user.id,
        ipAddress: getClientAddress(),
        metadata: { role },
      });
      return {
        success: true,
        createdUsername: created.user.username,
        temporaryPassword: created.temporaryPassword,
      };
    } catch (error) {
      const message =
        error instanceof Error && error.message.includes("UNIQUE")
          ? "That username is already in use."
          : error instanceof Error
            ? error.message
            : "User creation failed.";
      return fail(400, { username, displayName, role, error: message });
    }
  },
};
