import { fail, redirect } from "@sveltejs/kit";
import { recordAuditEvent } from "$lib/server/core/auth/audit";
import { SESSION_COOKIE, SESSION_MAX_AGE } from "$lib/server/core/auth/sessions";
import { LOGIN_WINDOW_SECONDS, verifyLoginAttempt } from "$lib/server/core/auth/throttle";
import {
  matchesUsernamePolicy,
  signInWithPassword,
  USERNAME_MAX_LENGTH,
} from "$lib/server/core/auth/users";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.authEnabled) redirect(302, "/");
  if (locals.user) {
    redirect(302, locals.user.mustChangePassword ? "/account/password" : "/");
  }
  return {};
};

export const actions = {
  default: async ({ request, cookies, getClientAddress, locals, setHeaders, url }) => {
    if (!locals.authEnabled) redirect(302, "/");
    const ip = getClientAddress();
    const data = await request.formData();
    const usernameField = data.get("username");
    const username = typeof usernameField === "string" ? usernameField.trim() : "";
    if (username.length > USERNAME_MAX_LENGTH) {
      return fail(401, { username: "", error: "Invalid username or password." });
    }
    const displayUsername = matchesUsernamePolicy(username) ? username : "";
    const password = data.get("password")?.toString() ?? "";
    const result = await verifyLoginAttempt(username, ip, () =>
      signInWithPassword(username, password, ip),
    );
    if (result.throttled) {
      if (result.reason === "capacity") {
        setHeaders({ "Retry-After": "1" });
        return fail(503, {
          username: displayUsername,
          error: "Sign-in is busy. Try again in a second.",
        });
      }
      setHeaders({ "Retry-After": String(LOGIN_WINDOW_SECONDS) });
      return fail(429, {
        username: displayUsername,
        error: "Too many sign-in attempts. Try again in 15 minutes.",
      });
    }

    const { user: signIn } = result;
    if (!signIn) {
      recordAuditEvent({ action: "auth.login.failed", ipAddress: ip });
      return fail(401, { username: displayUsername, error: "Invalid username or password." });
    }

    cookies.set(SESSION_COOKIE, signIn.token, {
      path: "/",
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE,
    });
    redirect(302, signIn.mustChangePassword ? "/account/password" : "/");
  },
} satisfies Actions;
