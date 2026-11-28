import { z } from "zod";
import { profileNumericObservationSchema } from "$lib/source/numeric-observation";
import type { ProfileNumericMetric } from "$lib/source/types";
import { SOURCE_PROVIDERS } from "$lib/source-provider";

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
