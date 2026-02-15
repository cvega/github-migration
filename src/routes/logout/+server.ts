/** POST /logout — clear session cookie and redirect to login. */
import { redirect } from "@sveltejs/kit";
import { SESSION_COOKIE } from "$lib/server/session";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ cookies }) => {
  cookies.delete(SESSION_COOKIE, { path: "/" });
  redirect(302, "/login");
};
