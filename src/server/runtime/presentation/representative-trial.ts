import { z } from 'zod';

const identifier = z.string().trim().min(1).max(200);
const digest = z.string().regex(/^[a-f\d]{64}$/u);
const gate = z
  .object({
    status: z.enum(['passed', 'failed', 'unknown']),
    evidence: z.string().trim().min(1).max(1200),
  })
  .strict();
const dimension = z
  .object({ score: z.number().int().min(0).max(4), evidence: z.string().trim().min(1).max(1200) })
  .strict();
const dimensions = ['readability', 'hierarchy', 'composition', 'styleConsistency'] as const;

/** Evidence is supplied by a trusted runner, never by model tool arguments. */
const evaluationSchema = z
  .object({
    conditionFingerprint: digest,
    evaluatorVersion: identifier,
    artifact: z.object({ ref: identifier, sha256: digest }).strict(),
    gates: z
      .object({ facts: gate, editability: gate, assets: gate, render: gate, visual: gate })
      .strict(),
    quality: z
      .object({
        readability: dimension,
        hierarchy: dimension,
        composition: dimension,
        styleConsistency: dimension,
      })
      .strict(),
  })
  .strict();
export { evaluationSchema as representativeTrialEvaluationSchema };

const variantSchema = z
  .object({
    id: identifier,
    status: z.enum(['completed', 'failed', 'cancelled']),
    appliedCapsuleIds: z
      .array(z.string().regex(/^capsule-[a-f\d]{40}$/u))
      .max(6)
      .refine((ids) => new Set(ids).size === ids.length, 'Applied capability IDs must be distinct'),
    evaluation: evaluationSchema.optional(),
  })
  .strict();

export const representativeTrialSchema = z
  .object({
    schemaVersion: z.literal(1),
    trialId: identifier,
    source: z.object({ jobId: identifier, versionId: identifier, slideId: identifier }).strict(),
    conditionFingerprint: digest,
    baseline: variantSchema.extend({ id: z.literal('baseline') }),
    candidates: z.array(variantSchema).max(2),
    incumbentId: identifier.optional(),
    userChoice: identifier.optional(),
    rejectedCandidateIds: z.array(identifier).max(2).default([]),
  })
  .strict()
  .superRefine((trial, ctx) => {
    const ids = trial.candidates.map(({ id }) => id);
    if (trial.incumbentId && !ids.includes(trial.incumbentId))
      ctx.addIssue({ code: 'custom', message: 'Incumbent must name an existing candidate' });
    if (ids.includes('baseline') || new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Candidate IDs must be unique and exclude baseline',
      });
    if (trial.userChoice && trial.userChoice !== 'baseline' && !ids.includes(trial.userChoice))
      ctx.addIssue({ code: 'custom', message: 'User choice must name an existing variant' });
    if (
      new Set(trial.rejectedCandidateIds).size !== trial.rejectedCandidateIds.length ||
      trial.rejectedCandidateIds.some((id) => !ids.includes(id)) ||
      trial.rejectedCandidateIds.includes(trial.userChoice ?? '')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Rejected candidates must be distinct and unselected',
      });
  });

export type RepresentativeTrial = z.infer<typeof representativeTrialSchema>;
type Variant = RepresentativeTrial['baseline'] | RepresentativeTrial['candidates'][number];
type Evaluation = z.infer<typeof evaluationSchema>;
const exclusionSchema = z.enum([
  'incomplete',
  'missing-evidence',
  'condition-mismatch',
  'evaluator-mismatch',
  'gate-failed',
  'user-rejected',
]);
type TrialExclusion = z.infer<typeof exclusionSchema>;
export const representativeTrialSelectionSchema = z
  .object({
    policyVersion: z.union([z.literal(1), z.literal(2)]),
    candidates: z
      .array(
        z
          .object({
            id: identifier,
            exclusion: exclusionSchema.optional(),
            improvesBaseline: z.boolean(),
          })
          .strict(),
      )
      .max(2),
    reason: z.enum([
      'user-kept-baseline',
      'baseline-unverified',
      'user-choice-ineligible',
      'user-selected',
      'no-improvement',
      'ambiguous-improvement',
      'strict-improvement',
      'incumbent-retained',
      'incumbent-improved',
    ]),
    selectedId: identifier,
  })
  .strict();
export type RepresentativeTrialSelection = z.infer<typeof representativeTrialSelectionSchema>;

/** Keeping an unverified baseline is an abstention, never a publication certificate. */
export function selectRepresentativeTrial(
  input: RepresentativeTrial,
): RepresentativeTrialSelection {
  const trial = representativeTrialSchema.parse(input);
  const baseline = trial.baseline.evaluation;
  const exclusion = (variant: Variant): TrialExclusion | undefined => {
    if (trial.rejectedCandidateIds.includes(variant.id)) return 'user-rejected';
    if (variant.status !== 'completed') return 'incomplete';
    if (!variant.evaluation) return 'missing-evidence';
    if (variant.evaluation.conditionFingerprint !== trial.conditionFingerprint)
      return 'condition-mismatch';
    if (baseline && variant.evaluation.evaluatorVersion !== baseline.evaluatorVersion)
      return 'evaluator-mismatch';
    if (Object.values(variant.evaluation.gates).some((value) => value.status !== 'passed'))
      return 'gate-failed';
  };
  const dominates = (a: Evaluation, b: Evaluation) =>
    dimensions.every((name) => a.quality[name].score >= b.quality[name].score) &&
    dimensions.some((name) => a.quality[name].score > b.quality[name].score);
  const baselineExclusion = exclusion(trial.baseline);
  const candidates = trial.candidates.map((candidate) => ({
    id: candidate.id,
    exclusion: exclusion(candidate),
    improvesBaseline: Boolean(
      !baselineExclusion &&
      baseline &&
      candidate.evaluation &&
      !exclusion(candidate) &&
      dominates(candidate.evaluation, baseline),
    ),
  }));
  const result = (
    reason: RepresentativeTrialSelection['reason'],
    selectedId = 'baseline',
  ): RepresentativeTrialSelection => ({
    policyVersion: trial.incumbentId ? 2 : 1,
    candidates,
    reason,
    selectedId,
  });

  if (trial.userChoice === 'baseline') return result('user-kept-baseline');
  if (baselineExclusion) return result('baseline-unverified');
  if (trial.userChoice) {
    const chosen = candidates.find(({ id }) => id === trial.userChoice)!;
    return chosen.exclusion ? result('user-choice-ineligible') : result('user-selected', chosen.id);
  }
  const improvements = trial.candidates.filter((candidate) =>
    candidates.some(
      ({ id, exclusion, improvesBaseline }) =>
        id === candidate.id && !exclusion && improvesBaseline,
    ),
  );
  if (trial.incumbentId) {
    const incumbent = improvements.find((candidate) => candidate.id === trial.incumbentId);
    if (incumbent) {
      const replacement = improvements.find(
        (candidate) =>
          candidate.id !== incumbent.id && dominates(candidate.evaluation!, incumbent.evaluation!),
      );
      return replacement
        ? result('incumbent-improved', replacement.id)
        : result('incumbent-retained', incumbent.id);
    }
  }
  if (!improvements.length) return result('no-improvement');
  const winner = improvements.find((candidate) =>
    improvements.every(
      (other) => candidate.id === other.id || dominates(candidate.evaluation!, other.evaluation!),
    ),
  );
  return winner ? result('strict-improvement', winner.id) : result('ambiguous-improvement');
}
