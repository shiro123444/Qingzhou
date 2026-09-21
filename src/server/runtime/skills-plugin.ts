import { z } from 'zod';

import type { AtomicPlugin, AtomicRuntime } from './atomic-runtime';
import type { GLMMultimodalChatPort } from './presentation/multimodal-chat-provider-glm';
import { COMPOSABLE_OPERATIONS, runSkillSteps, skillStepsSchema } from './skill-composition';
import { createSkillAgentOperation } from './skills-agent';

export {
  COMPOSABLE_OPERATIONS,
  runSkillSteps,
  type SkillStep,
  skillStepsSchema,
} from './skill-composition';

export function createSkillsPlugin(
  runtime: () => AtomicRuntime,
  chat?: GLMMultimodalChatPort,
): AtomicPlugin {
  return {
    id: 'skills',
    version: '1.0.0',
    operations: [
      ...(chat ? [createSkillAgentOperation(runtime, chat)] : []),
      {
        name: 'skills.catalog',
        description:
          'Discover composable atomic tools and example workflows. An agent may choose or construct a sequence based on the task.',
        input: z.object({}).strict(),
        execute: async () => ({
          tools: (await runtime().catalog()).filter((tool) => COMPOSABLE_OPERATIONS.has(tool.name)),
          recipes: [
            {
              id: 'transparent-artwork',
              steps: [
                'assets.generate',
                'assets.removeBackground',
                'assets.inspect',
                'assets.compose',
              ],
            },
            {
              id: 'style-artwork',
              steps: [
                'assets.generate',
                'assets.removeBackground',
                'assets.transform',
                'assets.compose',
              ],
            },
            {
              id: 'native-template',
              steps: ['presentation.template.inspectNative', 'presentation.template.fillNative'],
            },
            {
              id: 'native-media',
              steps: [
                'presentation.template.inspectNative',
                'presentation.template.extractMedia',
                'presentation.template.fillNative',
              ],
            },
            { id: 'recover-work', steps: ['presentation.job.list', 'presentation.page.read'] },
          ],
          referenceSyntax: { $ref: 'previous_step.ref' },
        }),
      },
      {
        name: 'skills.run',
        description:
          'Execute a bounded agent-composed workflow. Later steps can reference previous results with {"$ref":"stepId.ref"}. Each step retains Cordis scope checks, cancellation and audit events. Completed immutable assets survive a later step failure.',
        input: z.object({ steps: skillStepsSchema }).strict(),
        execute: ({ steps }, ctx) =>
          runSkillSteps(runtime(), steps, ctx, (name) => COMPOSABLE_OPERATIONS.has(name)),
      },
    ],
  };
}
