import path from 'node:path';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import { AtomicRuntime } from '../atomic-runtime';
import type { LearningBudgetPort } from '../improvement/budget';
import { openLearningBudget } from '../improvement/production';
import { type CapabilityMemory, capabilityMemoryOperations } from './capability-memory';
import type { FilePresentationStorage, StoredPresentationJob } from './file-storage';
import { createMultimodalChatPort, type MultimodalChatFetcher } from './multimodal-chat-provider';
import { trialDigest, type TrialSettings } from './trial-configuration';
import { FileTrialLearningStore, type TrialLearningWriter } from './trial-learning';
import { TRIAL_POLICY_VERSION } from './trial-policy';
import { createRealTrialAdapters } from './trial-real-adapters';
import { FileTrialEvidenceStore } from './trial-review';
import { createTrialExecutionPlugin, RepresentativeTrialRunner } from './trial-runner';
import { SerialPresentationTrialRunner, type SerialTrialContext } from './trial-serial';
import { SERIAL_TRIAL_BUDGET } from './trial-serial';
import {
  HELDOUT_PAGE_BUDGET,
  type HeldoutPage,
  type HeldoutRunContext,
  PresentationTrialValidation,
} from './trial-validation';
import { PresentationTrialWorkspace, WORKSPACE_TRIAL_BUDGET } from './trial-workspace';
import { type UserChatConnection, userChatEndpoint } from './user-chat-provider';

/** Resolve credentials once per trial, then pin both concrete model bindings without retries. */
interface ProductionTrialOptions {
  budgets?: (scope: RuntimeScope) => Promise<LearningBudgetPort>;
  dataRoot: string;
  fetcher: MultimodalChatFetcher;
  learning?: TrialLearningWriter;
  memory: CapabilityMemory;
  resolve: (scope: RuntimeScope) => Promise<UserChatConnection>;
  storage: FilePresentationStorage;
  visionModel?: string;
}
export function createProductionTrialWorkspace(options: ProductionTrialOptions) {
  const evidence = new FileTrialEvidenceStore(path.join(options.dataRoot, 'trial-evidence'));
  const learning =
    options.learning ??
    new FileTrialLearningStore({
      root: path.join(options.dataRoot, 'trial-learning'),
      evidence,
      storage: options.storage,
    });
  const validation =
    learning instanceof FileTrialLearningStore
      ? new PresentationTrialValidation({
          root: path.join(options.dataRoot, 'trial-validation'),
          workerRoot: path.join(options.dataRoot, 'trial-tasks'),
          storage: options.storage,
          evidence,
          learning,
          createSession: async (scope, signal) => {
            const connection = Object.freeze({ ...(await options.resolve(scope)) });
            signal.throwIfAborted();
            const sessions: Awaited<ReturnType<typeof createProductionTrialSession>>[] = [];
            const runs: Promise<unknown>[] = [];
            return {
              run: (page, context) => {
                const task = (async () => {
                  const session = await createProductionTrialSession(
                    { ...options, learning },
                    scope,
                    page.source,
                    signal,
                    { connection, page, context },
                  );
                  sessions.push(session);
                  return session.runner.run(
                    { ...page.target, candidates: [{ id: 'candidate', patch: context.policy }] },
                    { scope, signal },
                  );
                })();
                runs.push(task);
                return task;
              },
              drain: async () => {
                await Promise.allSettled(runs);
                for (const session of sessions) {
                  await session.runner.drain();
                  await session.dispose();
                }
              },
            };
          },
        })
      : undefined;
  return new PresentationTrialWorkspace({
    root: path.join(options.dataRoot, 'trial-tasks'),
    storage: options.storage,
    evidence,
    learning,
    companion: validation,
    supportsSerial: true,
    createRunner: async (scope, source, signal, mode, executionId) => {
      if (mode !== 'serial')
        return createProductionTrialSession(
          { ...options, learning },
          scope,
          source,
          signal,
          undefined,
          undefined,
          executionId,
        );
      const connection = Object.freeze({ ...(await options.resolve(scope)) });
      signal.throwIfAborted();
      const sessions: Awaited<ReturnType<typeof createProductionTrialSession>>[] = [];
      const runner = new SerialPresentationTrialRunner({
        root: path.join(options.dataRoot, 'trial-serial'),
        createRunner: async (context) => {
          const session = await createProductionTrialSession(
            { ...options, learning },
            scope,
            source,
            signal,
            undefined,
            { ...context, connection },
            executionId,
          );
          sessions.push(session);
          return session.runner;
        },
      });
      return {
        runner,
        dispose: async () => {
          for (const session of sessions) await session.dispose();
        },
      };
    },
  });
}

