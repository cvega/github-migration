import { expect, test } from "bun:test";
import { GitLabClient } from "$lib/server/source/gitlab/client";
import { discoverGitLabInventory } from "$lib/server/source/gitlab/inventory";

test("honors the GitLab inventory wire contract", async () => {
	const requests: Array<{ url: URL; init?: RequestInit }> = [];
	const client = new GitLabClient({
		baseUrl: "https://gitlab.example.com",
		token: "contract-token",
		maxRetries: 0,
		fetch: async (input, init) => {
			requests.push({ url: new URL(input.toString()), init });
			return new Response(
				JSON.stringify([
					{
						id: 42,
						name: "payments-api",
						path_with_namespace: "platform/services/payments-api",
						visibility: "private",
						archived: false,
						default_branch: "main",
						last_activity_at: "2026-08-01T12:00:00Z",
						statistics: { repository_size: 1024, storage_size: 2048 },
					},
				]),
				{
					headers: {
						"Content-Type": "application/json",
						"RateLimit-Limit": "2000",
						"RateLimit-Remaining": "1999",
						"X-Next-Page": "",
						"X-Total": "1",
					},
				},
			);
		},
	});

	const inventory = await discoverGitLabInventory(client, "platform");

	expect(requests).toHaveLength(1);
	expect(requests[0]?.url.pathname).toBe("/api/v4/groups/platform/projects");
	expect(Object.fromEntries(requests[0]?.url.searchParams ?? [])).toMatchObject({
		include_subgroups: "true",
		page: "1",
		per_page: "100",
		statistics: "true",
		with_shared: "false",
	});
	expect(new Headers(requests[0]?.init?.headers).get("PRIVATE-TOKEN")).toBe("contract-token");
	expect(client.getRateLimit()).toMatchObject({ limit: 2000, remaining: 1999 });
	expect(inventory).toMatchObject({
		version: 1,
		provider: "gitlab",
		sourceApiUrl: "https://gitlab.example.com/api/v4",
		namespace: "platform",
		projectCount: { kind: "exact", value: 1 },
		projects: [
			{
				sourceId: "42",
				path: "platform/services/payments-api",
				defaultBranch: "main",
				repositorySizeBytes: { kind: "exact", value: 1024 },
				storageSizeBytes: { kind: "exact", value: 2048 },
			},
		],
	});
});