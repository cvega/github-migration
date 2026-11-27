import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { listAuditEvents } from "$lib/server/core/auth/audit";
import { authStore } from "$lib/server/core/auth/schema";
import {
  createSession,
  hashSessionToken,
  resolveSession,
  revokeSession,
  SESSION_COOKIE,
} from "$lib/server/core/auth/sessions";
import { createUser, findStoredUserById } from "$lib/server/core/auth/users";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { actions, load } from "./+page.server";

beforeEach(() => initStore(":memory:", [authStore]));
afterEach(closeStore);

test.each([false, true])(
  "password change requires the initiating session at commit (revoked: %s)",
  async (revoked) => {
    const currentPassword = "fixture current password";
    const newPassword = "fixture replacement password";
    const { user } = await createUser({
      username: "fixture-operator",
      role: "operator",
      password: currentPassword,
      mustChangePassword: true,
    });
    const previousSession = createSession(user.id);
    const locals = { authEnabled: true, user, sessionTokenHash: hashSessionToken(previousSession) };
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

    if (revoked) {
      const previousHash = findStoredUserById(user.id)?.passwordHash;
      const hash = spyOn(Bun.password, "hash").mockImplementation(async () => {
        revokeSession(previousSession);
        return "proposed-hash-fixture";
      });
      try {
        expect(await changePassword(event)).toMatchObject({ status: 400 });
        expect(findStoredUserById(user.id)?.passwordHash).toBe(previousHash);
        expect(getDb().query("SELECT count(*) AS count FROM app_sessions").get()).toEqual({
          count: 1,
        });
        expect(setCookie).not.toHaveBeenCalled();
        expect(listAuditEvents()).toEqual([]);
      } finally {
        hash.mockRestore();
      }
      return;
    }

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
  },
);
