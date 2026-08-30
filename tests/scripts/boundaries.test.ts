import { describe, expect, test } from "bun:test";
import { checkBoundary, type Layer } from "../../scripts/checks/boundary-policy";

describe("server architecture boundaries", () => {
  test.each<Layer>(["core", "source", "profile", "migrate"])(
    "%s cannot import the application layer",
    (layer) => {
      expect(checkBoundary(layer, "application")).toBe(
        `${layer}/ must not import the application layer`,
      );
    },
  );

  test.each<Layer>(["core", "source", "profile", "migrate"])(
    "application can compose %s",
    (layer) => {
      expect(checkBoundary("application", layer)).toBeNull();
    },
  );

  test("domains remain isolated from siblings", () => {
    expect(checkBoundary("migrate", "source")).toBe(
      "domain 'migrate' must not import domain 'source'",
    );
    expect(checkBoundary("profile", "migrate")).toBe(
      "domain 'profile' must not import domain 'migrate'",
    );
  });

  test("classified layers cannot import root-level server modules", () => {
    expect(checkBoundary("application", "unclassified")).toBe(
      "server imports must target a classified layer",
    );
  });
});
