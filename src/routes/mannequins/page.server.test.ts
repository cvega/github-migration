import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import {
  discoverIdentityMapping,
  listIdentityMappings,
  saveIdentityMappings,
} from "$lib/server/migrate/database/identity-mappings";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { actions, load } from "./+page.server";

const keys = [
  "GH_TARGET_PAT",
  "GH_TARGET_ORG",
  "GH_TARGET_APP_ID",
  "GH_TARGET_APP_PRIVATE_KEY",
  "GH_TARGET_APP_INSTALLATION_ID",
  "GHES_TARGET_ID",
  "GHES_TARGET_API_URL",
  "GHES_TARGET_ORG",
  "GHES_TARGET_ADMIN_PAT",
] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));

beforeEach(() => {
  initStore(":memory:", [migrateStore]);
  for (const key of keys) delete process.env[key];
  process.env.GH_TARGET_ORG = "cloud-org";
  process.env.GH_TARGET_PAT = "cloud-token";
  process.env.GHES_TARGET_API_URL = "https://ghes.example.com";
  process.env.GHES_TARGET_ORG = "server-org";
  process.env.GHES_TARGET_ADMIN_PAT = "server-token";
});

afterEach(() => {
  closeStore();
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("mannequin target selection", () => {
  test("loads each target using only its own host and credential", async () => {
    saveIdentityMappings("https://ghes.example.com/api/v3", "server-org", "mannequin-login", [
      { sourceIdentity: "alice", targetLogin: "octocat" },
    ]);
    saveIdentityMappings("https://api.github.com", "cloud-org", "mannequin-login", [
      { sourceIdentity: "alice", targetLogin: "octocat" },
    ]);
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fakeFetch: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(input, init);
        calls.push({ url: request.url, authorization: request.headers.get("authorization") });
        const body = request.url.endsWith("/graphql")
          ? {
              data: {
                organization: {
                  id: "ORG",
                  login: request.url.startsWith("https://api.github.com")
                    ? "cloud-org"
                    : "server-org",
                  mannequins: {
                    totalCount: 0,
                    pageInfo: { endCursor: null, hasNextPage: false },
                    nodes: [],
                  },
                },
              },
            }
          : request.url.includes("/memberships/")
            ? { state: "active" }
            : { login: "octocat" };
        return Response.json(body);
      },
      { preconnect: fetch.preconnect },
    );
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);

    try {
      const ghes = await load({ url: new URL("http://localhost/mannequins?target=ghes") } as never);
      expect(ghes).toMatchObject({
        target: { id: "ghes", platform: "ghes" },
        organization: "server-org",
        error: null,
      });
      const check = actions.checkMappings;
      if (!check) throw new Error("Missing check action");
      const form = (target: string, organization: string) => {
        const data = new FormData();
        data.set("target", target);
        data.set("organization", organization);
        return new Request("http://localhost/mannequins?/checkMappings", {
          method: "POST",
          body: data,
        });
      };
      expect(await check({ request: form("ghes", "server-org") } as never)).toMatchObject({
        checked: [{ user: "ready", match: "missing" }],
      });
      expect(calls).toHaveLength(3);
      expect(calls.every((call) => call.url.startsWith("https://ghes.example.com/api/"))).toBe(
        true,
      );
      expect(calls.every((call) => call.authorization === "token server-token")).toBe(true);

      calls.length = 0;
      const ghec = await load({ url: new URL("http://localhost/mannequins?target=ghec") } as never);
      expect(ghec).toMatchObject({
        target: { id: "ghec", platform: "ghec" },
        organization: "cloud-org",
        error: null,
      });
      expect(await check({ request: form("ghec", "cloud-org") } as never)).toMatchObject({
        checked: [{ user: "ready", match: "missing" }],
      });
      expect(calls).toHaveLength(3);
      expect(calls.every((call) => call.url.startsWith("https://api.github.com/"))).toBe(true);
      expect(calls.every((call) => call.authorization === "token cloud-token")).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("saves a discovered GHES identity mapping after verifying the target user", async () => {
    discoverIdentityMapping(
      "https://ghes.example.com/api/v3",
      "server-org",
      "ghe-migrator:bitbucket-server",
      "http://bitbucket:7990/users/admin",
    );
    const fakeFetch: typeof fetch = Object.assign(async () => Response.json({ login: "octocat" }), {
      preconnect: fetch.preconnect,
    });
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
    try {
      const data = new FormData();
      data.set("target", "ghes");
      data.set("organization", "server-org");
      data.set("sourceKind", "ghe-migrator:bitbucket-server");
      data.set("sourceIdentity", "http://bitbucket:7990/users/admin");
      data.set("targetLogin", "octocat");
      const approve = actions.approve;
      if (!approve) throw new Error("Missing GHES mapping action");
      const result = await approve({
        request: new Request("http://localhost/mannequins?/approve", {
          method: "POST",
          body: data,
        }),
      } as never);
      expect(result).toMatchObject({ success: expect.stringContaining("Mapped to @octocat") });
      expect(listIdentityMappings("https://ghes.example.com/api/v3", "server-org")).toMatchObject([
        { targetLogin: "octocat", status: "approved" },
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("rejects unknown targets and organizations from another target", async () => {
    await expect(
      load({ url: new URL("http://localhost/mannequins?target=unknown") } as never),
    ).rejects.toMatchObject({ status: 400 });
    const data = new FormData();
    data.set("target", "ghes");
    data.set("organization", "cloud-org");
    data.set("mannequinId", "M1");
    data.set("targetLogin", "octocat");
    const invite = actions.invite;
    if (!invite) throw new Error("Missing mannequin invitation action");
    const result = await invite({
      request: new Request("http://localhost/mannequins?/invite", { method: "POST", body: data }),
    } as never);
    expect(result).toMatchObject({ status: 400 });
  });

  test("does not send a GHES token to GitHub.com and defaults to GHES", async () => {
    process.env.GH_TARGET_PAT = "server-token";
    process.env.GHES_TARGET_ORG = "";
    const fetchMock = spyOn(globalThis, "fetch");
    try {
      const cloud = await load({
        url: new URL("http://localhost/mannequins?target=ghec"),
      } as never);
      expect(cloud).toMatchObject({
        target: { id: "ghec" },
        error: expect.stringContaining("matches the GHES administrator token"),
      });
      const defaultTarget = await load({ url: new URL("http://localhost/mannequins") } as never);
      expect(defaultTarget).toMatchObject({ target: { id: "ghes" } });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("submits a GHES invitation only to the selected GHES host", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fakeFetch: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(input, init);
        calls.push({ url: request.url, authorization: request.headers.get("authorization") });
        if (request.url.endsWith("/graphql")) {
          return Response.json({
            data: {
              createAttributionInvitation: {
                source: { id: "M1", login: "source-user" },
                target: { id: "U1", login: "octocat" },
              },
            },
          });
        }
        if (request.url.includes("/members/")) return new Response(null, { status: 204 });
        if (request.url.includes("/users/")) {
          return Response.json({ login: "octocat", node_id: "U1" });
        }
        return Response.json({ node_id: "ORG" });
      },
      { preconnect: fetch.preconnect },
    );
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
    try {
      const data = new FormData();
      data.set("target", "ghes");
      data.set("organization", "server-org");
      data.set("mannequinId", "M1");
      data.set("targetLogin", "octocat");
      const invite = actions.invite;
      if (!invite) throw new Error("Missing mannequin invitation action");
      const result = await invite({
        request: new Request("http://localhost/mannequins?/invite", { method: "POST", body: data }),
      } as never);
      expect(result).toMatchObject({ success: "Invitation sent to @octocat." });
      expect(calls).toHaveLength(4);
      expect(calls.every((call) => call.url.startsWith("https://ghes.example.com/api/"))).toBe(
        true,
      );
      expect(calls.every((call) => call.authorization === "token server-token")).toBe(true);
      expect(listIdentityMappings("https://ghes.example.com/api/v3", "server-org")).toMatchObject([
        { sourceIdentity: "M1", targetLogin: "octocat", status: "invitation_sent" },
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test.each([
    [403, "approved"],
    [400, "invitation_pending"],
  ] as const)("records invitation failure %s as %s", async (status, expectedStatus) => {
    const fakeFetch: typeof fetch = Object.assign(
      async () => Response.json({ message: "Request failed" }, { status }),
      { preconnect: fetch.preconnect },
    );
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
    try {
      const data = new FormData();
      data.set("target", "ghes");
      data.set("organization", "server-org");
      data.set("mannequinId", "M1");
      data.set("targetLogin", "octocat");
      const invite = actions.invite;
      if (!invite) throw new Error("Missing mannequin invitation action");
      const result = await invite({
        request: new Request("http://localhost/mannequins?/invite", { method: "POST", body: data }),
      } as never);
      expect(result).toMatchObject({ status: 502 });
      expect(listIdentityMappings("https://ghes.example.com/api/v3", "server-org")).toMatchObject([
        { sourceIdentity: "M1", targetLogin: "octocat", status: expectedStatus },
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("imports mappings before target accounts exist and rejects conflicting CSV atomically", async () => {
    const save = actions.saveMappings;
    if (!save) throw new Error("Missing save action");
    const upload = (csv: string) => {
      const data = new FormData();
      data.set("target", "ghes");
      data.set("organization", "server-org");
      data.set("sourceKind", "ghe-migrator:bitbucket-server");
      data.set("csv", new File([csv], "users.csv", { type: "text/csv" }));
      return new Request("http://localhost/mannequins?/saveMappings", {
        method: "POST",
        body: data,
      });
    };
    const csv = "source_identity,target_username\nhttp://source/users/a,alice\n";
    expect(await save({ request: upload(csv) } as never)).toMatchObject({
      success: expect.stringContaining("Saved 1"),
    });
    const conflicting =
      "source_identity,target_username\nhttp://source/users/b,bob\nhttp://source/users/a,other\n";
    expect(await save({ request: upload(conflicting) } as never)).toMatchObject({ status: 400 });
    expect(listIdentityMappings("https://ghes.example.com/api/v3", "server-org")).toMatchObject([
      { sourceIdentity: "http://source/users/a", targetLogin: "alice" },
    ]);
  });

  test("sends only unique, ready mannequin matches and tracks accepted claimants", async () => {
    saveIdentityMappings("https://api.github.com", "cloud-org", "mannequin-login", [
      { sourceIdentity: "alice", targetLogin: "target-a" },
      { sourceIdentity: "bob", targetLogin: "target-b" },
      { sourceIdentity: "dupe", targetLogin: "target-c" },
      { sourceIdentity: "waiting", targetLogin: "target-d" },
    ]);
    let mutations = 0;
    const fakeFetch: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/graphql")) {
          const body = (await request.json()) as {
            query: string;
            variables?: { after?: string | null };
          };
          if (body.query.includes("CreateAttributionInvitation")) {
            mutations++;
            return Response.json({
              data: {
                createAttributionInvitation: {
                  source: { id: "M1", login: "alice" },
                  target: { id: "U1", login: "target-a" },
                },
              },
            });
          }
          const node = (id: string, login: string, claimant: object | null = null) => ({
            id,
            login,
            claimant,
            email: null,
            createdAt: "",
          });
          return Response.json({
            data: {
              organization: {
                id: "ORG",
                login: "cloud-org",
                mannequins: body.variables?.after
                  ? {
                      totalCount: 5,
                      pageInfo: { endCursor: null, hasNextPage: false },
                      nodes: [node("M4", "dupe"), node("M5", "waiting")],
                    }
                  : {
                      totalCount: 5,
                      pageInfo: { endCursor: "next", hasNextPage: true },
                      nodes: [
                        node("M1", "alice"),
                        node("M2", "bob", { id: "U2", login: "target-b", avatarUrl: "" }),
                        node("M3", "dupe"),
                      ],
                    },
              },
            },
          });
        }
        if (request.url.includes("/memberships/")) {
          return Response.json({ state: request.url.endsWith("target-d") ? "pending" : "active" });
        }
        if (request.url.includes("/members/")) return new Response(null, { status: 204 });
        if (request.url.includes("/users/"))
          return Response.json({ login: "target-a", node_id: "U1" });
        return Response.json({ node_id: "ORG" });
      },
      { preconnect: fetch.preconnect },
    );
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
    try {
      const data = new FormData();
      data.set("target", "ghec");
      data.set("organization", "cloud-org");
      const apply = actions.applyMappings;
      if (!apply) throw new Error("Missing apply action");
      const result = await apply({
        request: new Request("http://localhost/mannequins?/applyMappings", {
          method: "POST",
          body: data,
        }),
      } as never);
      expect(result).toMatchObject({
        outcomes: [
          { sourceIdentity: "alice", outcome: "invitation sent" },
          { sourceIdentity: "bob", outcome: "accepted" },
          { sourceIdentity: "dupe", outcome: "ambiguous" },
          { sourceIdentity: "waiting", outcome: "pending" },
        ],
      });
      expect(mutations).toBe(1);
      expect(listIdentityMappings("https://api.github.com", "cloud-org")).toContainEqual(
        expect.objectContaining({
          sourceKind: "mannequin",
          sourceIdentity: "M1",
          status: "invitation_sent",
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});
