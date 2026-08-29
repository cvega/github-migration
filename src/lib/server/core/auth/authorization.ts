import { error } from "@sveltejs/kit";
import type { AuthUser } from "./model";

export function requireUser(locals: App.Locals): AuthUser {
  if (!locals.user) error(401, "Authentication required");
  return locals.user;
}

export function requireAdmin(locals: App.Locals): AuthUser {
  const user = requireUser(locals);
  if (user.role !== "admin") error(403, "You don't have permission to view this page.");
  return user;
}
