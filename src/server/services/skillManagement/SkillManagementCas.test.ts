// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getTestDB } from '@lobechat/database/test-utils';
import { SkillMaintainerExecutionRuntime } from '@lobechat/builtin-tool-skill-maintainer';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agents, agentDocuments, documentHistories, documents, users } from '@/database/schemas';
import {
  learningMutationAuthority,
  userMutationAuthority,
  type MutationAuthority,
} from '@/server/runtime/improvement/mutation-authority';
import { FileHarnessStore } from '@/server/runtime/improvement/store';
import { skillManagementRuntime } from '@/server/services/toolExecution/serverRuntimes/skillManagement';

import { createMarkdownEditorSnapshot } from '../agentDocuments/headlessEditor';
import { SkillManagementDocumentService } from './SkillManagementDocumentService';

const db = await getTestDB();
const userId = 'skill-cas-owner';
const agentId = 'skill-cas-agent';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'qingzhou-skill-cas-'));
  vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '1');
  vi.stubEnv('QINGZHOU_HARNESS_DATA_ROOT', root);
  await db.insert(users).values({ id: userId });
  await db.insert(agents).values({ id: agentId, userId });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.delete(users).where(eq(users.id, userId));
  await rm(root, { recursive: true, force: true });
});
const manual = () =>
  new SkillManagementDocumentService(db, userId, undefined, userMutationAuthority(userId));
const params = {
  agentId,
  name: 'test-skill',
  title: 'Test skill',
  description: 'Description',
  bodyMarkdown: 'Original body',
};

async function pendingEdit(action: 'replace' | 'rename' = 'replace') {
  const skill = await manual().createSkill(params);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const service = new SkillManagementDocumentService(
    db,
    userId,
    {
      createMarkdownEditorSnapshot: async (content) => {
        enter();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return createMarkdownEditorSnapshot(content);
      },
    },
    userMutationAuthority(userId),
  );
  const promise =
    action === 'replace'
      ? service.replaceSkillIndex({
          agentId,
          name: skill.name,
          bodyMarkdown: 'Replacement',
          description: 'New description',
        })
      : service.renameSkill({ agentId, name: skill.name, newName: 'renamed-skill' });
  const outcome = promise.then(
    (value) => ({ value, error: undefined }),
    (error: Error) => ({ value: undefined, error }),
  );
  await entered;
  return { skill, release, outcome };
}

