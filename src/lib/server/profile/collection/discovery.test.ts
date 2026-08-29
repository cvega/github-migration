import { expect, test } from "bun:test";
import { discoverOrgRepos } from "./discovery";

test("discovers paged repositories and reports progress", async () => {
  const pages = [
    { data: [{ name: "a", full_name: "acme/a", private: true, fork: false, size: 0 }] },
    {
      data: [
        { name: "b", full_name: "acme/b", private: false, fork: true, size: 12, has_pages: true },
      ],
    },
  ];
  const progress: number[] = [];
  const result = await discoverOrgRepos(
    {
      paginate: {
        iterator: () => ({
          async *[Symbol.asyncIterator]() {
            yield* pages;
          },
        }),
      },
      repos: { listForOrg: () => {} },
    } as never,
    "acme",
    (value) => progress.push(value.discovered),
  );
  expect(progress).toEqual([1, 2]);
  expect(result.repos).toMatchObject([
    { nameWithOwner: "acme/a", visibility: "PRIVATE", isEmpty: true },
    { nameWithOwner: "acme/b", visibility: "PUBLIC", isFork: true, hasPages: true },
  ]);
});

test("rejects inventories beyond the configured limit", async () => {
  const rest = {
    paginate: {
      iterator: () => ({
        async *[Symbol.asyncIterator]() {
          yield { data: [{ name: "a", full_name: "acme/a", private: false, fork: false }] };
        },
      }),
    },
    repos: { listForOrg: () => {} },
  } as never;
  await expect(discoverOrgRepos(rest, "acme", undefined, 0)).rejects.toThrow(
    "supported limit of 0",
  );
});
