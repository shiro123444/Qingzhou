import type { ImageGenerationPort, RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { AtomicRuntime } from '../atomic-runtime';
import type { PresentationArtifactStore } from './artifact-store';
import type { PresentationAssetStore } from './asset-store';
import type { CapabilityMemory } from './capability-memory';
import type { PresentationContentCompiler } from './content-intent';
import {
  createPresentationConversationCapability,
  type PresentationConversationCapability,
} from './conversation-capability';
import {
  createPresentationRouteJournalBindings,
  type PresentationEventJournalScope,
  type PresentationGenerationEventPublisherFactory as JournalPublisherFactory,
  type PresentationJobEventJournalFactory,
  type PresentationJobEventJournalLoader,
  ScopedPresentationJobEventJournalCache,
} from './event-journal-cache';
import type { PresentationPortFactory } from './factory';
import type { PresentationJobRepository } from './file-storage';
import type { PresentationGenerationCapability } from './generation-capability';
import {
  handlePresentationGenerationRequest,
  type PresentationGenerationHttpResponse,
} from './generation-handler';
import {
  createPresentationGenerationPort,
  type PresentationGenerationPort,
} from './generation-port';
import {
  createImageGenerationCapability,
  type ImageGenerationCapability,
  type ImageGenerationEventPublisherFactory,
} from './image-generation-capability';
import type { MultimodalChatPort } from './multimodal-chat-provider';
import {
  createPresentationOutlineCapability,
  type PresentationOutlineCapability,
} from './outline-capability';
import type { PresentationPipelineContext } from './pipeline';
import type { PresentationRevisionAssetPlanner } from './revision-assets';
import type { FileTeachingMemory, TeachingLearning } from './teaching-memory';
import type { FilePresentationTemplateLibrary } from './templates';
import type { PresentationVisualCritic } from './visual-critic';
import type { PresentationVisualStoryboardPlanner } from './visual-storyboard';

export type PresentationGenerationContextFactory = (jobId: string) => PresentationPipelineContext;

export type PresentationRuntimeGenerationHandler = (
  request: Request,
  scope: RuntimeScope,
) => Promise<PresentationGenerationHttpResponse>;

export interface PresentationRuntimeCompositionOptions {
  readonly atomicRuntime?: AtomicRuntime;
  readonly capability?: PresentationGenerationCapability;
  readonly capabilityMemory?: CapabilityMemory;
  readonly contentCompiler?: PresentationContentCompiler;
  readonly contextFactory?: PresentationGenerationContextFactory;
  /** Artifact store used by the asynchronous `/jobs` generation bridge. */
  readonly generationArtifactStore?: PresentationArtifactStore;
  readonly generationCapability?: PresentationGenerationCapability;
  readonly generationContextFactory?: PresentationGenerationContextFactory;
  readonly imageGenerationAssetStore?: PresentationAssetStore;
  readonly imageGenerationCapability?: ImageGenerationCapability;
  readonly imageGenerationEventPublisherFactory?: ImageGenerationEventPublisherFactory;
  readonly imageGenerationPort?: ImageGenerationPort;
  readonly jobRepository?: PresentationJobRepository;
  readonly journalCache?: ScopedPresentationJobEventJournalCache;
  readonly journalLoader?: PresentationJobEventJournalLoader;
  readonly multimodalChatPort?: MultimodalChatPort;
  readonly now?: () => string;
  readonly portFactory?: PresentationPortFactory;
  readonly revisionAssetPlanner?: PresentationRevisionAssetPlanner;
  readonly teachingLearning?: TeachingLearning;
  readonly teachingMemory?: FileTeachingMemory;
  readonly templateLibrary?: FilePresentationTemplateLibrary;
  readonly visualCritic?: PresentationVisualCritic;
  readonly visualStoryboardPlanner?: PresentationVisualStoryboardPlanner;
}

export type PresentationRuntimeCompositionErrorCode =
  | 'PRESENTATION_COMPOSITION_DEPENDENCY_MISSING'
  | 'PRESENTATION_COMPOSITION_OPTIONS_INVALID';

export class PresentationRuntimeCompositionError extends Error {
  constructor(
    public readonly code: PresentationRuntimeCompositionErrorCode,
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'PresentationRuntimeCompositionError';
  }
}

export interface PresentationRuntimeComposition {
  readonly atomicRuntime?: AtomicRuntime;
  readonly conversationCapability?: PresentationConversationCapability;
  dispose: () => Promise<void>;
  readonly generationEventPublisherFactory: JournalPublisherFactory;
  readonly generationHandler: PresentationRuntimeGenerationHandler;
  /** Optional async legacy-port bridge; present when generation seams are complete. */
  readonly generationPortFactory?: (
    scope: RuntimeScope & { readonly request: Request },
  ) => PresentationGenerationPort;
  readonly imageGenerationCapability?: ImageGenerationCapability;
  readonly jobEventJournalFactory: PresentationJobEventJournalFactory;
  readonly multimodalChatPort?: MultimodalChatPort;
  readonly outlineCapability?: PresentationOutlineCapability;
  readonly portFactory?: PresentationPortFactory;
  reset: (scope?: PresentationEventJournalScope) => number;
  readonly revisionAssetPlanner?: PresentationRevisionAssetPlanner;
  readonly teachingLearning?: TeachingLearning;
  readonly templateLibrary?: FilePresentationTemplateLibrary;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (message: string, path: string): PresentationRuntimeCompositionError =>
  new PresentationRuntimeCompositionError(
    'PRESENTATION_COMPOSITION_OPTIONS_INVALID',
    message,
    path,
  );

const missing = (message: string, path: string): PresentationRuntimeCompositionError =>
  new PresentationRuntimeCompositionError(
    'PRESENTATION_COMPOSITION_DEPENDENCY_MISSING',
    message,
    path,
  );

const isCache = (value: unknown): value is ScopedPresentationJobEventJournalCache =>
  isRecord(value) &&
  typeof value.resolve === 'function' &&
  typeof value.reset === 'function' &&
  typeof value.dispose === 'function';

const isCapability = (value: unknown): value is PresentationGenerationCapability =>
  isRecord(value) && typeof value.execute === 'function';

const isImageGenerationCapability = (value: unknown): value is ImageGenerationCapability =>
  isRecord(value) && typeof value.generate === 'function';

const isImageGenerationPort = (value: unknown): value is ImageGenerationPort =>
  isRecord(value) && typeof value.generate === 'function';

const isImageGenerationAssetStore = (value: unknown): value is PresentationAssetStore =>
  isRecord(value) && typeof value.put === 'function';

const isPresentationArtifactStore = (value: unknown): value is PresentationArtifactStore =>
  isRecord(value) &&
  typeof value.get === 'function' &&
  typeof value.put === 'function' &&
  typeof value.remove === 'function';

const isMultimodalChatPort = (value: unknown): value is MultimodalChatPort =>
  isRecord(value) && typeof value.chat === 'function';

const createUnavailableCapability = (): PresentationGenerationCapability =>
  ({
    execute: async (): Promise<never> => {
      throw Object.assign(new Error('Presentation provider is not configured'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    },
  }) as unknown as PresentationGenerationCapability;

const createUnavailableContextFactory = (): PresentationGenerationContextFactory => () => {
  throw Object.assign(new Error('Presentation provider is not configured'), {
    code: 'PROVIDER_UNAVAILABLE',
  });
};

const firstFailure = async (actions: readonly (() => void | Promise<void>)[]): Promise<void> => {
  let failure: { readonly error: unknown } | undefined;
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      if (!failure) failure = { error };
    }
  }
  if (failure) throw failure.error;
};

export const createPresentationRuntimeComposition = (
  options: PresentationRuntimeCompositionOptions,
): PresentationRuntimeComposition => {
  if (!isRecord(options)) throw invalid('Composition options must be an object', 'options');
  const compositionOptions = options as PresentationRuntimeCompositionOptions;

  const capability = compositionOptions.capability ?? compositionOptions.generationCapability;
  if (compositionOptions.capability && compositionOptions.generationCapability) {
    throw invalid('Provide capability or generationCapability, not both', 'capability');
  }
  if (capability !== undefined && !isCapability(capability)) {
    throw invalid('capability must provide execute()', 'capability');
  }

  const imageGenerationCapability = compositionOptions.imageGenerationCapability;
  const imageGenerationAssetStore = compositionOptions.imageGenerationAssetStore;
  const imageGenerationEventPublisherFactory =
    compositionOptions.imageGenerationEventPublisherFactory;
  const imageGenerationPort = compositionOptions.imageGenerationPort;
  const hasImageGenerationDependencies =
    imageGenerationAssetStore !== undefined ||
    imageGenerationEventPublisherFactory !== undefined ||
    imageGenerationPort !== undefined;
  const hasCompleteImageGenerationDependencies =
    imageGenerationAssetStore !== undefined &&
    imageGenerationEventPublisherFactory !== undefined &&
    imageGenerationPort !== undefined;
  if (imageGenerationCapability !== undefined && hasImageGenerationDependencies) {
    throw invalid(
      'imageGenerationCapability cannot be combined with image generation dependencies',
      'imageGenerationCapability',
    );
  }
  if (
    imageGenerationCapability !== undefined &&
    !isImageGenerationCapability(imageGenerationCapability)
  ) {
    throw invalid('imageGenerationCapability must provide generate()', 'imageGenerationCapability');
  }

  const contextFactory =
    compositionOptions.contextFactory ?? compositionOptions.generationContextFactory;
  if (compositionOptions.contextFactory && compositionOptions.generationContextFactory) {
    throw invalid('Provide contextFactory or generationContextFactory, not both', 'contextFactory');
  }
  if (contextFactory !== undefined && typeof contextFactory !== 'function') {
    throw invalid('contextFactory must be a function', 'contextFactory');
  }

  if (
    compositionOptions.portFactory !== undefined &&
    typeof compositionOptions.portFactory !== 'function'
  ) {
    throw invalid('portFactory must be a function', 'portFactory');
  }
  if (compositionOptions.now !== undefined && typeof compositionOptions.now !== 'function') {
    throw invalid('now must be a function', 'now');
  }
  if (
    compositionOptions.generationArtifactStore !== undefined &&
    !isPresentationArtifactStore(compositionOptions.generationArtifactStore)
  ) {
    throw invalid(
      'generationArtifactStore must provide get()/put()/remove()',
      'generationArtifactStore',
    );
  }

  let resolvedImageGenerationCapability = imageGenerationCapability;
  if (hasCompleteImageGenerationDependencies) {
    if (!isImageGenerationPort(imageGenerationPort)) {
      throw invalid('imageGenerationPort must provide generate()', 'imageGenerationPort');
    }
    if (!isImageGenerationAssetStore(imageGenerationAssetStore)) {
      throw invalid('imageGenerationAssetStore must provide put()', 'imageGenerationAssetStore');
    }
    if (typeof imageGenerationEventPublisherFactory !== 'function') {
      throw invalid(
        'imageGenerationEventPublisherFactory must be a function',
        'imageGenerationEventPublisherFactory',
      );
    }
    resolvedImageGenerationCapability = createImageGenerationCapability({
      assetStore: imageGenerationAssetStore,
      eventPublisherFactory: imageGenerationEventPublisherFactory,
      imagePort: imageGenerationPort,
      ...(compositionOptions.now ? { now: compositionOptions.now } : {}),
    });
  }

  const journalCache = compositionOptions.journalCache;
  const journalLoader = compositionOptions.journalLoader;
  if (journalCache && journalLoader) {
    throw invalid('Provide journalCache or journalLoader, not both', 'journalCache');
  }
  if (journalCache !== undefined && !isCache(journalCache)) {
    throw invalid('journalCache must provide resolve/reset/dispose()', 'journalCache');
  }
  if (journalLoader !== undefined && typeof journalLoader !== 'function') {
    throw invalid('journalLoader must be a function', 'journalLoader');
  }
  const validatedJournalLoader: PresentationJobEventJournalLoader | undefined =
    typeof journalLoader === 'function' ? journalLoader : undefined;
  if (!journalCache && !validatedJournalLoader) {
    throw missing('A scoped journalCache or journalLoader is required', 'journalCache');
  }

  const cache =
    journalCache ?? new ScopedPresentationJobEventJournalCache({ load: validatedJournalLoader! });
  const bindings = createPresentationRouteJournalBindings(cache, {
    ...(compositionOptions.now ? { now: compositionOptions.now } : {}),
  });
  const resolvedCapability = capability ?? createUnavailableCapability();
  const resolvedContextFactory = contextFactory ?? createUnavailableContextFactory();
  const generationPorts = new Map<string, PresentationGenerationPort>();
  const generationPortFactory =
    capability && contextFactory && compositionOptions.generationArtifactStore
      ? (scope: RuntimeScope & { readonly request: Request }) => {
          const key = `${scope.userId}\u0000${scope.sessionId}`;
          const existing = generationPorts.get(key);
          if (existing) return existing;
          const port = createPresentationGenerationPort(
            {
              atomicRuntime: compositionOptions.atomicRuntime,
              contentCompiler: compositionOptions.contentCompiler,
              capabilityMemory: compositionOptions.capabilityMemory,
              templateLibrary: compositionOptions.templateLibrary,
              revisionAssetPlanner: compositionOptions.revisionAssetPlanner,
              visualStoryboardPlanner: compositionOptions.visualStoryboardPlanner,
              visualCritic: compositionOptions.visualCritic,
              artifactStore: compositionOptions.generationArtifactStore!,
              repository: compositionOptions.jobRepository,
              capability,
              contextFactory,
              eventPublisherFactory: bindings.generationEventPublisherFactory,
              ...(resolvedImageGenerationCapability
                ? { imageGenerationCapability: resolvedImageGenerationCapability }
                : {}),
              ...(compositionOptions.now ? { now: compositionOptions.now } : {}),
            },
            scope,
          );
          generationPorts.set(key, port);
          return port;
        }
      : undefined;
  const generationHandler: PresentationRuntimeGenerationHandler = (request, scope) =>
    handlePresentationGenerationRequest(
      request,
      scope,
      resolvedCapability,
      resolvedContextFactory,
      capability && contextFactory
        ? { generationEventPublisherFactory: bindings.generationEventPublisherFactory }
        : undefined,
    );

  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    const disposableImageCapability = resolvedImageGenerationCapability as
      | (ImageGenerationCapability & { readonly dispose?: () => void | Promise<void> })
      | undefined;
    disposePromise = firstFailure([
      () => cache.dispose(),
      ...[...generationPorts.values()].map((port) => () => port.dispose()),
      ...(capability && typeof capability.dispose === 'function'
        ? [() => capability.dispose()]
        : []),
      ...(compositionOptions.atomicRuntime
        ? [() => compositionOptions.atomicRuntime!.dispose()]
        : []),
      ...(disposableImageCapability?.dispose ? [() => disposableImageCapability.dispose!()] : []),
    ]);
    return disposePromise;
  };

  if (
    compositionOptions.multimodalChatPort !== undefined &&
    !isMultimodalChatPort(compositionOptions.multimodalChatPort)
  ) {
    throw invalid('multimodalChatPort must provide chat()', 'multimodalChatPort');
  }

  const conversationCapability = compositionOptions.multimodalChatPort
    ? createPresentationConversationCapability({ chat: compositionOptions.multimodalChatPort })
    : undefined;
  const outlineCapability = compositionOptions.multimodalChatPort
    ? createPresentationOutlineCapability({
        chat: compositionOptions.multimodalChatPort,
        teachingMemory: compositionOptions.teachingMemory,
      })
    : undefined;

  return {
    teachingLearning: compositionOptions.teachingLearning,
    atomicRuntime: compositionOptions.atomicRuntime,
    ...(conversationCapability ? { conversationCapability } : {}),
    generationEventPublisherFactory: bindings.generationEventPublisherFactory,
    generationHandler,
    ...(generationPortFactory ? { generationPortFactory } : {}),
    ...(resolvedImageGenerationCapability
      ? { imageGenerationCapability: resolvedImageGenerationCapability }
      : {}),
    jobEventJournalFactory: bindings.jobEventJournalFactory,
    ...(compositionOptions.multimodalChatPort
      ? { multimodalChatPort: compositionOptions.multimodalChatPort }
      : {}),
    ...(outlineCapability ? { outlineCapability } : {}),
    ...(compositionOptions.portFactory ? { portFactory: compositionOptions.portFactory } : {}),
    dispose,
    reset: (scope) => {
      if (scope) {
        const key = `${scope.userId}\u0000${scope.sessionId}`;
        generationPorts.delete(key);
      } else {
        generationPorts.clear();
      }
      return cache.reset(scope);
    },
  };
};
