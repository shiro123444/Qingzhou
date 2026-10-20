import { z } from 'zod';

import {
  assertAtomicInvocationActive,
  type AtomicInvocation,
  type AtomicRuntime,
} from './atomic-runtime';

export type SkillCatalogOperation = Awaited<ReturnType<AtomicRuntime['catalog']>>[number];

/** A trusted host policy may narrow the capabilities opted in by plugins. */
export type SkillOperationPolicy = (
  name: string,
  invocation: AtomicInvocation,
  operation: SkillCatalogOperation,
) => boolean;

export interface SkillRecipe {
  description?: string;
  id: string;
  steps: readonly string[];
}

export const isComposableOperation = (operation: SkillCatalogOperation): boolean =>
  operation.agent?.contexts.includes('skills') === true;

export async function getComposableOperations(
  runtime: AtomicRuntime,
  invocation: AtomicInvocation,
  policy?: SkillOperationPolicy,
): Promise<SkillCatalogOperation[]> {
  return (await runtime.catalog()).filter(
    (operation) =>
      isComposableOperation(operation) &&
      (!policy || policy(operation.name, invocation, operation) === true),
  );
}

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
  allowed?: SkillOperationPolicy,
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
  assertAtomicInvocationActive(context);
  return runtime.withPlugins(
    steps.map((step) => step.operation.split('.')[0]),
    async () => {
      // Read metadata only after leasing every participant: a replacement cannot
      // change its opt-in, schema or implementation between validation and use.
      const catalog = await getComposableOperations(runtime, context, allowed);
      const operations = new Set(catalog.map((operation) => operation.name));
      for (const step of steps)
        if (!operations.has(step.operation))
          throw new Error(`Operation cannot be composed: ${step.operation}`);
      for (const step of steps) {
        assertAtomicInvocationActive(context);
        results[step.id] = await runtime.invoke(step.operation, resolve(step.input), context);
      }
      return { results, last: results[steps.at(-1)!.id] };
    },
  );
}
