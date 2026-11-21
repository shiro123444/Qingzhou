import { z } from 'zod';

import { teachingContextSchema } from '@/types/presentationTeaching';

export const creativePlanSchema = z.object({
  goal: z.string().min(1).max(1500),
  narrative: z.string().min(1).max(3000),
  rationale: z.string().min(1).max(2000),
  steps: z
    .array(z.object({ action: z.string().min(1).max(500), reason: z.string().min(1).max(1000) }))
    .min(1)
    .max(12),
  successCriteria: z.array(z.string().min(1).max(500)).min(1).max(12),
});

export const creativeBriefSchema = z
  .object({
    teachingContext: teachingContextSchema.optional(),
    topic: z.string().min(1).max(2000).optional(),
    audience: z.string().max(2000).optional(),
    language: z.string().max(100).optional(),
    style: z.string().max(3000).optional(),
    slideCount: z.number().int().min(1).max(100).optional(),
    aspectRatio: z.enum(['16:9', '4:3']).optional(),
    plan: creativePlanSchema.optional(),
  })
  .strict();
