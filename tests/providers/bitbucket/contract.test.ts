import { expect, test } from "bun:test";
import { BitbucketServerClient } from "$lib/server/source/bitbucket/client";
import { discoverBitbucketInventory } from "$lib/server/source/bitbucket/inventory";

test("honors the Bitbucket Server inventory wire contract", async () => {
	const requests: Array<{ url: URL; init?: RequestInit }> = [];
	const responses = [
		new Response(JSON.stringify({ version: "10.4.1" }), {
			headers: { "Content-Type": "application/json" },
		}),
		new Response(
			JSON.stringify({
				values: [
					{
						id: 7,
						slug: "payments-api",
						name: "Payments API",
						public: false,
						archived: false,
						defaultBranch: { displayId: "main" },
						updatedDate: 1_786_147_200_000,
						size: 4096,
					},
				],
				isLastPage: true,
			}),
			{ headers: { "Content-Type": "application/json" } },
		),
	];
	const client = new BitbucketServerClient({
		baseUrl: "https://bitbucket.example.com",
		username: "operator",
		password: "contract-password",
		maxRetries: 0,
		fetch: async (input, init) => {
			requests.push({ url: new URL(input.toString()), init });
			const response = responses.shift();
			if (!response) throw new Error("Unexpected Bitbucket API request");
			return response;
		},
	});

	const inventory = await discoverBitbucketInventory(client, "PLATFORM");

	expect(requests.map(({ url }) => url.pathname)).toEqual([
		"/rest/api/1.0/application-properties",
		"/rest/api/1.0/projects/PLATFORM/repos",
	]);
	expect(Object.fromEntries(requests[1]?.url.searchParams ?? [])).toMatchObject({
		limit: "100",
		start: "0",
	});
	expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe(
		`Basic ${Buffer.from("operator:contract-password").toString("base64")}`,
	);
	expect(inventory).toMatchObject({
		version: 1,
		provider: "bitbucket-server",
		sourceApiUrl: "https://bitbucket.example.com/rest/api/1.0",
		namespace: "PLATFORM",
		projectCount: { kind: "exact", value: 1 },
		projects: [
			{
				sourceId: "7",
				path: "PLATFORM/payments-api",
				defaultBranch: "main",
				repositorySizeBytes: { kind: "exact", value: 4096 },
			},
		],
	});
});