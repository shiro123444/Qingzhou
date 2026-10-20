import { createHash } from 'node:crypto';

import { z } from 'zod';

import { capabilityCapsuleSchema } from './capability-memory';

const id = z.string().trim().min(1).max(200);
const capsuleId = z.string().regex(/^capsule-[a-f\d]{40}$/u);
const distinctIds = z
  .array(capsuleId)
  .max(6)
  .refine((ids) => new Set(ids).size === ids.length);
type Json = boolean | number | string | null | Json[] | { [key: string]: Json };
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json)]),
);

export const trialRequestSchema = z
  .object({
    jobId: id,
    expectedVersionId: id,
    slideId: id,
    candidates: z
      .array(
        z
          .object({
            id: z.string().regex(/^(?!baseline$)[\w-]{1,64}$/u),
            patch: z.object({ layoutCapsuleIds: distinctIds.optional() }).strict(),
          })
          .strict(),
      )
      .max(2),
  })
  .strict()
  .refine(
    (input) => new Set(input.candidates.map((item) => item.id)).size === input.candidates.length,
  );
export type TrialRequest = z.infer<typeof trialRequestSchema>;

export const trialBudgetSchema = z
  .object({
    maxProbes: z.number().int().min(0).max(2),
    maxRenders: z.number().int().min(1).max(3),
    maxEvaluations: z.number().int().min(0).max(1).optional(),
    maxTokens: z.number().int().nonnegative().safe(),
    maxCostMicros: z.number().int().nonnegative().safe(),
    maxDurationMs: z.number().int().positive().max(600_000),
    maxSnapshotBytes: z
      .number()
      .int()
      .positive()
      .max(32 * 1024 * 1024),
    maxArtifactBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
  })
  .strict();
export type TrialBudget = z.infer<typeof trialBudgetSchema>;

export const trialUsageSchema = z
  .object({
    tokens: z.number().int().nonnegative().safe(),
    costMicros: z.number().int().nonnegative().safe(),
    costBasis: z.enum(['provider-reported', 'reserved']).optional(),
  })
  .strict();
export type TrialUsage = z.infer<typeof trialUsageSchema>;

const model = z
  .object({
    providerId: id,
    model: id,
    configurationDigest: z.string().regex(/^[a-f\d]{64}$/u),
    maxOutputTokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2),
    seed: z.number().int().optional(),
  })
  .strict();
export const trialSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    imageGeneration: z.literal(false),
    executorVersion: id,
    rendererVersion: id,
    recipe: z.object({ id, instructions: z.string().max(20_000) }).strict(),
    models: z.object({ planner: model, observer: model.optional() }).strict(),
    frozenInputs: z.record(json),
    baselineCapsuleIds: distinctIds,
    probeAllowance: trialUsageSchema,
    evaluation: z
      .object({
        version: id,
        allowance: trialUsageSchema,
        visualConstraints: z.string().max(4000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TrialSettings = z.infer<typeof trialSettingsSchema>;

/** Canonical JSON fails closed on values that cannot be faithfully snapshotted. */
export function trialJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === 'object') {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new Error('Trial configuration must contain plain JSON');
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, value]) => value !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => [key, normalize(value)]),
      );
    }
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      return item;
    throw new Error('Trial configuration must contain finite JSON values');
  };
  return JSON.stringify(normalize(value));
}

export const trialDigest = (value: unknown): string =>
  createHash('sha256').update(trialJson(value)).digest('hex');

export function freezeTrialValue<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTrialValue(child);
    Object.freeze(value);
  }
  return value;
}

/** Validate the fully resolved owned composition, not just the proposed IDs. */
export function trialCapsules(value: unknown) {
  return z
    .object({ capsules: z.array(capabilityCapsuleSchema).max(6) })
    .passthrough()
    .parse(value).capsules;
}
