import { expect, test } from "bun:test";
import { enterpriseNamespaces } from "./namespace-discovery";

test("enterprise discovery follows later pages and deduplicates eligible namespaces", async () => {
  const previous = process.env.PROFILE_CONNECTION_SCOPE;
  process.env.PROFILE_CONNECTION_SCOPE = "bitbucket-server";
  try {
    const cursors: number[] = [];
    const keys = await enterpriseNamespaces(
      "bitbucket-server",
      new AbortController().signal,
      "",
      async (_, cursor) => {
        cursors.push(cursor);
        return {
          host: "bitbucket.example",
          observedAt: "now",
          entries: (cursor ? ["AA", "BB"] : ["AA"]).map((key) => ({ key, name: key })),
          next: cursor ? null : 17,
        };
      },
    );
    expect(keys).toEqual(["AA", "BB"]);
    expect(cursors).toEqual([0, 17]);
  } finally {
    if (previous === undefined) delete process.env.PROFILE_CONNECTION_SCOPE;
    else process.env.PROFILE_CONNECTION_SCOPE = previous;
  }
});
