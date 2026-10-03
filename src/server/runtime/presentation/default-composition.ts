import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

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
import { createPresentationImageGenerationEventPublisher } from './image-event-bridge';
import { createImageGenerationCapability } from './image-generation-capability';
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
import { createUserChatProvider } from './user-chat-provider';

let readiness: ProductionProviderReadiness | undefined;
let configurationError: unknown;
const createDefaultGenerationContextFactory = (
  pptMasterRoot: string,
  pythonCommand: string,
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
    qualityArgs: ['--canonical-authoring', '--stage', 'final', '--json'],
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

    const multimodalChatPort = createResilientMultimodalChatPort(
      createUserChatProvider({
        fetcher: createPresentationChatFetch(globalThis.fetch),
        resolve: async (scope) => {
          const { getServerDB } = await import('@/database/core/db-adaptor');
          const { resolveUserChatProvider } = await import('@/server/services/modelProvider');
          return resolveUserChatProvider(await getServerDB(), scope.userId);
        },
      }),
    );

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

    const result = createProductionPresentationGenerationComposition({
      teachingMemory: new FileTeachingMemory(nodePath.join(dataRoot, 'teaching-memory')),
      capabilityMemory: new FileCapabilityCapsuleStore(
        nodePath.join(dataRoot, 'capability-memory'),
      ),
      audioTranscriber,
      templateLibrary: new FilePresentationTemplateLibrary({
        root: nodePath.join(dataRoot, 'templates'),
      }),
      artifactStore,
      jobRepository: artifactStore,
      contextFactory,
      env: pptEnv,
      imageGenerationCapability,
      journalCache,
      multimodalChatPort,
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

let loaded = false;
let composition: PresentationRuntimeComposition | undefined;
/** Studio routes and channel tools share the same production assembly and scoped storage. */
export const getDefaultPresentationComposition = () => {
  if (!loaded) {
    composition = assemble();
    loaded = true;
  }
  return { composition, readiness, error: configurationError };
};
