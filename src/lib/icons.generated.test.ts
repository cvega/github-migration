import { describe, expect, test } from "bun:test";
import { ICONS } from "./icons.generated";

describe("generated icon registry", () => {
  test("contains the application icon set with structured render data", () => {
    expect(Object.keys(ICONS).length).toBeGreaterThan(50);
    expect(ICONS["mark-github"]).toBeDefined();
    expect(ICONS["repo-push"]).toBeDefined();
    for (const icon of Object.values(ICONS)) {
      for (const size of [16, 24] as const) {
        expect(icon[size].width).toBeGreaterThan(0);
        expect(icon[size].height).toBeGreaterThan(0);
        expect(icon[size].paths.length).toBeGreaterThan(0);
        expect(icon[size].paths.every((path) => path.d.length > 0)).toBe(true);
      }
    }
  });
});
