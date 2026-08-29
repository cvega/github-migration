import { z } from "zod";
import type { ProfileNumericMetric } from "$lib/source/types";
import { SOURCE_PROVIDERS } from "$lib/source-provider";

const profileNumericObservationSchema = z.discriminatedUnion("kind", [
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
      reason: z.enum([
        "forbidden",
        "not-found-or-hidden",
        "not-reported",
        "unsupported",
        "malformed",
        "transient-failure",
      ]),
      scope: z.string().min(1).max(1_024),
    })
    .strict(),
]);

export const profileNumericMetricSchema = z
  .object({
    provider: z.enum(SOURCE_PROVIDERS),
    endpointFamily: z.string().min(1).max(255),
    collectedAt: z.string().datetime({ offset: true }),
    observation: profileNumericObservationSchema,
  })
  .strict();

export function parseProfileNumericMetric(value: unknown): ProfileNumericMetric {
  return profileNumericMetricSchema.parse(value) as ProfileNumericMetric;
}
