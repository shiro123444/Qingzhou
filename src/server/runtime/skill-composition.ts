import { z } from 'zod';

import type { AtomicInvocation, AtomicRuntime } from './atomic-runtime';

export interface SkillStep {
  id: string;
  input: Record<string, unknown>;
  operation: string;
}
export const skillStepsSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
        operation: z.string().min(1),
        input: z.record(z.unknown()),
      })
      .strict(),
  )
  .min(1)
  .max(16);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export async function runSkillSteps(
  runtime: AtomicRuntime,
  steps: SkillStep[],
  context: AtomicInvocation,
  allowed: (operation: string) => boolean,
) {
  skillStepsSchema.parse(steps);
  if (
    JSON.stringify(steps).length > 200_000 ||
    new Set(steps.map((s) => s.id)).size !== steps.length
  )
    throw new Error('Invalid skill composition');
  const results: Record<string, unknown> = Object.create(null);
  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      if (Object.keys(object).length === 1 && typeof object.$ref === 'string') {
        let current: unknown = results;
        for (const part of object.$ref.split('.')) {
          if (
            forbidden.has(part) ||
            !current ||
            typeof current !== 'object' ||
            !Object.hasOwn(current, part)
          )
            throw new Error('Skill references must point to previous step results');
          current = (current as Record<string, unknown>)[part];
        }
        return current;
      }
      return Object.fromEntries(
        Object.entries(object).map(([key, value]) => {
          if (forbidden.has(key)) throw new Error('Invalid skill key');
          return [key, resolve(value)];
        }),
      );
    }
    return value;
  };
  for (const step of steps)
    if (!allowed(step.operation))
      throw new Error(`Operation cannot be composed: ${step.operation}`);
  return runtime.withPlugins(
    steps.map((step) => step.operation.split('.')[0]),
    async () => {
      for (const step of steps)
        results[step.id] = await runtime.invoke(step.operation, resolve(step.input), context);
      return { results, last: results[steps.at(-1)!.id] };
    },
  );
}
export const COMPOSABLE_OPERATIONS = new Set([
  'presentation.memory.search',
  'presentation.memory.load',
  'presentation.memory.compose',
  'presentation.content.compile',
  'presentation.formula.render',
  'presentation.formula.measure',
  'presentation.diagram.measure',
  'presentation.diagram.render',
  'assets.inspect',
  'assets.list',
  'assets.applyMask',
  'presentation.template.extractAssets',
  'presentation.template.extractMedia',
  'assets.transform',
  'assets.removeBackground',
  'assets.keyColor',
  'assets.compose',
  'assets.generate',
  'presentation.template.inspectNative',
  'presentation.template.listNativeOutputs',
  'presentation.template.fillNative',
  'presentation.template.restoreNative',
  'presentation.job.list',
  'presentation.page.read',
  'presentation.page.replace',
]);
