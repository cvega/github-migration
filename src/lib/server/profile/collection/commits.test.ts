import { expect, test } from "bun:test";
import { countRepoCommits } from "./commits";

test("counts commits from the pagination last link", async () => {
  const rest = {
    request: async () => ({
      data: [{}],
      headers: { link: '<x?page=2>; rel="next", <x?page=42>; rel="last"' },
    }),
  } as never;
  expect(
    await countRepoCommits(rest, {
      isEmpty: false,
      defaultBranch: "main",
      nameWithOwner: "acme/repo",
    } as never),
  ).toBe(42);
});

test("skips confirmed empty repositories but fails denied commit requests", async () => {
  let calls = 0;
  const rest = {
    request: async () => {
      calls += 1;
      throw new Error("denied");
    },
  } as never;
  expect(
    await countRepoCommits(rest, {
      isEmpty: true,
      defaultBranch: null,
      nameWithOwner: "acme/empty",
    } as never),
  ).toBe(0);
  await expect(
    countRepoCommits(rest, {
      isEmpty: false,
      defaultBranch: "main",
      nameWithOwner: "acme/repo",
    } as never),
  ).rejects.toThrow("denied");
  expect(calls).toBe(1);
});