async function createProductionTrialSession(
  options: ProductionTrialOptions,
  scope: RuntimeScope,
  source: StoredPresentationJob,
  signal: AbortSignal,
  heldout?: { connection: UserChatConnection; page: HeldoutPage; context: HeldoutRunContext },
  serial?: SerialTrialContext & { connection: UserChatConnection },
  executionId?: string,
) {
  const budgetPort = options.budgets ? await options.budgets(scope) : undefined;
  const childId = heldout
    ? `validation:${trialDigest(heldout.page.target)}`
    : serial
      ? `round:${serial.round}`
      : 'trial';
  const childLimit = heldout ? HELDOUT_PAGE_BUDGET : WORKSPACE_TRIAL_BUDGET;
  const rootLimit = heldout
    ? { maxTokens: 80000, maxCostMicros: 3500000 }
    : serial
      ? SERIAL_TRIAL_BUDGET
      : WORKSPACE_TRIAL_BUDGET;
  const binding = budgetPort
    ? (
        await openLearningBudget(
          budgetPort,
          {
            userId: scope.userId!,
            subject: {
              kind: 'presentation',
              jobId: heldout?.context.budgetSubjectJobId ?? source.job.jobId,
              sessionId: scope.sessionId!,
            },
          },
          heldout
            ? `presentation-validation:${heldout.context.validationId}`
            : `presentation:${executionId ?? serial?.id ?? source.job.jobId}`,
          {
            calls: heldout ? 4 : serial ? 6 : 3,
            tokens: rootLimit.maxTokens,
            costMicros: rootLimit.maxCostMicros,
          },
          {
            [childId]: {
              calls: heldout ? 2 : 3,
              tokens: childLimit.maxTokens,
              costMicros: childLimit.maxCostMicros,
            },
          },
        )
      )[childId]
    : undefined;
  await binding?.assertActive();
  const connection = heldout?.connection ?? serial?.connection ?? (await options.resolve(scope));
  signal.throwIfAborted();
  if (!options.visionModel && !connection.supportsVision)
    throw Object.assign(new Error('Vision model required'), { code: 'TRIAL_VISION_REQUIRED' });
  const bind = (model: string) => {
    const endpoint = userChatEndpoint(connection.baseURL);
    return {
      port: createMultimodalChatPort({
        apiKey: connection.apiKey,
        endpoint,
        providerId: connection.provider,
        model,
        fetcher: options.fetcher,
        allowRequestModelOverride: false,
      }),
      configurationDigest: trialDigest({ endpoint, model, provider: connection.provider }),
    };
  };
  const planner = bind(connection.model),
    observer = bind(options.visionModel ?? connection.model);
  const adapters = createRealTrialAdapters({
    version: 'workspace-page-probe-v3',
    evaluatorVersion: 'anonymous-visual-v1',
    planner,
    observer,
  });
  const model = (binding: typeof planner, maxOutputTokens: number) => ({
    providerId: binding.port.manifest.providerId,
    model: binding.port.manifest.model,
    configurationDigest: binding.configurationDigest,
    maxOutputTokens,
    temperature: 0,
  });
  const settings: TrialSettings = {
    schemaVersion: 1,
    imageGeneration: false,
    executorVersion: adapters.version,
    rendererVersion: adapters.rendererVersion,
    recipe: {
      id: 'workspace-page-layout-v1',
      instructions:
        '保留原页面的全部原文、讲稿、事实、配色和风格。改善文字分组、层级与布局；控制行宽、容器、下一段和页面边界，不得缩字、裁剪或省略内容。仅返回一页可编辑 SVG。',
    },
    models: { planner: model(planner, 7000), observer: model(observer, 4000) },
    frozenInputs: heldout
      ? {
          validation: {
            validationId: heldout.context.validationId,
            manifestDigest: heldout.context.manifestDigest,
            protocol: 'two-task-heldout-v1',
          },
        }
      : serial
        ? { serial: { id: serial.id, round: serial.round, protocol: 'bounded-serial-v1' } }
        : {},
    baselineCapsuleIds: Array.isArray(source.plan?.designSpec?.learnedCapabilityIds)
      ? (source.plan.designSpec.learnedCapabilityIds as string[])
      : [],
    ...(heldout
      ? {}
      : {
          proposal: {
            version: TRIAL_POLICY_VERSION,
            allowance: { tokens: 8000, costMicros: 250_000 },
          },
        }),
    probeAllowance: { tokens: 16_000, costMicros: 750_000 },
    evaluation: {
      version: adapters.evaluatorVersion,
      allowance: { tokens: 24_000, costMicros: 1_000_000 },
      visualConstraints:
        '保持原稿的事实、文字、讲稿、配色和整体风格；检查原画布内的正文可读性、层级、构图与边界。',
    },
  };
  const runtime = new AtomicRuntime([
    {
      id: 'presentation',
      version: 'workspace-memory-v1',
      operations: capabilityMemoryOperations(options.memory).map((operation) => {
        if (operation.name !== 'presentation.memory.compose' || !serial?.baseline) return operation;
        const frozen = serial.baseline.capsules;
        return {
          ...operation,
          execute: ({ ids }: { ids: string[] }) => {
            const capsules = ids.map((id) => frozen.find((capsule) => capsule.id === id));
            if (capsules.some((capsule) => !capsule)) throw new Error('Frozen capability missing');
            return { capsules: structuredClone(capsules) };
          },
        };
      }),
    },
    createTrialExecutionPlugin(adapters),
  ]);
  const runner = new RepresentativeTrialRunner({
    runtime,
    repository: {
      getJob: async (_scope, jobId) =>
        jobId === source.job.jobId ? structuredClone(source) : null,
    },
    artifacts:
      heldout || serial?.baseline
        ? {
            get: async (_scope, artifactId) => {
              const asset = (heldout?.page.assets ?? serial!.baseline!.sourceAssets).find(
                (item) =>
                  item.ref ===
                    `/api/runtime/presentation/artifacts/${encodeURIComponent(artifactId)}` ||
                  item.ref ===
                    `/api/runtime/presentation/artifacts/${encodeURIComponent(artifactId)}?raw=true`,
              );
              return asset
                ? {
                    artifactId,
                    name: artifactId,
                    type: 'image',
                    mimeType: asset.mimeType,
                    bytes: Buffer.from(asset.base64, 'base64'),
                    metadata: asset.metadata,
                    createdAt: source.job.createdAt,
                    status: 'ready' as const,
                  }
                : null;
            },
          }
        : options.storage,
    root: path.join(options.dataRoot, 'trial-runs'),
    learningBudget: binding,
    budget: heldout
      ? HELDOUT_PAGE_BUDGET
      : { ...WORKSPACE_TRIAL_BUDGET, maxRenders: serial?.incumbent ? 3 : 2 },
    ...(serial?.incumbent ? { incumbent: serial.incumbent } : {}),
    ...(serial?.priorAttempt ? { priorAttempt: serial.priorAttempt } : {}),
    settings: () => settings,
    proposalExperiences: heldout
      ? undefined
      : async (scope, source, slideId) =>
          serial?.experiences ??
          options.learning?.proposalExperiences?.(scope, source.job.jobId, slideId) ??
          [],
  });
  return { runner, dispose: () => runtime.dispose() };
}
