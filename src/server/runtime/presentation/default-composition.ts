import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import { createPresentationArtifactAssetStoreBridge } from './asset-store';
import { FileCapabilityCapsuleStore } from './capability-memory';
import type {
  PresentationGenerationContextFactory,
  PresentationRuntimeComposition,
} from './composition';
import {
  createPresentationRouteJournalBindings,
  ScopedPresentationJobEventJournalCache,
} from './event-journal-cache';
import { FilePresentationStorage } from './file-storage';
import { persistGeneratedImageUrl } from './generated-image-storage';
import { createPresentationImageGenerationEventPublisher } from './image-event-bridge';
import { createImageGenerationCapability } from './image-generation-capability';
import { createLocalCorpusSeeder } from './local-corpus';
import { createResilientMultimodalChatPort } from './multimodal-chat-fallback';
import type { ProductionProviderReadiness } from './production-command';
import { PRODUCTION_PRESENTATION_ENV_KEYS } from './production-config';
import {
  createPptMasterProcessRunnerFactory,
  createProductionPresentationGenerationComposition,
} from './production-factory';
import {
  createProductionOpenAIImageGenerationPort,
  PRODUCTION_IMAGE_ENV_KEYS,
} from './production-image-config';
import { createPresentationChatFetch } from './resilient-fetch';
import { createProcessPresentationRunner } from './runner';
import { FileTeachingMemory } from './teaching-memory';
import { FilePresentationTemplateLibrary } from './templates';
import { createOpenAICompatibleAudioTranscriber } from './templates/audio-transcription';
import { PptMasterToolchain } from './toolchain';
import { FileTrialLearningStore } from './trial-learning';
import { FileTrialEvidenceStore, PresentationTrialReview } from './trial-review';
import { createProductionTrialWorkspace } from './trial-workspace-production';
import { createUserChatProvider } from './user-chat-provider';

let readiness: ProductionProviderReadiness | undefined;
let configurationError: unknown;
const createDefaultGenerationContextFactory = (
  pptMasterRoot: string,
  pythonCommand: string,
  quickGenerate = false,
): PresentationGenerationContextFactory => {
  const runnerId = 'ppt-master-generation-toolchain';
  const runner = createProcessPresentationRunner({
    command: [pythonCommand],
    declareArtifacts: (request) =>
      request.operation === 'export' ? ['exports/presentation.pptx'] : [],
    id: runnerId,
    maxArtifacts: 64,
  });
  const scriptsRoot = nodePath.join(pptMasterRoot, 'skills', 'ppt-master', 'scripts');
  const toolchain = new PptMasterToolchain({
    allowedRunnerIds: [runnerId],
    convertScriptPath: nodePath.join(scriptsRoot, 'svg_to_pptx.py'),
    providerCommand: [pythonCommand],
    pptMasterRoot,
    qualityScriptPath: nodePath.join(scriptsRoot, 'svg_quality_checker.py'),
    qualityArgs: [
      ...(quickGenerate ? ['--quick-generate'] : ['--canonical-authoring']),
      '--stage',
      'final',
      '--json',
    ],
    convertArgs: quickGenerate ? ['--quick-generate', '--with-notes'] : undefined,
    runner,
    runnerId,
    timeoutMs: 120_000,
    workspaceRoot: tmpdir(),
  });

  return (jobId) => {
    const safeJobId = jobId.replaceAll(/[^\w-]/g, '_');
    const workspacePath = nodePath.join(tmpdir(), `lobehub-presentation-generation-${safeJobId}`);
    return {
      plannerContext: {},
      workerContext: {
        convert: (path, signal) => toolchain.convert(path, signal),
        jobId,
        qualityCheck: (path, signal) => toolchain.qualityCheck(path, signal),
        workspace: {
          cleanup: () => rm(workspacePath, { force: true, recursive: true }),
          path: workspacePath,
          write: async (relativePath, content) => {
            const target = nodePath.join(workspacePath, relativePath);
            await mkdir(nodePath.dirname(target), { recursive: true });
            await writeFile(target, content);
          },
        },
      },
    };
  };
};

