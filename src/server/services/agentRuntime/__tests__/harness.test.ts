// @vitest-environment node
/* eslint-disable unicorn/prefer-structured-clone -- These tests exercise the persisted JSON wire format. */
import { bindHarness, createHarnessRevision, verifyHarness } from '@lobechat/agent-runtime';
import { describe, expect, it } from 'vitest';

import { captureOperationHarness, restoreOperationHarness } from '../harness';
import type { OperationCreationParams } from '../types';

const input = (): OperationCreationParams => ({
  agentConfig: { model: 'model', systemRole: 'Original instruction', apiKey: 'never-store' },
  appContext: { agentId: 'agent' },
  initialContext: { phase: 'user_input' } as any,
  modelRuntimeConfig: { model: 'model', provider: 'provider' },
  operationId: 'operation',
  operationSkillSet: {
    enabledPluginIds: [],
    skills: [{ identifier: 'skill', content: 'Original skill' } as any],
  },
  toolSet: { manifestMap: {}, tools: [] },
  userId: 'user',
});
describe('operation harness versions', () => {
  it('keeps full content, stable order, and no credential values', async () => {
    const source = input();
    const first = await captureOperationHarness(source);
    const second = await captureOperationHarness({
      ...source,
      agentConfig: {
        apiKey: 'different-secret',
        systemRole: 'Original instruction',
        model: 'model',
      },
    });
    expect(first.revision.id).toBe(second.revision.id);
    expect(JSON.stringify(first)).not.toContain('never-store');
    source.operationSkillSet!.skills[0].content = 'Concurrent edit';
    expect(JSON.stringify(first)).toContain('Original skill');
    expect((await captureOperationHarness(source)).revision.id).not.toBe(first.revision.id);
  });
  it('restores the old configuration after concurrent edits and serialization/resume', async () => {
    const pinned = await captureOperationHarness(input());
    const state = JSON.parse(
      JSON.stringify({
        metadata: { harness: pinned, agentId: 'agent', agentConfig: { systemRole: 'New default' } },
        operationToolSet: { executorMap: 'live-host-handle' },
      }),
    );
    await restoreOperationHarness(state, 'operation', 'user');
    expect(state.metadata.agentConfig.systemRole).toBe('Original instruction');
    expect(state.operationToolSet.executorMap).toBe('live-host-handle');
    expect(state.metadata.harnessRevisionId).toBe(pinned.revision.id);
    await expect(restoreOperationHarness(state, 'operation', 'another-user')).rejects.toThrow(
      'HARNESS_BINDING_MISMATCH',
    );
  });
  it('rejects altered snapshots and missing bound revisions; marks legacy state honestly', async () => {
    const pinned = JSON.parse(JSON.stringify(await captureOperationHarness(input())));
    pinned.revision.material.agentConfig.systemRole = 'tampered';
    await expect(
      restoreOperationHarness(
        { metadata: { harness: pinned, agentId: 'agent' } },
        'operation',
        'user',
      ),
    ).rejects.toThrow('HARNESS_REVISION_CORRUPT');
    await expect(
      restoreOperationHarness({ metadata: { harnessRevisionId: 'missing' } }, 'operation', 'user'),
    ).rejects.toThrow('HARNESS_REVISION_MISSING');
    const legacy = { metadata: {} };
    await restoreOperationHarness(legacy, 'old', 'user');
    expect(legacy.metadata).toEqual({ harnessTracking: 'legacy/unverified' });
  });
  it('browser and server use the same verifiable data contract', async () => {
    const scope = { userId: 'user', agentId: 'agent' };
    const revision = await createHarnessRevision(scope, {
      resolvedConfig: { systemRole: 'Hello' },
    });
    const browser = bindHarness(revision, 'local-run', 'client');
    await expect(
      verifyHarness(JSON.parse(JSON.stringify(browser)), scope, 'local-run'),
    ).resolves.toBeUndefined();
    await expect(verifyHarness(browser, scope, 'different-run')).rejects.toThrow();
  });
  it('keeps credential-named schema fields while rejecting injected credential values', async () => {
    const source = input();
    source.agentConfig.createdAt = new Date('2026-10-21T00:00:00.000Z');
    source.toolSet.tools = [
      {
        parameters: { properties: { apiKey: { type: 'string' }, constructor: { type: 'string' } } },
      },
    ];
    const pinned = await captureOperationHarness(source);
    expect((pinned.revision.material.agentConfig as any).createdAt).toBe(
      '2026-10-21T00:00:00.000Z',
    );
    expect(JSON.stringify(pinned.revision.material.toolCatalog)).toContain('apiKey');
    expect(JSON.stringify(pinned.revision.material.toolCatalog)).toContain('constructor');
    const changed = JSON.parse(JSON.stringify(pinned));
    changed.revision.material.agentConfig.apiKey = 'injected';
    await expect(verifyHarness(changed, pinned.revision.scope, 'operation')).rejects.toThrow(
      'HARNESS_REVISION_CORRUPT',
    );
  });
  it('pins baseline definitions while preserving host-admitted step activations on resume', async () => {
    const source = input();
    source.toolSet.tools = [{ function: { name: 'known', description: 'original definition' } }];
    const harness = await captureOperationHarness(source);
    const state: any = {
      metadata: { harness, agentId: 'agent' },
      operationToolSet: {
        enabledToolIds: ['activated'],
        tools: [
          { function: { name: 'known', description: 'concurrent replacement' } },
          { function: { name: 'activated', description: 'admitted during execution' } },
        ],
      },
    };
    await restoreOperationHarness(state, 'operation', 'user');
    expect(state.tools).toEqual([
      { function: { name: 'known', description: 'original definition' } },
      { function: { name: 'activated', description: 'admitted during execution' } },
    ]);
    expect(state.operationToolSet.enabledToolIds).toContain('activated');
    expect((harness.revision.material.toolCatalog as any).tools).toHaveLength(1);
  });
});
