import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initStore } from "$lib/server/core/db";
import { runGitLabInventoryProfile } from "$lib/server/profile/inventory-runner";
import { startGitLabProfile } from "$lib/server/profile/service";
import { DOMAIN_STORES } from "$lib/server/schemas";
import { GitLabClient } from "$lib/server/source/gitlab/client";
import type { SourceNamespaceInventory } from "$lib/source/types";
import { __setProfileRouteDependenciesForTests, POST } from "./+server";
import { GET as getProfile } from "./[id]/+server";
import {
  __setProfileEventDependenciesForTests,
  GET as getProfileEvents,
} from "./[id]/events/+server";

let restoreRoute = () => {};
let restoreEvents = () => {};

beforeEach(() => {
  initStore(":memory:", [...DOMAIN_STORES]);
});

afterEach(() => {
  restoreRoute();
  restoreRoute = () => {};
  restoreEvents();
  restoreEvents = () => {};
});

function request(body: unknown): Request {
  return new Request("http://localhost/api/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("profile route integration", () => {
  test("streams progress, persists terminal state, and replays terminal state", async () => {
    const releaseDiscovery = Promise.withResolvers<void>();
    const inventory: SourceNamespaceInventory = {
      version: 1,
      provider: "gitlab",
      sourceApiUrl: "https://gitlab.example.com/api/v4",
      namespace: "platform/services",
      projectCount: { kind: "exact", value: 0 },
      projects: [],
    };
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      token: "test-token",
    });
    restoreRoute = __setProfileRouteDependenciesForTests({
      startGitLabProfile: (namespace) =>
        startGitLabProfile(namespace, {
          buildSourceClient: () => client,
          newId: () => "composed-profile-run",
          run: (sourceClient, input, onProgress) =>
            runGitLabInventoryProfile(sourceClient, input, onProgress, {
              discover: async (_client, requestedNamespace, options) => {
                await releaseDiscovery.promise;
                options?.onProgress?.({
                  provider: "gitlab",
                  namespace: requestedNamespace,
                  discovered: 0,
                  page: 1,
                });
                return inventory;
              },
            }),
        }),
    });
    restoreEvents = __setProfileEventDependenciesForTests({ terminalPollMs: 1 });

    const postResponse = await POST({
      request: request({ sourceProvider: "gitlab", org: "platform/services" }),
    } as Parameters<typeof POST>[0]);
    const started = (await postResponse.json()) as { id: string; state: string };
    expect(postResponse.status).toBe(201);
    expect(started).toMatchObject({ id: "composed-profile-run", state: "running" });

    const liveResponse = await getProfileEvents({
      params: { id: started.id },
    } as Parameters<typeof getProfileEvents>[0]);
    releaseDiscovery.resolve();
    const liveFrames = await liveResponse.text();

    expect(liveFrames).toContain('"type":"inventory-progress"');
    expect(liveFrames).toContain('"type":"done","state":"completed"');

    const detailResponse = await getProfile({
      params: { id: started.id },
      url: new URL(`https://example.test/api/profile/${started.id}`),
    } as Parameters<typeof getProfile>[0]);
    const detail = await detailResponse.json();
    expect(detailResponse.status).toBe(200);
    expect(detail.run.state).toBe("completed");
    expect(detail.inventorySummary.projectCount).toEqual({ kind: "exact", value: 0 });

    const reconnectResponse = await getProfileEvents({
      params: { id: started.id },
    } as Parameters<typeof getProfileEvents>[0]);
    expect(await reconnectResponse.text()).toBe('data: {"type":"done","state":"completed"}\n\n');
  });
});
