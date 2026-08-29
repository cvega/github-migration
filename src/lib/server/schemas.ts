import { authStore } from "./core/auth/schema";
import type { DomainStore } from "./core/db";
import { migrateStore } from "./migrate/database/schema";
import { profileStore } from "./profile/database/schema";

/** Every domain's persistence, applied in dependency-safe startup order. */
export const DOMAIN_STORES: readonly DomainStore[] = [authStore, migrateStore, profileStore];
