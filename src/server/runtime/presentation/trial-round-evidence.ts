import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import { validatePresentationPlan } from './planner';
import { trialDigest } from './trial-configuration';
import type { TrialEvidence } from './trial-review';
import type { TrialConfigurationSnapshot, TrialRunReport } from './trial-runner';

const fail = () =>
  Object.assign(new Error('Invalid trial evidence'), { code: 'PRESENTATION_INVALID' });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function optional<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
export interface CapturedVariant {
  configuration?: TrialConfigurationSnapshot;
  evaluation?: NonNullable<TrialEvidence['report']['comparison']>['baseline']['evaluation'];
  id: string;
  plan?: PresentationPlan;
  preview?: string;
}
export async function captureTrialRound(report?: TrialRunReport): Promise<CapturedVariant[]> {
  if (!report?.directory) return [];
  const results: CapturedVariant[] = [];
  for (const [index, variant] of report.variants.entries()) {
    const item: CapturedVariant = { id: variant.id };
    const configuration = await optional<TrialConfigurationSnapshot>(
      path.join(report.directory, `configuration-${index}.json`),
    );
    if (configuration && variant.configurationFingerprint) {
      if (trialDigest(configuration) !== variant.configurationFingerprint) throw fail();
      item.configuration = configuration;
    }
    const plan = await optional<PresentationPlan>(
      path.join(report.directory, `plan-${index}.json`),
    );
    if (plan && variant.planSha256) {
      if (trialDigest(plan) !== variant.planSha256) throw fail();
      item.plan = validatePresentationPlan(plan);
    }
    if (variant.preview) {
      const bytes = await readFile(path.join(report.directory, `preview-${index}.png`));
      if (sha(bytes) !== variant.preview.sha256) throw fail();
      item.preview = bytes.toString('base64');
    }
    const comparison = report.comparison;
    item.evaluation =
      comparison &&
      [comparison.baseline, ...comparison.candidates].find((candidate) => candidate.id === item.id)
        ?.evaluation;
    results.push(item);
  }
  return results;
}
