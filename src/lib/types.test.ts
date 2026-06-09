import { describe, expect, test } from "bun:test";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parsePaginationParams } from "./types";

const params = (q: string) => new URLSearchParams(q);

describe("parsePaginationParams", () => {
  test("defaults when params are absent", () => {
    expect(parsePaginationParams(params(""))).toEqual({ page: 1, limit: DEFAULT_PAGE_SIZE });
  });

  test("parses valid page and limit", () => {
    expect(parsePaginationParams(params("page=3&limit=10"))).toEqual({ page: 3, limit: 10 });
  });

  test("clamps page to a minimum of 1", () => {
    expect(parsePaginationParams(params("page=0")).page).toBe(1);
    expect(parsePaginationParams(params("page=-5")).page).toBe(1);
  });

  test("clamps an over-large limit to MAX_PAGE_SIZE", () => {
    expect(parsePaginationParams(params("limit=9999")).limit).toBe(MAX_PAGE_SIZE);
  });

  test("falls back to the default limit for 0 (falsy → default, then clamped)", () => {
    // parseInt("0") is 0, which is falsy, so it falls back to DEFAULT_PAGE_SIZE.
    expect(parsePaginationParams(params("limit=0")).limit).toBe(DEFAULT_PAGE_SIZE);
  });

  test("clamps a negative limit up to 1", () => {
    expect(parsePaginationParams(params("limit=-3")).limit).toBe(1);
  });

  test("falls back to defaults for non-numeric input", () => {
    expect(parsePaginationParams(params("page=abc&limit=xyz"))).toEqual({
      page: 1,
      limit: DEFAULT_PAGE_SIZE,
    });
  });
});
