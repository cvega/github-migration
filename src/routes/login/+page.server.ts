/** Login page server handler — POST validates creds and sets session cookie. */
import { redirect } from "@sveltejs/kit";
import {
  authEnabled,
  createSessionToken,
  isRateLimited,
  recordFailedAttempt,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  validateCredentials,
} from "$lib/server/session";
import type { Actions, PageServerLoad } from "./$types";

/** If auth isn't enabled, skip the login page entirely. */
export const load: PageServerLoad = async () => {
  if (!authEnabled) {
    redirect(302, "/");
  }
  return {};
};

export const actions: Actions = {
  default: async ({ request, cookies, getClientAddress }) => {
    const ip = getClientAddress();

    if (isRateLimited(ip)) {
      return { success: false, error: "Too many failed attempts — try again later." };
    }

    const data = await request.formData();
    const username = data.get("username")?.toString() ?? "";
    const password = data.get("password")?.toString() ?? "";

    if (!validateCredentials(username, password)) {
      recordFailedAttempt(ip);
      return { success: false, error: "Invalid username or password." };
    }

    const token = createSessionToken();
    cookies.set(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      secure: false, // running behind internal network; set true if HTTPS
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE,
    });

    redirect(302, "/");
  },
};
