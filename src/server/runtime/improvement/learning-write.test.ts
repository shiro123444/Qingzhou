// @vitest-environment node
import { learningMutationAuthority } from '@/server/runtime/improvement/mutation-authority';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createToolSet } from '@/server/services/agentSignal/services/selfIteration/tools/shared';
import { SkillManagementDocumentService } from '@/server/services/skillManagement';

import { stageLearnedSkillWrite } from './learning-write';
import { FileHarnessStore } from './store';

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});
describe('learned skill mutation boundary', () => {
  it('records the complete proposal before rejecting the legacy direct write and deduplicates retries', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'qingzhou-learning-gate-'));
    vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '1');
    vi.stubEnv('QINGZHOU_HARNESS_DATA_ROOT', root);
    const transaction = vi.fn();
    const service = new SkillManagementDocumentService(
      { transaction } as any,
      'owner',
      { agentDocumentModel: {} as any, documentService: {} as any },
      learningMutationAuthority('owner'),
    );
    const proposal = {
      agentId: 'agent',
      bodyMarkdown: 'Full transferable procedure',
      description: 'Context',
      name: 'procedure',
      title: 'Procedure',
    };
    await expect(service.createSkill(proposal)).rejects.toThrow('HARNESS_VALIDATION_REQUIRED');
    await expect(service.createSkill(proposal)).rejects.toThrow('HARNESS_VALIDATION_REQUIRED');
    expect(transaction).not.toHaveBeenCalled();
    const state = await new FileHarnessStore(root).read({ userId: 'owner', agentId: 'agent' });
    expect(state.intents).toHaveLength(1);
    expect(state.intents![0].material).toEqual(proposal);
    expect(state.active).toBeUndefined();
    const writeReceipt = vi.fn(async () => ({ receiptId: 'pending-receipt' }));
    const tools = createToolSet({
      reserveOperation: async () => ({ reserved: true }),
      writeReceipt,
      createSkill: async () => {
        await service.createSkill(proposal);
        return {};
      },
    });
    expect(
      await tools.createSkillIfAbsent({
        userId: 'owner',
        idempotencyKey: 'automatic-proposal',
        name: proposal.name,
        bodyMarkdown: proposal.bodyMarkdown,
      }),
    ).toMatchObject({
      status: 'proposed',
      resourceId: state.intents![0].id,
      receiptId: 'pending-receipt',
    });
    expect(writeReceipt).toHaveBeenCalledWith(expect.objectContaining({ status: 'proposed' }));
    expect(transaction).not.toHaveBeenCalled();
    expect(
      (await new FileHarnessStore(root).read({ userId: 'another-owner', agentId: 'agent' }))
        .intents,
    ).toBeUndefined();
  });
  it('leaves the old feature-disabled path unchanged', async () => {
    vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '0');
    await expect(
      stageLearnedSkillWrite('owner', 'agent', 'create', { bodyMarkdown: 'Proposal' }),
    ).resolves.toBeUndefined();
  });
});
