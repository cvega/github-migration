import type { AuthUser } from "$lib/auth-user";

declare global {
  namespace App {
    interface Error {
      message: string;
      code?: string;
    }

    interface Locals {
      authEnabled: boolean;
      user?: AuthUser;
      sessionTokenHash?: string;
    }
  }
}
