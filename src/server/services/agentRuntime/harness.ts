import {
  bindHarness,
  bindHarnessRun,
  composeHarnessPrompt,
  createHarnessRevision,
  type HarnessPublicationRef,
  type HarnessRevision,
  type PinnedHarness,
  resolveHarnessMaterial,
  verifyHarness,
  verifyHarnessRevision,
} from '@lobechat/agent-runtime';

import { skillMaterialBinding } from '@/server/runtime/improvement/skill-material';

import type { OperationCreationParams } from './types';

/** Persisted inside the existing operation state; contains data, never executable tool handles. */
export async function captureOperationHarness(
  input: OperationCreationParams,
  verifiedImplementation = true,
): Promise<PinnedHarness> {
  const toolCatalog = {
    enabledToolIds: input.toolSet.enabledToolIds ?? [],
    manifestMap: input.toolSet.manifestMap,
    sourceMap: input.toolSet.sourceMap ?? {},
    tools: input.toolSet.tools ?? [],
  };
  const source = input.harnessSource;
  if (source) {
    // Touching a conversation must not redefine behavior. The database generation
    // still records semantic edits, including edits that restore the same text.
    const {
      createdAt: _created,
      updatedAt: _updated,
      accessedAt: _accessed,
      ...authorConfig
    } = source.agentConfig;
    if (
      composeHarnessPrompt(source.promptSegments) !== (input.agentConfig?.systemRole ?? '') ||
      source.promptSegments.find((segment) => segment.kind === 'author')?.content !==
        (source.agentConfig.systemRole ?? '')
    )
      throw new Error('HARNESS_SOURCE_PROVENANCE_MISMATCH');
    const revision = await createHarnessRevision(
      { userId: input.userId || 'anonymous', agentId: input.appContext.agentId || 'default' },
      {
        implementation: verifiedImplementation
          ? 'qingzhou-agent-runtime-v2'
          : 'custom-agent-unverified',
        contextPolicy: {
          skillMaterial: skillMaterialBinding(undefined),
          promptStrategy: process.env.QINGZHOU_CONTEXT_STRATEGY || 'standard',
          version: 1,
        },
        agentConfig: authorConfig,
        authoringSystemRole: source.agentConfig.systemRole ?? '',
        skillVersions: source.skillVersions ?? [],
        agentDocuments: input.agentDocuments ?? null,
        configurationComplete:
          verifiedImplementation &&
          input.agentDocuments !== undefined &&
          input.operationSkillSet !== undefined &&
          !!source.agentConfig.model &&
          !!source.agentConfig.provider,
        modelRuntimeConfig: {
          model: source.agentConfig.model ?? null,
          provider: source.agentConfig.provider ?? null,
        },
        operationSkillSet: {
          skills: input.operationSkillSet?.skills ?? [],
          enabledPluginIds: source.agentConfig.plugins ?? [],
        },
      },
      2,
    );
    return bindHarnessRun(revision, input.operationId, {
      sourceRevisionId: revision.id,
      agentConfig: input.agentConfig ?? {},
      modelRuntimeConfig: input.modelRuntimeConfig ?? {},
      operationSkillSet: input.operationSkillSet ?? { enabledPluginIds: [], skills: [] },
      toolCatalog,
      promptSegments: source.promptSegments,
      executionInput: {
        appContext: input.appContext,
        initialContext: input.initialContext,
        messages: input.initialMessages ?? [],
        activeDeviceId: input.activeDeviceId ?? null,
        deviceSystemInfo: input.deviceSystemInfo ?? null,
        userTimezone: input.userTimezone ?? null,
        userMemory: input.userMemory ?? null,
      },
    });
  }
  // Legacy/custom entry points have no segment provenance. Keep their wire format,
  // but do not register this composed configuration as a reusable behavior source.
  const revision = await createHarnessRevision(
    { userId: input.userId || 'anonymous', agentId: input.appContext.agentId || 'default' },
    {
      implementation: verifiedImplementation
        ? 'qingzhou-agent-runtime-v1'
        : 'custom-agent-unverified',
      contextPolicy: {
        promptStrategy: process.env.QINGZHOU_CONTEXT_STRATEGY || 'standard',
        version: 1,
      },
      agentConfig: input.agentConfig ?? {},
      authoringSystemRole: input.sourceSystemRole ?? input.agentConfig?.systemRole ?? '',
      agentDocuments: input.agentDocuments ?? null,
      configurationComplete:
        verifiedImplementation &&
        input.agentDocuments !== undefined &&
        input.operationSkillSet !== undefined,
      modelRuntimeConfig: input.modelRuntimeConfig ?? {},
      operationSkillSet: input.operationSkillSet ?? { enabledPluginIds: [], skills: [] },
      toolCatalog,
    },
  );
  return bindHarness(revision, input.operationId, 'server');
}

