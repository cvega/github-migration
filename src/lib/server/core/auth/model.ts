export type { AuthUser, UserRole } from "$lib/auth-user";

import type { AuthUser } from "$lib/auth-user";

export interface AuthPrincipal {
  user: AuthUser;
  sessionTokenHash: string;
}

export interface StoredUser extends AuthUser {
  passwordHash: string;
}
