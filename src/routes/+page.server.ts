/**
 * Root route. The migration workspace now lives under `/migrate`; until the
 * combined workspace landing page is built here, `/` redirects there so the
 * existing entry point keeps working.
 */
import { redirect } from "@sveltejs/kit";

export function load(): never {
  redirect(307, "/migrate");
}
