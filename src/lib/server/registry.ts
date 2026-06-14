/**
 * Composition root — the one place that knows every domain. It assembles each
 * domain's {@link DomainStore} so `core/db` can stay domain-agnostic and the
 * app/tests apply them all with a single list.
 *
 * To add a new `server/<domain>`: export a `DomainStore` from its `schema.ts`
 * and add it here. Nothing in `core` ever imports this file.
 */
import type { DomainStore } from "./core/db";
import { migrateStore } from "./migrate/schema";
import { profileStore } from "./profile/schema";

/** Every domain's persistence, applied to the database at startup and in tests. */
export const DOMAIN_STORES: DomainStore[] = [migrateStore, profileStore];
