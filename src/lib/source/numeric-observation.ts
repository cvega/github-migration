import { z } from "zod";

/** Every reason a collector or profile writer may record for a missing observation. */
export const OBSERVATION_UNAVAILABLE_REASONS = [
  "forbidden",
  "not-found-or-hidden",
  "not-reported",
  "unsupported",
  "malformed",
  "transient-failure",
  "request-budget",
] as const;

/**
 * Dependency-free so metric declarations can store an observation without
 * importing the profile types that depend on the metric registry.
 */
export const profileNumericObservationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exact"),
      value: z.number().int().nonnegative(),
      basis: z.enum(["reported", "enumerated"]),
      scope: z.string().min(1).max(1_024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("at-least"),
      value: z.number().int().nonnegative(),
      reason: z.enum(["item-cap", "page-cap", "request-budget", "pagination-uncertain"]),
      scope: z.string().min(1).max(1_024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.enum(OBSERVATION_UNAVAILABLE_REASONS),
      scope: z.string().min(1).max(1_024),
    })
    .strict(),
]);
