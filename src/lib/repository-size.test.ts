import { describe, expect, test } from "bun:test";
import { repositorySizeBand } from "./repository-size";

const MIB = 1024;
const GIB = 1024 * MIB;

describe("repositorySizeBand", () => {
  test.each([
    [100 * MIB - 1, "S"],
    [100 * MIB, "M"],
    [GIB - 1, "M"],
    [GIB, "L"],
    [5 * GIB - 1, "L"],
    [5 * GIB, "XL"],
  ] as const)("maps %d KiB to %s", (sizeKb, expected) => {
    expect(repositorySizeBand(sizeKb)).toBe(expected);
  });
});
