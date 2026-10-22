import { harnessDigest } from '@lobechat/agent-runtime';
import { SkillsExecutionRuntime } from '@lobechat/builtin-tool-skills/executionRuntime';

import { assertManagedSkillAccess } from '@/server/services/agentRuntime/managedSkills';

import type { ToolExecutionContext } from './types';

/** Managed names never fall back to account skills or the latest document body. */
export class PinnedSkillsExecutionRuntime extends SkillsExecutionRuntime {
  constructor(
    options: ConstructorParameters<typeof SkillsExecutionRuntime>[0],
    private context: ToolExecutionContext,
  ) {
    super(options);
  }
  override async activateSkill(args: Parameters<SkillsExecutionRuntime['activateSkill']>[0]) {
    if (!args.name.startsWith('managed-skill:')) return super.activateSkill(args);
    const { context } = this;
    context.assertStepLease?.();
    context.signal?.throwIfAborted();
    const skill = context.operationSkillSet?.skills.find((s) => s.name === args.name);
    const ref = skill?.revision;
    if (
      !skill?.content ||
      !ref ||
      ref.sourceKind !== 'managed-document' ||
      skill.identifier !== `managed-skill:${ref.bindingId}` ||
      !context.serverDB ||
      ref.scope.userId !== context.userId ||
      ref.scope.agentId !== context.agentId ||
      ref.contentDigest !== (await harnessDigest(skill.content))
    )
      throw new Error('HARNESS_PINNED_SKILL_UNAVAILABLE');
    await assertManagedSkillAccess(
      context.serverDB,
      { userId: context.userId, agentId: context.agentId },
      ref,
    );
    context.assertStepLease?.();
    context.signal?.throwIfAborted();
    return {
      content: skill.content,
      state: {
        description: skill.description,
        hasResources: false,
        identifier: skill.identifier,
        name: skill.name,
        revisionId: ref.revisionId,
      },
      success: true,
    };
  }
}
