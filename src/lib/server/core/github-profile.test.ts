import { expect, test } from "bun:test";
import { createProfileClient } from "./github";

test.each(["REST", "GraphQL", "pagination"])(
  "%s deadline aborts an unfinished response body",
  async (kind) => {
    const deadline = new AbortController();
    const reading = Promise.withResolvers<void>();
    let transportSignal: AbortSignal | null | undefined;
    let calls = 0;
    const client = createProfileClient(
      { token: "fixture" },
      "https://api.github.com",
      new AbortController().signal,
      {
        deadline: () => deadline.signal,
        fetch: async (_url, init) => {
          calls++;
          transportSignal = init?.signal;
          if (kind === "pagination" && calls === 1) {
            return Response.json([{}], {
              headers: { link: '<https://api.github.com/orgs/acme/repos?page=2>; rel="next"' },
            });
          }
          return new Response(
            new ReadableStream({
              pull(controller) {
                transportSignal?.addEventListener(
                  "abort",
                  () => controller.error(new Error("body aborted")),
                  { once: true },
                );
                reading.resolve();
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      },
    );
    const pending =
      kind === "GraphQL"
        ? client.graphql("{ viewer { login } }")
        : kind === "REST"
          ? client.orgs.get({ org: "acme" })
          : client.paginate(client.repos.listForOrg, { org: "acme" });
    await reading.promise;
    deadline.abort(new Error("fixture deadline"));
    await expect(pending).rejects.toThrow("fixture deadline");
    expect(transportSignal?.aborted).toBe(true);
    expect(calls).toBe(kind === "pagination" ? 2 : 1);
  },
);
