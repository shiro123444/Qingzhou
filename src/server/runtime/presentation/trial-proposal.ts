import { z } from 'zod';

import { type TrialPolicy, trialPolicySchema } from './trial-policy';
import type { TrialStageContext } from './trial-runner';

/** Pending observations are data, not validated capabilities or evaluator feedback. */
export const trialProposalExperienceSchema = z
  .object({
    episodeId: z.string().min(1).max(200),
    status: z.literal('pending-validation'),
    applicability: z.literal('source-page-only'),
    outcome: z.string().min(1).max(120),
    reason: z.string().max(1000).optional(),
    attemptedPolicy: trialPolicySchema.optional(),
  })
  .strict();
export type TrialProposalExperience = z.infer<typeof trialProposalExperienceSchema>;
export const trialProposalExperiencesSchema = z.array(trialProposalExperienceSchema).max(3);
export const trialProposalSchema = z
  .object({
    patch: trialPolicySchema,
    rationale: z.string().trim().min(1).max(1200),
    experienceIds: z
      .array(z.string().min(1).max(200))
      .max(3)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export type TrialProposal = z.infer<typeof trialProposalSchema>;
export interface TrialProposalContext extends TrialStageContext {
  experiences: TrialProposalExperience[];
  incumbentPolicy?: TrialPolicy;
  priorAttempt?: { policy?: TrialPolicy; svg: string; notes?: string };
}
