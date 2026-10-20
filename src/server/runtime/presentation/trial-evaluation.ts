import { z } from 'zod';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import { representativeTrialEvaluationSchema } from './representative-trial';
import { trialDigest, type TrialUsage, trialUsageSchema } from './trial-configuration';

export const anonymousTrialScoresSchema = z
  .object({
    cases: z
      .array(
        representativeTrialEvaluationSchema
          .omit({
            artifact: true,
            conditionFingerprint: true,
            evaluatorVersion: true,
          })
          .extend({ label: z.enum(['A', 'B', 'C']) }),
      )
      .min(1)
      .max(3),
    usage: trialUsageSchema,
  })
  .strict();
export type AnonymousTrialScores = z.infer<typeof anonymousTrialScoresSchema>;
export interface AnonymousTrialContext {
  allowance: TrialUsage;
  cases: readonly { label: 'A' | 'B' | 'C'; svg: string; notes: string; bytes: Uint8Array }[];
  model: {
    providerId: string;
    model: string;
    configurationDigest: string;
    maxOutputTokens: number;
    temperature: number;
    seed?: number;
  };
  scope: RuntimeScope;
  signal: AbortSignal;
  sourceImageRefs: string[];
  sourceNotes: string;
  sourceTexts: string[];
  title: string;
  version: string;
  visualConstraints: string;
}

/** Fixed factual strings, without the source page's layout or identity. */
export function trialEditableTexts(svg: string): string[] {
  const document = parseString(svg);
  if (
    document.documentElement.localName !== 'svg' ||
    document.getElementsByTagName('parsererror').length
  )
    throw new Error('TRIAL_INVALID_SVG');
  return Array.from(document.getElementsByTagName('text'))
    .map((node) => (node.textContent ?? '').normalize('NFKC').replaceAll(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .sort();
}

/** Server-owned identity map; the evaluator receives only the shuffled labels. */
export function anonymizeTrialIds(ids: string[], seed: string) {
  const ordered = [...ids].sort((a, b) =>
    trialDigest([seed, a]).localeCompare(trialDigest([seed, b])),
  );
  return ordered.map((id, index) => ({ id, label: ['A', 'B', 'C'][index] as 'A' | 'B' | 'C' }));
}
