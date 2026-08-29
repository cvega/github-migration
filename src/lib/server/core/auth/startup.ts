import type { Database } from "bun:sqlite";
import { recordAuditEvent } from "./audit";
import { createUser } from "./users";

export interface AuthStartupInput {
  username?: string;
  password?: string;
  allowUnauthenticated?: string;
  development?: boolean;
}

export interface AuthStartupResult {
  authEnabled: boolean;
  bootstrappedUser: boolean;
}

export async function initializeAuthentication(
  input: AuthStartupInput,
  database: Database,
): Promise<AuthStartupResult> {
  const username = input.username?.trim();
  const password = input.password?.trim();
  const hasUsername = Boolean(username);
  const hasPassword = Boolean(password);
  const openValue = input.allowUnauthenticated?.trim().toLowerCase();
  if (openValue !== undefined && openValue !== "true" && openValue !== "false") {
    throw new Error("GH_MIGRATE_ALLOW_UNAUTHENTICATED must be either true or false.");
  }
  if (hasUsername !== hasPassword) {
    throw new Error(
      hasUsername
        ? "GH_MIGRATE_PASS is required when GH_MIGRATE_USER is set."
        : "GH_MIGRATE_USER is required when GH_MIGRATE_PASS is set.",
    );
  }

  const { count } = database.prepare("SELECT COUNT(*) AS count FROM app_users").get() as {
    count: number;
  };
  if (count > 0) {
    if (openValue === "true") {
      throw new Error(
        "Authentication configuration is contradictory: stored users and unauthenticated mode are both enabled.",
      );
    }
    return { authEnabled: true, bootstrappedUser: false };
  }

  if (hasUsername && username && password) {
    if (openValue === "true") {
      throw new Error(
        "Authentication configuration is contradictory: bootstrap credentials and unauthenticated mode are both enabled.",
      );
    }
    const { user } = await createUser(
      { username, password, role: "admin", mustChangePassword: false },
      database,
    );
    recordAuditEvent(
      { action: "auth.user.bootstrapped", targetUserId: user.id, metadata: { username } },
      database,
    );
    return { authEnabled: true, bootstrappedUser: true };
  }

  if (openValue === "true" || (input.development && openValue === undefined)) {
    return { authEnabled: false, bootstrappedUser: false };
  }
  throw new Error(
    "Set GH_MIGRATE_USER and GH_MIGRATE_PASS to create the first administrator, or explicitly set GH_MIGRATE_ALLOW_UNAUTHENTICATED=true.",
  );
}
