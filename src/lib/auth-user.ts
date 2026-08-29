export type UserRole = "admin" | "operator";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
  isActive: boolean;
  mustChangePassword: boolean;
}
