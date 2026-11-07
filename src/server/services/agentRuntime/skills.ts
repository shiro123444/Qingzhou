import { builtinSkills } from '@lobechat/builtin-skills';
import { SkillEngine } from '@lobechat/context-engine';
import type { LobeChatDatabase } from '@lobechat/database';

import type { AgentDocumentWithRules } from '@/database/models/agentDocuments';
import { AgentSkillModel } from '@/database/models/agentSkill';
import { shouldEnableBuiltinSkill } from '@/helpers/skillFilters';

import { resolveManagedSkills } from './managedSkills';

/** Shared by operation admission and the source check at publication time. */
export async function resolveOperationSkills(
  db: LobeChatDatabase,
  userId: string,
  pluginIds: string[],
  agentId?: string,
  documents?: AgentDocumentWithRules[],
) {
  const skillModel = new AgentSkillModel(db, userId);
  const { data } = await skillModel.findAll();
  const fullSkills = await skillModel.findByIds(data.map((skill) => skill.id));
  const engine = new SkillEngine({
    enableChecker: (skill) => shouldEnableBuiltinSkill(skill.identifier),
    skills: [
      ...builtinSkills.map((s) => ({
        content: s.content,
        description: s.description,
        identifier: s.identifier,
        name: s.name,
      })),
      ...fullSkills.map((s) => ({
        content: s.content ?? undefined,
        description: s.description ?? '',
        identifier: s.identifier,
        name: s.name,
      })),
      ...(agentId && documents ? await resolveManagedSkills(documents, { userId, agentId }) : []),
    ],
  });
  return {
    operationSkillSet: engine.generate(pluginIds),
    skillVersions: fullSkills
      .map((s) => ({ id: s.id, generation: s.generation }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
