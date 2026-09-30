/**
 * C-33 PresentationPort production factory adapter.
 *
 * Assembles a kernel `PptMasterAdapter` per authenticated
 * `{ userId, sessionId, serverDB, request }` scope. Assembly-only guarantees:
 *
 * - `runner`, `provider`, `allowedRunnerIds`, `workspaceFactory` and
 *   `buildArgs` are all explicitly injected through the options; the factory
 *   itself never launches an external command, never touches the database
 *   (serverDB is opaque scope passthrough) and never executes a provider —
 *   provider execution only ever happens later through the returned port's
 *   own methods, driven by the kernel adapter;
 * - every resolve creates an independent adapter instance per scope: no
 *   state is shared between scopes, and the factory holds no global state;
 * - the returned port carries an idempotent `dispose()` lifecycle hook (also
 *   mirrored on the binding) which awaits an optionally injected `onDispose`
 *   callback — resources can be released by the deployer without the factory
 *   inventing cleanup behavior;
 * - missing/invalid scope fields or provider config fail with stable
 *   `PRESENTATION_INVALID` / `PROVIDER_UNAVAILABLE` /
 *   `PRESENTATION_RUNNER_NOT_ALLOWED` codes. Nothing is ever fabricated to
 *   `ready`/`completed`.
 */
