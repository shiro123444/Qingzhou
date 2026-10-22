import { harnessDigest } from '@lobechat/agent-runtime';
import type { OperationSkillSet } from '@lobechat/context-engine';
import type { LobeChatDatabase } from '@lobechat/database';
import type { SkillRevisionRef } from '@lobechat/types';
import matter from 'gray-matter';

import {
  AgentAccess,
  type AgentDocument,
  AgentDocumentModel,
  type AgentDocumentWithRules,
  parseLoadRules,
  PolicyLoad,
} from '@/database/models/agentDocuments';
import {
  SKILL_BUNDLE_FILE_TYPE,
  SKILL_INDEX_FILE_TYPE,
  SKILL_INDEX_FILENAME,
} from '@/server/services/skillManagement/constants';
import { parseSkillFrontmatter } from '@/server/services/skillManagement/frontmatter';

export const managedSkillIdentifier = (bindingId: string) => `managed-skill:${bindingId}`;

/** Preserve frontmatter bytes, identity and load policy; the only editable surface is the body. */
export function replaceManagedSkillBody(content: string, body: string): string {
  const prefix = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u)?.[0];
  if (!prefix || !body.trim() || body.trimStart().startsWith('---') || body.length > 12000)
    throw new Error('HARNESS_INVALID_SKILL_BODY');
  return `${prefix}${prefix.endsWith('\n') ? '' : '\n'}${body}`;
}
export const managedSkillBody = (content: string) => matter(content).content;

/** Custom document limits/positions cannot be silently widened by skill activation. */
function supportsManagedSkillPolicy(doc: AgentDocument): boolean {
  const context = doc.policy?.context ?? {};
  return (
    doc.policyLoad === PolicyLoad.PROGRESSIVE &&
    (parseLoadRules(doc).rule ?? 'always') === 'always' &&
    doc.policyLoadFormat === 'raw' &&
    doc.policyLoadPosition === 'before-first-user' &&
    Object.entries(context).every(
      ([key, value]) =>
        value == null ||
        (key === 'rule' && value === 'always') ||
        (key === 'policyLoadFormat' && value === 'raw') ||
        (key === 'loadMode' && value === 'progressive') ||
        (key === 'position' && value === 'before-first-user'),
    )
  );
}

/** Check live permission/policy without replacing the pinned body with current content. */
export async function assertManagedSkillAccess(
  db: LobeChatDatabase | undefined,
  scope: { agentId?: string; userId?: string },
  ref: SkillRevisionRef,
): Promise<void> {
  if (
    !db ||
    !scope.userId ||
    !scope.agentId ||
    ref.sourceKind !== 'managed-document' ||
    ref.scope.userId !== scope.userId ||
    ref.scope.agentId !== scope.agentId
  )
    throw new Error('HARNESS_PINNED_SKILL_UNAVAILABLE');
  const model = new AgentDocumentModel(db, scope.userId);
  const [index, bundle] = await Promise.all([
    model.findById(ref.bindingId),
    model.findById(ref.bundleBindingId),
  ]);
  if (
    !index ||
    !bundle ||
    index.deletedAt ||
    bundle.deletedAt ||
    index.agentId !== scope.agentId ||
    bundle.agentId !== scope.agentId ||
    index.documentId !== ref.resourceId ||
    bundle.documentId !== ref.bundleResourceId ||
    index.parentId !== bundle.documentId ||
    !supportsManagedSkillPolicy(index) ||
    !(index.accessSelf & AgentAccess.READ) ||
    !(bundle.accessSelf & AgentAccess.READ)
  )
    throw new Error('HARNESS_PINNED_SKILL_UNAVAILABLE');
  const rule = parseLoadRules(index).rule;
  if (rule && rule !== 'always') throw new Error('HARNESS_PINNED_SKILL_UNAVAILABLE');
}

/** Only already-readable, progressively loaded, standalone text indexes enter this first surface. */
export async function resolveManagedSkills(
  documents: AgentDocumentWithRules[],
  scope: SkillRevisionRef['scope'],
): Promise<OperationSkillSet['skills']> {
  const result: OperationSkillSet['skills'] = [];
  for (const index of documents) {
    if (
      index.agentId !== scope.agentId ||
      index.userId !== scope.userId ||
      index.deletedAt ||
      index.fileType !== SKILL_INDEX_FILE_TYPE ||
      index.filename !== SKILL_INDEX_FILENAME ||
      !supportsManagedSkillPolicy(index) ||
      !(index.accessSelf & AgentAccess.READ) ||
      !(index.accessSelf & AgentAccess.LIST) ||
      !(index.accessSelf & AgentAccess.WRITE) ||
      (index.loadRules?.rule && index.loadRules.rule !== 'always')
    )
      continue;
    const bundle = documents.find(
      (doc) => doc.documentId === index.parentId && doc.fileType === SKILL_BUNDLE_FILE_TYPE,
    );
    if (
      !bundle ||
      bundle.agentId !== scope.agentId ||
      bundle.userId !== scope.userId ||
      bundle.deletedAt ||
      !(bundle.accessSelf & AgentAccess.READ) ||
      !(bundle.accessSelf & AgentAccess.LIST) ||
      !(bundle.accessSelf & AgentAccess.WRITE) ||
      documents.filter((doc) => doc.parentId === bundle.documentId).length !== 1 ||
      documents.some((doc) => doc.parentId === index.documentId) ||
      [
        index.generation,
        index.documentGeneration,
        bundle.generation,
        bundle.documentGeneration,
      ].some((g) => !Number.isSafeInteger(g))
    )
      continue;
    try {
      const frontmatter = parseSkillFrontmatter(index.content);
      if (
        frontmatter.name !== bundle.filename ||
        Object.keys(matter(index.content).data).some(
          (key) => !['name', 'description'].includes(key),
        )
      )
        continue;
      const contentDigest = await harnessDigest(index.content);
      const ref: Omit<SkillRevisionRef, 'revisionId'> = {
        bindingId: index.id,
        resourceId: index.documentId,
        generation: index.generation!,
        documentGeneration: index.documentGeneration!,
        bundleBindingId: bundle.id,
        bundleResourceId: bundle.documentId,
        bundleGeneration: bundle.generation!,
        bundleDocumentGeneration: bundle.documentGeneration!,
        contentDigest,
        scope,
        sourceKind: 'managed-document',
        name: bundle.filename,
        loading: 'progressive',
      };
      result.push({
        identifier: managedSkillIdentifier(index.id),
        name: managedSkillIdentifier(index.id),
        description: frontmatter.description,
        content: index.content,
        revision: { ...ref, revisionId: `skill-${await harnessDigest(ref)}` },
      });
    } catch {
      // Malformed or unsupported compatibility documents remain documents, never guessed skill identities.
    }
  }
  return result.sort((a, b) => a.identifier.localeCompare(b.identifier));
}