describe('managed skill write authority and resource CAS', () => {
  it.each(['replace', 'rename'] as const)(
    'rejects a concurrent document edit during %s before changing bundle metadata or history',
    async (action) => {
      const { skill, release, outcome } = await pendingEdit(action);
      const [bundle] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, skill.bundle.documentId));
      await db
        .update(documents)
        .set({ content: 'Concurrent manual body' })
        .where(eq(documents.id, skill.index.documentId));
      release();
      expect((await outcome).error?.message).toBe('RESOURCE_CAS_CONFLICT');
      const [after] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, skill.bundle.documentId));
      expect(after).toEqual(bundle);
      expect(
        (await db.select().from(documents).where(eq(documents.id, skill.index.documentId)))[0]
          .content,
      ).toBe('Concurrent manual body');
      expect(await db.select().from(documentHistories)).toHaveLength(0);
    },
  );

  it.each(['accessSelf', 'deletedAt'] as const)(
    'rechecks %s inside the mutation transaction',
    async (field) => {
      const { skill, release, outcome } = await pendingEdit();
      await db
        .update(agentDocuments)
        .set(field === 'accessSelf' ? { accessSelf: 10 } : { deletedAt: new Date() })
        .where(eq(agentDocuments.id, skill.index.agentDocumentId));
      release();
      expect((await outcome).error?.message).toBe('RESOURCE_CAS_CONFLICT');
      expect(
        (await db.select().from(documents).where(eq(documents.id, skill.index.documentId)))[0]
          .content,
      ).toContain('Original body');
    },
  );

  it('detects ABA changes through database generations rather than a content hash alone', async () => {
    const { skill, release, outcome } = await pendingEdit();
    const [before] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, skill.index.documentId));
    await db
      .update(documents)
      .set({ content: 'Intermediate' })
      .where(eq(documents.id, skill.index.documentId));
    await db
      .update(documents)
      .set({ content: before.content, generation: 0, updatedAt: before.updatedAt })
      .where(eq(documents.id, skill.index.documentId));
    release();
    expect((await outcome).error?.message).toBe('RESOURCE_CAS_CONFLICT');
    expect(
      (await db.select().from(documents).where(eq(documents.id, skill.index.documentId)))[0]
        .generation,
    ).toBe(2);
  });

  it('rolls back bundle, body and history when a later write fails', async () => {
    const skill = await manual().createSkill(params);
    const [bundle] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, skill.bundle.documentId));
    await db.execute(
      sql.raw(
        `CREATE FUNCTION fail_skill_write() RETURNS trigger AS $$ BEGIN IF NEW.content LIKE '%ROLLBACK_MARKER%' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;`,
      ),
    );
    await db.execute(
      sql.raw(
        'CREATE TRIGGER fail_skill_write BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION fail_skill_write();',
      ),
    );
    try {
      await expect(
        manual().replaceSkillIndex({
          agentId,
          name: skill.name,
          bodyMarkdown: 'ROLLBACK_MARKER',
          description: 'Changed description',
        }),
      ).rejects.toThrow();
      expect(
        (await db.select().from(documents).where(eq(documents.id, skill.bundle.documentId)))[0],
      ).toEqual(bundle);
      expect(
        (await db.select().from(documents).where(eq(documents.id, skill.index.documentId)))[0]
          .content,
      ).toBe(skill.content);
      expect(await db.select().from(documentHistories)).toHaveLength(0);
    } finally {
      await db.execute(sql.raw('DROP TRIGGER fail_skill_write ON documents;'));
      await db.execute(sql.raw('DROP FUNCTION fail_skill_write();'));
    }
  });

  it('allows explicit owner edits and preserves editor history and document identities', async () => {
    const skill = await manual().createSkill(params);
    const updated = await manual().replaceSkillIndex({
      agentId,
      name: skill.name,
      bodyMarkdown: 'Explicit user replacement',
    });
    expect(updated?.index.documentId).toBe(skill.index.documentId);
    expect(updated?.bundle.documentId).toBe(skill.bundle.documentId);
    expect(updated?.content).toContain('Explicit user replacement');
    expect(await db.select().from(documentHistories)).toHaveLength(1);
  });

  it('prevents a manual rename from colliding with another managed bundle', async () => {
    const first = await manual().createSkill(params);
    await manual().createSkill({ ...params, name: 'occupied' });
    await expect(
      manual().renameSkill({ agentId, name: first.name, newName: 'occupied' }),
    ).rejects.toThrow('Skill already exists');
    expect(
      (await manual().getSkill({ agentId, name: first.name, includeContent: true }))?.content,
    ).toBe(first.content);
  });

  it('checks agent ownership before creating new documents', async () => {
    await db.insert(users).values({ id: 'foreign-skill-owner' });
    await db.insert(agents).values({ id: 'foreign-skill-agent', userId: 'foreign-skill-owner' });
    try {
      await expect(
        manual().createSkill({ ...params, agentId: 'foreign-skill-agent' }),
      ).rejects.toThrow('RESOURCE_SCOPE_NOT_FOUND');
      expect(await db.select().from(documents)).toHaveLength(0);
    } finally {
      await db.delete(users).where(eq(users.id, 'foreign-skill-owner'));
    }
  });

  it('rejects missing, forged and cross-account capabilities before any mutation', async () => {
    for (const authority of [
      undefined,
      { kind: 'user-edit', userId },
      userMutationAuthority('another-user'),
    ]) {
      const service = new SkillManagementDocumentService(
        db,
        userId,
        undefined,
        authority as MutationAuthority,
      );
      await expect(service.createSkill(params)).rejects.toThrow('HARNESS_AUTHORITY_REQUIRED');
    }
    expect(await db.select().from(documents)).toHaveLength(0);
  });

  it('stages the previously unclassified hidden runtime as a proposal, without allowing tool args to assert user authority', async () => {
    const runtime = skillManagementRuntime.factory({
      userId,
      serverDB: db,
      toolManifestMap: {},
    }) as SkillMaintainerExecutionRuntime;
    await expect(
      runtime.createSkill({ ...params, authority: { kind: 'user-edit', userId } } as any, {
        agentId,
      }),
    ).rejects.toThrow('HARNESS_VALIDATION_REQUIRED');
    expect(await db.select().from(documents)).toHaveLength(0);
    const state = await new FileHarnessStore(root).read({ userId, agentId });
    expect(state.intents).toHaveLength(1);
    expect(state.intents![0].operation).toBe('create');
  });
});