import type {
  PresentationArgsBuilder,
  PresentationBinaryPort,
  PresentationPort,
  PresentationRunner,
  PresentationWorkspaceFactory,
} from '../../../../packages/cordis-kernel/src/presentation';
import {
  PptMasterAdapter,
  PresentationError,
} from '../../../../packages/cordis-kernel/src/presentation';
import type { PresentationPlanner, RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { AtomicRuntime } from '../atomic-runtime';
import { runSkillSteps } from '../skills-plugin';
import {
  InMemoryPresentationArtifactStore,
  type PresentationArtifactStore,
} from './artifact-store';
import {
  type CutoutTransparency,
  requestsCutout,
  verifyCutoutTransparency,
} from './artwork-pipeline';
import { atomicPlanner, atomicWorker, createPresentationAtomicRuntime } from './atomic-plugin';
import { type CapabilityMemory, capabilityMemoryOperations } from './capability-memory';
import {
  createPresentationRuntimeComposition,
  type PresentationGenerationContextFactory,
  type PresentationRuntimeComposition,
} from './composition';
import {
  createPresentationContentCompiler,
  type PresentationContentCompiler,
} from './content-intent';
import type {
  PresentationJobEventJournalLoader,
  ScopedPresentationJobEventJournalCache,
} from './event-journal-cache';
import type { PresentationJobRepository } from './file-storage';
import { createPresentationGenerationCapability } from './generation-capability';
import type { ImageGenerationCapability } from './image-generation-capability';
import { PresentationJobEventJournal } from './job-event-journal';
import type { MultimodalChatPort } from './multimodal-chat-provider';
import { createMultimodalPresentationPlanner } from './multimodal-planner';
import { createPresentationGenerationPipeline } from './pipeline';
import type {
  ProductionPresentationProvider,
  ProductionPresentationProviderOptions,
  ProductionProviderReadiness,
} from './production-command';
import {
  createProductionPresentationProvider,
  resolveProviderReadiness,
} from './production-command';
import type { ProductionPresentationEnv } from './production-config';
import { loadProductionPresentationProviderOptions } from './production-config';
import { createRevisionAssetPlanner } from './revision-assets';
import { createProcessPresentationRunner, type ProcessPresentationRunnerOptions } from './runner';
import type { FileTeachingMemory } from './teaching-memory';
import { TeachingLearning } from './teaching-memory';
import type { FilePresentationTemplateLibrary } from './templates';
import type { PresentationAudioTranscriber } from './templates/audio-transcription';
import { TemplateVisualLearning } from './templates/visual-learning';
import { createPresentationVisualCritic } from './visual-critic';
import { createPresentationVisualStoryboardPlanner } from './visual-storyboard';
import { InMemoryPresentationPlanWorker, type PresentationWorkerWorkspace } from './worker';

/** The authenticated scope every port resolution must carry. */
export interface PptMasterPresentationScope {
  readonly request: Request;
  /** Opaque database handle; scope passthrough only, never read here. */
  readonly serverDB: unknown;
  readonly sessionId: string;
  readonly userId: string;
}

export type PptMasterDisposeHook = (
  port: PresentationPort,
  scope: PptMasterPresentationScope,
) => void | Promise<void>;

export interface PptMasterPortFactoryOptions {
  /**
   * Explicit runner allow-list. When omitted it defaults to `[runner.id]`
   * (kernel semantics); a runner id outside the list fails construction.
   */
  readonly allowedRunnerIds?: readonly string[];
  /** Explicit argv builder for the runner command — no built-in default here. */
  readonly buildArgs?: PresentationArgsBuilder;
  readonly idFactory?: () => string;
  readonly maxOutputBytes?: number;
  /** Determinism hooks for tests; otherwise kernel defaults apply. */
  readonly now?: () => string;
  /** Awaited by the returned port's `dispose()`; inject real resource cleanup. */
  readonly onDispose?: PptMasterDisposeHook;
  /** Explicit provider identifier; required. */
  readonly provider: string;
  /** Explicit runner implementation; required, structurally validated. */
  readonly runner: PresentationRunner;
  readonly timeoutMs?: number;
  /** Explicit workspace strategy (temp dirs, cleanup) — no built-in default here. */
  readonly workspaceFactory?: PresentationWorkspaceFactory;
}

export interface PptMasterPresentationPortBinding {
  /** Idempotent lifecycle hook; awaits the injected `onDispose` once. */
  dispose: () => Promise<void>;
  /** Kernel adapter delegate; carries the six port methods plus `dispose()`. */
  readonly port: PresentationBinaryPort & { readonly dispose: () => Promise<void> };
  /** Echoes the authenticated scope the port was assembled for. */
  readonly scope: PptMasterPresentationScope;
}

/** Explicit runner assembly seam for a production provider command. */
export type ProductionPresentationRunnerFactory = (
  provider: ProductionPresentationProvider,
) => PresentationRunner;

export interface PptMasterProductionPortFactoryOptions extends Omit<
  PptMasterPortFactoryOptions,
  'allowedRunnerIds' | 'buildArgs' | 'provider' | 'runner'
> {
  /** Command/provider/allow-list configuration is never inferred. */
  readonly productionProvider: ProductionPresentationProviderOptions;
  /** Runner construction is injected so tests never spawn a real process. */
  readonly runnerFactory: ProductionPresentationRunnerFactory;
}

export interface PptMasterProductionPresentationCompositionOptions extends Omit<
  PptMasterPortFactoryOptions,
  'allowedRunnerIds' | 'buildArgs' | 'provider' | 'runner'
> {
  /** Explicit deployment environment; process.env is never read here. */
  readonly env: ProductionPresentationEnv;
  /** Creates the injected runner; the composition never calls spawn(). */
  readonly runnerFactory: ProductionPresentationRunnerFactory;
}

export interface PptMasterProductionPresentationComposition {
  /** Resolves an independent PresentationPort binding for each authenticated scope. */
  readonly portFactory: (scope: PptMasterPresentationScope) => PptMasterPresentationPortBinding;
  /** Safe C-73 projection; command and secret-bearing options stay private. */
  readonly readiness: ProductionProviderReadiness;
}

export type PptMasterProductionCompositionOptions =
  PptMasterProductionPresentationCompositionOptions;
export type PptMasterProductionComposition = PptMasterProductionPresentationComposition;

/** Options for the real JSONL ppt-master worker adapter. */
export interface PptMasterProcessRunnerFactoryOptions extends Omit<
  ProcessPresentationRunnerOptions,
  'command' | 'commandArgs' | 'id' | 'stdinBuilder'
> {
  /** Absolute ppt-master checkout consumed by the external worker. */
  readonly pptMasterRoot: string;
}

/**
 * Builds a production runner factory from an already validated provider.
 * The provider command remains argv-only; the worker payload is sent through
 * stdin only when a job is actually spawned. No process is started here.
 */
export const createPptMasterProcessRunnerFactory = (
  options: PptMasterProcessRunnerFactoryOptions,
): ProductionPresentationRunnerFactory => {
  if (!nonEmptyString(options?.pptMasterRoot)) {
    throw invalid('pptMasterRoot must be a non-empty string', 'pptMasterRoot');
  }
  return (provider) =>
    createProcessPresentationRunner({
      ...options,
      id: provider.runnerId ?? provider.provider ?? 'ppt-master-runner',
      command: provider.command,
      commandArgs: provider.commandArgs,
      stdinBuilder: async (request) => {
        let input: Record<string, unknown> = {};
        if (request.inputArtifact) {
          try {
            const decoded = new TextDecoder().decode(request.inputArtifact.bytes);
            const parsed: unknown = JSON.parse(decoded);
            if (isRecord(parsed)) input = parsed;
          } catch {
            throw new PresentationError(
              'PRESENTATION_INVALID',
              'input artifact is not valid JSON',
              {
                jobId: request.jobId,
                path: 'inputArtifact',
              },
            );
          }
        }
        const payload = {
          ...input,
          jobId: request.jobId,
          projectDir: request.cwd,
          // The checkout path is deployment-owned; never accept it from the
          // client-provided PresentationJobInput.options object.
          pptMasterRoot: options.pptMasterRoot,
          aspectRatio: input.aspectRatio ?? '16:9',
          slides: input.slideCount ?? 1,
          prompt: input.prompt ?? input.title ?? '清舟演示文稿',
        };
        return `${JSON.stringify(payload)}\n`;
      },
    });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isPresentationRunner = (value: unknown): value is PresentationRunner =>
  isRecord(value) && nonEmptyString(value.id) && typeof value.spawn === 'function';

const invalid = (message: string, path: string): PresentationError =>
  new PresentationError('PRESENTATION_INVALID', message, { path });

/** Validates the injected provider configuration once, at factory creation. */
const validateFactoryOptions = (options: PptMasterPortFactoryOptions): void => {
  if (!options || typeof options !== 'object') {
    throw invalid('PptMasterPortFactoryOptions must be provided', 'options');
  }
  if (!nonEmptyString(options.provider)) {
    throw invalid('provider must be a non-empty string', 'provider');
  }
  if (!isPresentationRunner(options.runner)) {
    throw new PresentationError(
      'PROVIDER_UNAVAILABLE',
      'runner must provide a PresentationRunner (id + spawn)',
      { path: 'runner' },
    );
  }
  if (options.allowedRunnerIds !== undefined) {
    if (
      !Array.isArray(options.allowedRunnerIds) ||
      options.allowedRunnerIds.some((id) => !nonEmptyString(id))
    ) {
      throw invalid('allowedRunnerIds must be a string array', 'allowedRunnerIds');
    }
    if (!options.allowedRunnerIds.includes(options.runner.id)) {
      throw new PresentationError(
        'PRESENTATION_RUNNER_NOT_ALLOWED',
        `Runner is not allow-listed: ${options.runner.id}`,
        { path: 'runner' },
      );
    }
  }
};

const validateScope = (scope: PptMasterPresentationScope): void => {
  if (!isRecord(scope)) {
    throw invalid('An authenticated session scope is required', 'scope');
  }
  if (!nonEmptyString(scope.userId)) {
    throw invalid('userId must be a non-empty string', 'userId');
  }
  if (!nonEmptyString(scope.sessionId)) {
    throw invalid('sessionId must be a non-empty string', 'sessionId');
  }
  if (scope.serverDB === undefined || scope.serverDB === null) {
    throw invalid('serverDB must be provided', 'serverDB');
  }
  if (!(scope.request instanceof Request)) {
    throw invalid('request must be a valid Request', 'request');
  }
};

/**
 * Builds the per-scope port factory. Creation validates configuration only —
 * nothing external runs until the returned port's methods are used.
 */
export const createPptMasterPresentationPortFactory = (
  options: PptMasterPortFactoryOptions,
): ((scope: PptMasterPresentationScope) => PptMasterPresentationPortBinding) => {
  validateFactoryOptions(options);
  const {
    provider,
    runner,
    allowedRunnerIds,
    workspaceFactory,
    buildArgs,
    timeoutMs,
    maxOutputBytes,
    now,
    idFactory,
    onDispose,
  } = options;

  return (scope: PptMasterPresentationScope): PptMasterPresentationPortBinding => {
    validateScope(scope);

    // Independent assembly per scope: fresh adapter, no shared state anywhere.
    const adapter = new PptMasterAdapter({
      provider,
      runner,
      allowedRunnerIds: allowedRunnerIds ?? [runner.id],
      ...(workspaceFactory ? { workspaceFactory } : {}),
      ...(buildArgs ? { buildArgs } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
      ...(now ? { now } : {}),
      ...(idFactory ? { idFactory } : {}),
    });

    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      if (onDispose) await onDispose(port, scope);
    };

    const port = {
      createJob: adapter.createJob.bind(adapter),
      getJob: adapter.getJob.bind(adapter),
      cancelJob: adapter.cancelJob.bind(adapter),
      retryJob: adapter.retryJob.bind(adapter),
      getArtifact: adapter.getArtifact.bind(adapter),
      readArtifactBytes: adapter.readArtifactBytes.bind(adapter),
      exportArtifact: adapter.exportArtifact.bind(adapter),
      dispose,
    } as PresentationBinaryPort & { readonly dispose: () => Promise<void> };

    return { port, scope, dispose };
  };
};

/**
 * Connect the explicit C-40 provider command seam to the kernel adapter. The
 * runner factory receives command argv, buildArgs and allow-list as one
 * immutable provider descriptor; this function itself never invokes spawn.
 */
export const createPptMasterProductionPresentationPortFactory = (
  options: PptMasterProductionPortFactoryOptions,
): ((scope: PptMasterPresentationScope) => PptMasterPresentationPortBinding) => {
  const provider = createProductionPresentationProvider(options.productionProvider);
  if (!provider.available) {
    return () => {
      throw new PresentationError('PROVIDER_UNAVAILABLE', 'Production provider is not configured');
    };
  }
  const runner = options.runnerFactory(provider);
  return createPptMasterPresentationPortFactory({
    ...options,
    provider: provider.provider!,
    runner,
    allowedRunnerIds: provider.allowedRunnerIds,
    buildArgs: provider.buildArgs,
  });
};

/**
 * Compose C-75 configuration with the existing C-33/C-40 production factory.
 * All environment values and runner/workspace dependencies are explicit; no
 * process state, request headers, database, or runner process is consulted at
 * composition time.
 */
export const createPptMasterProductionPresentationComposition = (
  options: PptMasterProductionPresentationCompositionOptions,
): PptMasterProductionPresentationComposition => {
  if (!options || typeof options !== 'object') {
    throw invalid('Production presentation composition options are required', 'options');
  }
  if (typeof options.runnerFactory !== 'function') {
    throw invalid('runnerFactory must be a function', 'runnerFactory');
  }

  const productionProvider = loadProductionPresentationProviderOptions(options.env);
  const readiness = resolveProviderReadiness(productionProvider);
  const portFactory = createPptMasterProductionPresentationPortFactory({
    ...options,
    productionProvider,
    runnerFactory: options.runnerFactory,
  });

  return { portFactory, readiness };
};

/** Short alias for callers using the generic production composition name. */
export const createPptMasterProductionComposition =
  createPptMasterProductionPresentationComposition;

export interface ProductionPresentationGenerationCompositionOptions {
  readonly artifactStore?: PresentationArtifactStore;
  readonly audioTranscriber?: PresentationAudioTranscriber;
  readonly capabilityMemory?: CapabilityMemory;
  readonly contentCompiler?: PresentationContentCompiler;
  readonly contextFactory?: PresentationGenerationContextFactory;
  readonly defaultSlideCount?: number;
  readonly env?: ProductionPresentationEnv;
  /** Generated-image budget for one job; defaults to the asset planner's own bound. */
  readonly imageBudget?: number;
  readonly imageGenerationCapability?: ImageGenerationCapability;
  readonly jobRepository?: PresentationJobRepository;
  readonly journalCache?: ScopedPresentationJobEventJournalCache;
  readonly journalLoader?: PresentationJobEventJournalLoader;
  readonly multimodalChatPort?: MultimodalChatPort;
  readonly now?: () => string;
  readonly planner?: PresentationPlanner;
  readonly runnerFactory?: (provider: ProductionPresentationProvider) => PresentationRunner;
  readonly teachingMemory?: FileTeachingMemory;
  readonly templateLibrary?: FilePresentationTemplateLibrary;
  readonly worker?: Pick<InMemoryPresentationPlanWorker, 'run'>;
  readonly workspaceFactory?: (jobId: string) => PresentationWorkerWorkspace;
}

export interface ProductionPresentationGenerationComposition {
  readonly composition: PresentationRuntimeComposition;
  readonly readiness: ProductionProviderReadiness;
}

/**
 * Compose production generation capabilities including the multimodal planner,
 * image generation, artifact persistence, and execution pipeline.
 *
 * Guarantees:
 * - Pure assembly, zero side-effects at creation (no env reading, no spawn, no network).
 * - Per-scope generation port isolation.
 * - Missing provider fails with PROVIDER_UNAVAILABLE.
 */
export const createProductionPresentationGenerationComposition = (
  options: ProductionPresentationGenerationCompositionOptions,
): ProductionPresentationGenerationComposition => {
  if (!options || typeof options !== 'object') {
    throw invalid('Production presentation generation composition options are required', 'options');
  }

  const planner =
    options.planner ??
    (options.multimodalChatPort
      ? createMultimodalPresentationPlanner({
          chatPort: options.multimodalChatPort,
          defaultSlideCount: options.defaultSlideCount,
        })
      : undefined);

  const worker = options.worker ?? new InMemoryPresentationPlanWorker();
  // One budget for the whole deck: the compiler plans within it and the asset planner enforces it.
  const imageBudget =
    options.imageBudget ?? loadProductionPresentationProviderOptions(options.env ?? {}).imageBudget;
  const contentCompiler =
    options.contentCompiler ??
    (!options.planner && options.multimodalChatPort
      ? createPresentationContentCompiler(options.multimodalChatPort, options.defaultSlideCount, {
          ...(imageBudget === undefined ? {} : { maxRasterVisuals: imageBudget }),
        })
      : undefined);
  const artifactStore =
    options.artifactStore ??
    new InMemoryPresentationArtifactStore(options.now ? () => options.now!() : undefined);

  const imageGenerationCapability = options.imageGenerationCapability
    ? {
        generate: (
          scope: RuntimeScope,
          slots: Parameters<ImageGenerationCapability['generate']>[1],
          context: Parameters<ImageGenerationCapability['generate']>[2],
        ) =>
          atomicRuntime
            ? atomicRuntime.invoke<Awaited<ReturnType<ImageGenerationCapability['generate']>>>(
                'presentation.assets.generate',
                { slots },
                { scope, jobId: context?.jobId, signal: context?.signal },
              )
            : options.imageGenerationCapability!.generate(scope, slots, context),
      }
    : undefined;
  const templateVisualLearning =
    options.templateLibrary && options.multimodalChatPort
      ? new TemplateVisualLearning({
          memory: options.capabilityMemory,
          audioTranscriber: options.audioTranscriber,
          library: options.templateLibrary,
          store: artifactStore,
          chat: options.multimodalChatPort,
        })
      : undefined;
  const visualStoryboardPlanner = options.multimodalChatPort
    ? createPresentationVisualStoryboardPlanner({ chat: options.multimodalChatPort })
    : undefined;
  const visualCritic = options.multimodalChatPort
    ? createPresentationVisualCritic({ chat: options.multimodalChatPort, store: artifactStore })
    : undefined;
  const revisionAssetPlanner = options.multimodalChatPort
    ? createRevisionAssetPlanner({
        chatPort: options.multimodalChatPort,
        ...(imageBudget === undefined ? {} : { maxGeneratedSlots: imageBudget }),
        readReusableAssets: async (refs, input) => {
          const assets = await Promise.all(
            refs.map(async (ref) => {
              const artifact = await artifactStore.get(input.scope, ref);
              return artifact?.bytes &&
                ['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mimeType ?? '')
                ? { ref, name: artifact.name }
                : null;
            }),
          );
          return assets.filter((asset): asset is NonNullable<typeof asset> => !!asset);
        },
        readVisualReferences: async (refs, input) => {
          const images = await Promise.all(
            refs.map(async (ref) => {
              const artifact = await artifactStore.get(input.scope, ref);
              if (
                !artifact?.bytes ||
                artifact.bytes.length > 8 * 1024 * 1024 ||
                !['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mimeType ?? '')
              ) {
                return null;
              }
              return {
                base64: Buffer.from(artifact.bytes).toString('base64'),
                mimeType: artifact.mimeType as 'image/jpeg' | 'image/png' | 'image/webp',
                ref,
              };
            }),
          );
          return images.filter((image): image is NonNullable<typeof image> => Boolean(image));
        },
        extractTemplateComponent: templateVisualLearning
          ? async (componentId, input) => {
              if (!input.jobInput.template || !atomicRuntime)
                throw new Error('Template runtime unavailable');
              return atomicRuntime.invoke(
                'presentation.template.extractComponent',
                {
                  templateId: input.jobInput.template,
                  versionId: input.jobInput.options?.templateVersionId,
                  componentId,
                },
                {
                  scope: input.scope,
                  jobId: input.jobId,
                  signal: input.signal,
                  onEvent: input.onEvent,
                },
              );
            }
          : undefined,
        imageGenerationCapability,
        processAssets: async (steps, input) => {
          if (!atomicRuntime) throw new Error('Asset runtime is not configured');
          const output = await runSkillSteps(
            atomicRuntime,
            steps,
            {
              scope: input.scope,
              jobId: input.jobId,
              signal: input.signal,
              onEvent: input.onEvent,
            },
            (name) =>
              [
                'assets.generate',
                'assets.removeBackground',
                'assets.keyColor',
                'assets.transform',
                'assets.compose',
                'assets.applyMask',
              ].includes(name),
          );
          const result = output.last as { ref?: string };
          if (!result?.ref) throw new Error('Asset workflow did not return an image');
          // A cutout workflow can succeed while returning an opaque bitmap. Measure the produced
          // pixels here, where the server owns the bytes, so every caller gets a fact instead of
          // an assumption about the workflow name.
          let transparency: CutoutTransparency | undefined;
          if (requestsCutout(steps)) {
            const stored = await artifactStore.get(input.scope, result.ref);
            if (stored?.bytes) transparency = await verifyCutoutTransparency(stored.bytes);
          }
          return { ref: result.ref, ...(transparency ? { transparency } : {}) };
        },
      })
    : undefined;
  const teachingLearning =
    options.teachingMemory && options.templateLibrary && options.multimodalChatPort
      ? new TeachingLearning(
          options.teachingMemory,
          options.templateLibrary,
          options.multimodalChatPort,
          { store: artifactStore },
        )
      : undefined;
  const atomicRuntime: AtomicRuntime | undefined = planner
    ? createPresentationAtomicRuntime({
        planner,
        contentCompiler,
        teachingMemory: options.teachingMemory,
        operations: [
          ...(teachingLearning?.operations() ?? []),
          ...(templateVisualLearning?.operations() ?? []),
          ...(options.capabilityMemory
            ? capabilityMemoryOperations(options.capabilityMemory, options.jobRepository)
            : []),
        ],
        chatPort: options.multimodalChatPort,
        worker,
        artifactStore,
        templateLibrary: options.templateLibrary,
        revisionAssetPlanner,
        visualStoryboardPlanner,
        visualCritic,
        imageGenerationCapability: options.imageGenerationCapability,
      })
    : undefined;

  const pipeline = planner
    ? createPresentationGenerationPipeline(
        atomicPlanner(atomicRuntime!),
        atomicWorker(atomicRuntime!),
        {
          ...(options.now ? { now: options.now } : {}),
        },
      )
    : undefined;

  const contextFactory: PresentationGenerationContextFactory =
    options.contextFactory ??
    ((jobId: string) => ({
      plannerContext: {},
      workerContext: {
        convert: async () => [],
        jobId,
        qualityCheck: async () => ({ passed: true }),
        workspace: options.workspaceFactory
          ? options.workspaceFactory(jobId)
          : { path: `/tmp/presentation-${jobId}`, write: async () => {} },
      },
    }));

  const productionProvider = loadProductionPresentationProviderOptions(options.env ?? {});
  const readiness = resolveProviderReadiness(productionProvider);

  const capability =
    readiness.state === 'configured' && pipeline
      ? createPresentationGenerationCapability(pipeline, artifactStore)
      : undefined;

  const journalLoader =
    options.journalCache === undefined && options.journalLoader === undefined
      ? async () => new PresentationJobEventJournal()
      : options.journalLoader;

  const composition = createPresentationRuntimeComposition({
    atomicRuntime,
    contentCompiler,
    capabilityMemory: options.capabilityMemory,
    teachingMemory: options.teachingMemory,
    teachingLearning,
    templateLibrary: options.templateLibrary,
    revisionAssetPlanner,
    visualStoryboardPlanner,
    visualCritic,
    ...(capability ? { capability } : {}),
    contextFactory,
    generationArtifactStore: artifactStore,
    jobRepository: options.jobRepository,
    ...(options.imageGenerationCapability
      ? { imageGenerationCapability: options.imageGenerationCapability }
      : {}),
    ...(options.journalCache ? { journalCache: options.journalCache } : {}),
    ...(journalLoader ? { journalLoader } : {}),
    ...(options.multimodalChatPort ? { multimodalChatPort: options.multimodalChatPort } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  return { composition, readiness };
};
