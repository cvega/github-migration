import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { listAuditEvents } from "$lib/server/core/auth/audit";
import { authStore } from "$lib/server/core/auth/schema";
import { createSession, resolveSession, SESSION_COOKIE } from "$lib/server/core/auth/sessions";
import { createUser } from "$lib/server/core/auth/users";
import { closeStore, initStore } from "$lib/server/core/db";
import { actions, load } from "./+page.server";

beforeEach(() => initStore(":memory:", [authStore]));
afterEach(closeStore);

test("an operator can use the password page and replace their own session", async () => {
  const currentPassword = "fixture current password";
  const newPassword = "fixture replacement password";
  const { user } = await createUser({
    username: "fixture-operator",
    role: "operator",
    password: currentPassword,
    mustChangePassword: true,
  });
  const previousSession = createSession(user.id);
  const locals = { authEnabled: true, user };
  expect(await load({ locals } as Parameters<typeof load>[0])).toEqual({ user });

  const url = new URL("https://dashboard.invalid/account/password");
  const setCookie = mock((_name: string, _value: string) => {});
  const changePassword = actions.default;
  if (!changePassword) throw new Error("Missing password change action");
  const event = {
    locals,
    url,
    request: new Request(url, {
      method: "POST",
      body: new URLSearchParams({ currentPassword, newPassword, confirmation: newPassword }),
    }),
    cookies: { set: setCookie },
    getClientAddress: () => "192.0.2.1",
  } as unknown as Parameters<typeof changePassword>[0];

  await expect(changePassword(event)).rejects.toMatchObject({ status: 303, location: "/" });
  expect(resolveSession(previousSession)).toBeNull();
  expect(setCookie).toHaveBeenCalledTimes(1);
  const [name, token] = setCookie.mock.calls[0] ?? [];
  expect(name).toBe(SESSION_COOKIE);
  expect(resolveSession(token ?? "")?.user).toMatchObject({
    id: user.id,
    role: "operator",
    mustChangePassword: false,
  });
  expect(listAuditEvents()).toMatchObject([
    {
      action: "auth.password.changed",
      actorUsername: user.username,
      targetUsername: user.username,
    },
  ]);
});
