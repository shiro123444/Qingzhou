import { z } from 'zod';

import type { AtomicPlugin, AtomicRuntime } from './atomic-runtime';
import {
  getComposableOperations,
  runSkillSteps,
  type SkillOperationPolicy,
  type SkillRecipe,
  skillStepsSchema,
} from './skill-composition';
import {
  createSkillAgentOperation,
  type SkillAgentOptions,
  type SkillChatSource,
} from './skills-agent';

export {
  getComposableOperations,
  isComposableOperation,
  runSkillSteps,
  type SkillCatalogOperation,
  type SkillOperationPolicy,
  type SkillRecipe,
  type SkillStep,
  skillStepsSchema,
} from './skill-composition';
export type { SkillAgentOptions, SkillChatPort, SkillChatSource } from './skills-agent';

export interface SkillsPluginOptions {
  agent?: Omit<SkillAgentOptions, 'policy'>;
  /** Selected by trusted application/profile configuration, never tool arguments. */
  policy?: SkillOperationPolicy;
  recipes?: readonly SkillRecipe[];
}

export function createSkillsPlugin(
  runtime: () => AtomicRuntime,
  chat?: SkillChatSource,
  options: SkillsPluginOptions = {},
): AtomicPlugin {
  return {
    id: 'skills',
    version: '1.0.0',
    operations: [
      ...(chat
        ? [createSkillAgentOperation(runtime, chat, { ...options.agent, policy: options.policy })]
        : []),
      {
        name: 'skills.catalog',
        description:
          'Discover composable atomic tools and available workflow recipes. An agent may choose or construct a sequence based on the task.',
        input: z.object({}).strict(),
        execute: async (_input, ctx) => {
          const tools = await getComposableOperations(runtime(), ctx, options.policy);
          const names = new Set(tools.map((tool) => tool.name));
          return {
            tools,
            recipes: (options.recipes ?? []).filter((recipe) =>
              recipe.steps.every((name) => names.has(name)),
            ),
            referenceSyntax: { $ref: 'previous_step.ref' },
          };
        },
      },
      {
        name: 'skills.run',
        description:
          'Execute a bounded capability workflow. Later steps can reference previous results with {"$ref":"stepId.ref"}. Each step retains Cordis scope checks, cancellation and audit events. A failure stops the sequence; completed effects are not automatically rolled back.',
        input: z.object({ steps: skillStepsSchema }).strict(),
        execute: ({ steps }, ctx) => runSkillSteps(runtime(), steps, ctx, options.policy),
      },
    ],
  };
}