const assemble = (): PresentationRuntimeComposition | undefined => {
  const root = process.env.CORDIS_PPT_MASTER_ROOT;
  const runnerPath = process.env.CORDIS_PPT_RUNNER;
  // Chat credentials and selection are resolved per authenticated user, not at startup.
  const imageApiKey = process.env[PRODUCTION_IMAGE_ENV_KEYS.apiKey];

  // The generation pipeline calls the real checker/converter directly. The JSONL
  // runner is only required by the separate legacy binary port.
  if (!root) {
    return undefined;
  }
  const scriptsRoot = nodePath.join(root, 'skills', 'ppt-master', 'scripts');
  const converterPath = nodePath.join(scriptsRoot, 'svg_to_pptx.py');
  if (
    !existsSync(converterPath) ||
    !existsSync(nodePath.join(scriptsRoot, 'svg_quality_checker.py'))
  ) {
    configurationError = new Error('PPT Master checker and converter scripts are missing');
    return undefined;
  }

  const pptEnv: Readonly<Record<string, string | undefined>> = {
    [PRODUCTION_PRESENTATION_ENV_KEYS.provider]:
      process.env[PRODUCTION_PRESENTATION_ENV_KEYS.provider] ?? 'ppt-master',
    [PRODUCTION_PRESENTATION_ENV_KEYS.command]:
      process.env[PRODUCTION_PRESENTATION_ENV_KEYS.command] ??
      JSON.stringify([process.env.CORDIS_PPT_PYTHON ?? 'python3', runnerPath ?? converterPath]),
    [PRODUCTION_PRESENTATION_ENV_KEYS.runnerId]:
      process.env[PRODUCTION_PRESENTATION_ENV_KEYS.runnerId] ?? 'ppt-master-runner',
    [PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds]:
      process.env[PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds] ??
      JSON.stringify(['ppt-master-runner']),
    [PRODUCTION_PRESENTATION_ENV_KEYS.imageBudget]:
      process.env[PRODUCTION_PRESENTATION_ENV_KEYS.imageBudget],
  };

  const imgEnv = {
    [PRODUCTION_IMAGE_ENV_KEYS.apiKey]: imageApiKey,
    [PRODUCTION_IMAGE_ENV_KEYS.baseUrl]: process.env[PRODUCTION_IMAGE_ENV_KEYS.baseUrl],
    [PRODUCTION_IMAGE_ENV_KEYS.model]: process.env[PRODUCTION_IMAGE_ENV_KEYS.model],
  } as const;

  try {
    const dataRoot =
      process.env.CORDIS_PRESENTATION_DATA_DIR ??
      nodePath.join(process.cwd(), '.data', 'presentation');
    const artifactStore = new FilePresentationStorage(dataRoot);
    const assetStore = createPresentationArtifactAssetStoreBridge(artifactStore);
    const journalCache = new ScopedPresentationJobEventJournalCache({
      load: async (scope) => artifactStore.createJournal(scope),
    });
    const journalBindings = createPresentationRouteJournalBindings(journalCache);

    const resolveChatConnection = async (scope: RuntimeScope) => {
      const { getServerDB } = await import('@/database/core/db-adaptor');
      const { resolveUserChatProvider } = await import('@/server/services/modelProvider');
      return resolveUserChatProvider(await getServerDB(), scope.userId);
    };
    const multimodalChatPort = createResilientMultimodalChatPort(
      createUserChatProvider({
        fetcher: createPresentationChatFetch(globalThis.fetch),
        resolve: resolveChatConnection,
      }),
    );
    const visionModel = process.env.CORDIS_PRESENTATION_VISION_MODEL?.trim();
    const scopedVisionChatPort = visionModel
      ? createResilientMultimodalChatPort(
          createUserChatProvider({
            fetcher: createPresentationChatFetch(globalThis.fetch),
            resolve: async (scope) => ({
              ...(await resolveChatConnection(scope)),
              model: visionModel,
              supportsVision: true,
            }),
          }),
        )
      : multimodalChatPort;
    const visionChatPort = visionModel
      ? {
          ...scopedVisionChatPort,
          manifest: Object.freeze({ ...scopedVisionChatPort.manifest, model: visionModel }),
        }
      : scopedVisionChatPort;

    const imageGenerationCapability = imageApiKey
      ? createImageGenerationCapability({
          assetStore,
          eventPublisherFactory: async (scope, jobId) =>
            createPresentationImageGenerationEventPublisher({
              publisher: await journalBindings.generationEventPublisherFactory(
                scope,
                jobId,
                new Request('http://presentation.internal/image-generation'),
              ),
              scope,
            }),
          imagePort: createProductionOpenAIImageGenerationPort(imgEnv, {
            resolveAssetUri: (scope, uri, signal) =>
              persistGeneratedImageUrl(assetStore, scope, uri, globalThis.fetch, signal),
            readReferenceAsset: async (scope, ref) => {
              const artifact = await artifactStore.get(scope, ref);
              return artifact?.bytes && artifact.mimeType
                ? { bytes: artifact.bytes, mimeType: artifact.mimeType }
                : null;
            },
            assetSink: async ({ bytes, metadata, scope }) => {
              const artifactId = `image-${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
              const stored = await assetStore.put(scope, {
                asset: { ref: artifactId },
                bytes,
                idempotencyKey: artifactId,
                metadata,
              });
              return stored.asset;
            },
            fetcher: globalThis.fetch,
          }),
        })
      : undefined;

    const runnerFactory = createPptMasterProcessRunnerFactory({ pptMasterRoot: root });
    const contextFactory = createDefaultGenerationContextFactory(
      root,
      process.env.CORDIS_PPT_PYTHON ?? 'python3',
      process.env.CORDIS_PPT_AUTHORING_MODE === 'quick',
    );

    let audioTranscriber: ReturnType<typeof createOpenAICompatibleAudioTranscriber> | undefined;
    const transcriptionApiKey = process.env.OPENAI_API_KEY?.trim();
    const transcriptionBaseUrl = process.env.OPENAI_BASE_URL?.trim();
    if (transcriptionApiKey && transcriptionBaseUrl) {
      try {
        audioTranscriber = createOpenAICompatibleAudioTranscriber({
          apiKey: transcriptionApiKey,
          baseUrl: transcriptionBaseUrl,
          fetcher: globalThis.fetch,
          model: process.env.PRESENTATION_AUDIO_TRANSCRIPTION_MODEL,
        });
      } catch {
        // Optional STT must not make the presentation runtime unavailable.
      }
    }

    const capabilityMemory = new FileCapabilityCapsuleStore(
      nodePath.join(dataRoot, 'capability-memory'),
    );
    const templateLibrary = new FilePresentationTemplateLibrary({
      root: nodePath.join(dataRoot, 'templates'),
    });
    const trialEvidence = new FileTrialEvidenceStore(nodePath.join(dataRoot, 'trial-evidence'));
    const trialLearning = new FileTrialLearningStore({
      root: nodePath.join(dataRoot, 'trial-learning'),
      evidence: trialEvidence,
      storage: artifactStore,
    });
    const result = createProductionPresentationGenerationComposition({
      trialLearning,
      trialWorkspace: createProductionTrialWorkspace({
        budgets: async () => {
          const [{ getServerDB }, { withLearningBudget }] = await Promise.all([
            import('@/database/core/db-adaptor'),
            import('../improvement/production'),
          ]);
          return withLearningBudget(await getServerDB(), async (budget) => budget);
        },
        dataRoot,
        learning: trialLearning,
        storage: artifactStore,
        memory: capabilityMemory,
        // Raw transport: trials own their retries and reservation ledger.
        fetcher: globalThis.fetch,
        resolve: resolveChatConnection,
        visionModel,
      }),
      trialReview: new PresentationTrialReview(
        trialEvidence,
        artifactStore,
        artifactStore,
        trialLearning,
      ),
      teachingMemory: new FileTeachingMemory(nodePath.join(dataRoot, 'teaching-memory')),
      capabilityMemory,
      prepareCapabilityLibrary: process.env.CORDIS_PRESENTATION_LOCAL_CORPUS_USER_ID
        ? createLocalCorpusSeeder({
            sourceUserId: process.env.CORDIS_PRESENTATION_LOCAL_CORPUS_USER_ID,
            library: templateLibrary,
            store: artifactStore,
            memory: capabilityMemory,
          })
        : undefined,
      audioTranscriber,
      templateLibrary,
      artifactStore,
      jobRepository: artifactStore,
      planningContextFactory: async (scope) => {
        const [
          { getServerDB },
          { createPresentationContextServices },
          { createPresentationContextRuntime },
        ] = await Promise.all([
          import('@/database/core/db-adaptor'),
          import('./context-services'),
          import('./context-tools'),
        ]);
        const tools = createPresentationContextRuntime(
          createPresentationContextServices(await getServerDB(), scope.userId),
        );
        return { context: { tools }, dispose: () => tools.dispose() };
      },
      contextFactory,
      env: pptEnv,
      imageGenerationCapability,
      journalCache,
      multimodalChatPort,
      visionChatPort,
      runnerFactory,
    });

    if (readiness === undefined) {
      readiness = result.readiness;
    }

    return result.composition;
  } catch (error) {
    if (configurationError === undefined) {
      configurationError = error;
    }
    return undefined;
  }
};

const registry = globalThis as typeof globalThis & {
  __qingzhouPresentationRuntime?: {
    composition?: PresentationRuntimeComposition;
    readiness?: ProductionProviderReadiness;
    error?: unknown;
  };
};
/** Studio routes and channel tools share the same production assembly and scoped storage. */
export const getDefaultPresentationComposition = () => {
  if (!registry.__qingzhouPresentationRuntime) {
    const composition = assemble();
    registry.__qingzhouPresentationRuntime = { composition, readiness, error: configurationError };
  }
  return registry.__qingzhouPresentationRuntime;
};