/** Adopt only compatible behavior; keep this operation's inputs and host constraints. */
export async function bindOperationBehavior(
  captured: PinnedHarness,
  revision: HarnessRevision,
  publicationRef?: HarnessPublicationRef,
): Promise<PinnedHarness> {
  if (!captured.snapshot || revision.schemaVersion !== 2)
    throw new Error('HARNESS_SNAPSHOT_REQUIRED');
  await verifyHarness(captured, revision.scope, captured.binding.operationId);
  await verifyHarnessRevision(revision, captured.revision.scope);
  const sourceModel = revision.material.modelRuntimeConfig as Record<string, unknown>;
  const runModel = captured.snapshot.material.modelRuntimeConfig as Record<string, unknown>;
  // An override is local to the run and must neither use nor clear incompatible adoption.
  const compatible =
    sourceModel.model === runModel.model && sourceModel.provider === runModel.provider;
  const selected = compatible ? revision : captured.revision;
  return bindHarnessRun(
    selected,
    captured.binding.operationId,
    { ...captured.snapshot.material, publicationRef: compatible ? (publicationRef ?? null) : null },
    captured.binding.source,
  );
}

/** Restore only immutable configuration. Live permissions, tool handles and step-local state stay live. */
export async function restoreOperationHarness(
  state: any,
  operationId: string,
  userId: string,
): Promise<void> {
  const metadata = state.metadata ?? {};
  const pinned = metadata.harness as PinnedHarness | undefined;
  if (!pinned) {
    if (metadata.harnessRevisionId) throw new Error('HARNESS_REVISION_MISSING');
    metadata.harnessTracking = 'legacy/unverified';
    state.metadata = metadata;
    return;
  }
  await verifyHarness(
    pinned,
    { userId: userId || 'anonymous', agentId: metadata.agentId || 'default' },
    operationId,
  );
  const material = resolveHarnessMaterial(pinned);
  metadata.agentConfig = material.agentConfig;
  metadata.modelRuntimeConfig = material.modelRuntimeConfig;
  metadata.operationSkillSet = material.operationSkillSet;
  metadata.pinnedAgentDocuments = material.agentDocuments;
  metadata.harnessTracking =
    material.configurationComplete === false ? 'partial/unverified' : 'server';
  metadata.harnessRevisionId = pinned.revision.id;
  metadata.harnessSnapshotId = pinned.snapshot?.id;
  state.modelRuntimeConfig = material.modelRuntimeConfig;
  // Executor functions are host-owned; only restore the catalog used for context construction.
  const catalog = material.toolCatalog as Record<string, any>;
  const live = state.operationToolSet ?? {};
  const name = (tool: any) => tool.function?.name ?? tool.name ?? JSON.stringify(tool);
  const pinnedNames = new Set((catalog.tools ?? []).map(name));
  // Baseline definitions stay pinned; host-admitted step activations are execution state.
  const resolved = {
    ...live,
    ...catalog,
    enabledToolIds: [
      ...new Set([...(catalog.enabledToolIds ?? []), ...(live.enabledToolIds ?? [])]),
    ],
    manifestMap: { ...live.manifestMap, ...catalog.manifestMap },
    sourceMap: { ...live.sourceMap, ...catalog.sourceMap },
    tools: [
      ...(catalog.tools ?? []),
      ...(live.tools ?? []).filter((tool: any) => !pinnedNames.has(name(tool))),
    ],
  };
  state.operationToolSet = resolved;
  state.tools = resolved.tools;
  state.toolManifestMap = resolved.manifestMap;
  state.toolSourceMap = resolved.sourceMap;
  state.metadata = metadata;
}
