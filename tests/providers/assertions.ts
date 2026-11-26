import assert from "node:assert/strict";
import type { ProfileNumericMetric, SourceNamespaceInventory } from "$lib/source/types";

export function assertExactMetrics<K extends string>(
  path: string,
  metrics: Record<K, ProfileNumericMetric>,
  expected: Record<K, number>,
): void {
  for (const key in expected) {
    const observation = metrics[key].observation;
    assert.equal(observation.kind, "exact", `${path}: ${key} is not exact`);
    assert.equal(observation.value, expected[key], `${path}: ${key}`);
  }
}

export function assertPaginatedFixture(
  inventory: SourceNamespaceInventory,
  prefix: string,
  count: number,
  kind: "exact" | "at-least",
): void {
  assert.deepEqual(inventory.projectCount, { kind, value: count });
  const expected = Array.from(
    { length: count },
    (_, i) => `${prefix}-${String(i + 1).padStart(3, "0")}`,
  );
  assert.deepEqual(inventory.projects.map((project) => project.path).sort(), expected);
}
