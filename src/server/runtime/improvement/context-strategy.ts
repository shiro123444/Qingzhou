import type { AgentPluginComposition, SkillMaterialBinding } from '@lobechat/agent-runtime';

import {
  skillMaterialBinding,
  type SkillMaterialLease,
  type SkillMaterialRegistry,
  skillMaterialRegistry,
} from './skill-material';

/** Registered host code; a persisted revision selects a versioned strategy, never a code path. */
export const promptStrategies = {
  'standard': (system: string) => system,
  'evidence-first': (system: string) =>
    `${system}\nState what the supplied evidence supports. If evidence is insufficient, explain the gap; do not invent facts.`,
};
/** Metadata is owned by the provider registry, so new strategies need no UI branching. */
export const promptStrategyOptions = [
  { value: 'standard', labelKey: 'harness.strategyStandard' },
  { value: 'evidence-first', labelKey: 'harness.strategyEvidence' },
] as const;
export type PromptStrategy = keyof typeof promptStrategies;
declare module '@lobechat/cordis-foundation' {
  interface Context {
    'qingzhou.context.instructions': (text: string) => string;
    'qingzhou.context.skill-material': SkillMaterialLease['apply'];
  }
}
export function contextStrategyComposition(
  strategy: PromptStrategy = 'standard',
  probeOnly = false,
  material: SkillMaterialBinding = skillMaterialBinding(undefined),
  registry: SkillMaterialRegistry = skillMaterialRegistry,
): AgentPluginComposition {
  const transform = Object.hasOwn(promptStrategies, strategy)
    ? promptStrategies[strategy]
    : undefined;
  if (!transform) throw new Error('HARNESS_UNKNOWN_STRATEGY');
  return {
    modules: {
      'skill-material': {
        plugin: {
          name: 'qingzhou.context.skill-material',
          apply(ctx) {
            const lease = registry.acquire(material);
            ctx.effect(() => lease.release);
            ctx.provide('qingzhou.context.skill-material', lease.apply);
          },
        },
      },
      'context-strategy': {
        plugin: {
          name: 'qingzhou.context.instructions',
          apply(ctx) {
            ctx.provide('qingzhou.context.instructions', transform);
            if (probeOnly)
              ctx.on('qingzhou.agent.execute', async (request, next) => {
                if (!['call_llm', 'finish'].includes(request.instruction.type))
                  throw new Error('HARNESS_PROBE_EFFECT_DENIED');
                return next();
              });
          },
        },
      },
    },
    bundles: {
      configured: {
        includes: ['agent'],
        entries: [
          { id: 'context-strategy', use: 'context-strategy' },
          { id: 'skill-material', use: 'skill-material' },
        ],
      },
    },
    profile: { bundles: ['configured'] },
  };
}
