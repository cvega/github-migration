import { redirect } from "@sveltejs/kit";
import {
  authEnabled,
  createSessionToken,
  isRateLimited,
  recordFailedAttempt,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  validateCredentials,
} from "$lib/server/core/session";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  if (!authEnabled) redirect(302, "/");
  return {};
};

export const actions: Actions = {
  default: async ({ request, cookies, getClientAddress, url }) => {
    const ip = getClientAddress();
    if (isRateLimited(ip)) {
      return { success: false, error: "Too many failed attempts - try again later." };
    }

    const data = await request.formData();
    const username = data.get("username")?.toString() ?? "";
    const password = data.get("password")?.toString() ?? "";
    if (!validateCredentials(username, password)) {
      recordFailedAttempt(ip);
      return { success: false, error: "Invalid username or password." };
    }

    cookies.set(SESSION_COOKIE, createSessionToken(), {
      path: "/",
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE,
    });
    redirect(302, "/");
  },
};
