import { describe, expect, test } from "bun:test";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_NUMBER, MAX_PAGE_SIZE, parsePaginationParams } from "./types";

const params = (query: string) => new URLSearchParams(query);

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

  test("clamps limits to the supported range", () => {
    expect(parsePaginationParams(params("limit=9999")).limit).toBe(MAX_PAGE_SIZE);
    expect(parsePaginationParams(params("limit=0")).limit).toBe(1);
    expect(parsePaginationParams(params("limit=-3")).limit).toBe(1);
  });

  test("falls back for malformed and unsafe integers", () => {
    expect(parsePaginationParams(params("page=abc&limit=10px"))).toEqual({
      page: 1,
      limit: DEFAULT_PAGE_SIZE,
    });
    expect(parsePaginationParams(params("page=9007199254740992&limit=9007199254740992"))).toEqual({
      page: 1,
      limit: DEFAULT_PAGE_SIZE,
    });
  });

  test("caps page numbers before offset arithmetic", () => {
    expect(parsePaginationParams(params("page=9007199254740991")).page).toBe(MAX_PAGE_NUMBER);
  });
});
