import { presentationMaterialsSchema } from '@/types/presentationMaterial';

import type { PresentationOutlineCapability } from './outline-capability';
import { deliveryFromArtifacts, readChatOrigin } from './chat-delivery';
import { NativeSlideQualityError } from './toolchain';
import { getPresentationStylePreset } from '../../../../packages/runtime-contracts/src/presentation-style-presets';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type {
  ArtifactSnapshot,
  ExportResult,
  PresentationDecisionAnswer,
  PresentationJob,
  PresentationJobInput,
  PresentationMessageInput,
  PresentationPlan,
  PresentationPort,
  PresentationPresenceInput,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import {
  type CanvasRect,
  moveCanvasObject,
} from '../../../../packages/runtime-contracts/src/canvas';
import type { AtomicInvocation, AtomicRuntime } from '../atomic-runtime';
import type { ExecutionLimiter } from '../execution-limiter';
import { presentationActivity } from './activity';
import { withPresentationAgentJob } from './agent-execution-context';
import { canvasHistory } from '../../../../packages/utils/src/presentationCanvasHistory';
import { canvasCommandSchema, editCanvasPage, recordCanvasPlacement } from './canvas-command';
import { applyCanvasText, validateAnnotation } from './annotation';
import {
  applyTableDataPatch,
  assertTableDataPatchTarget,
  tableDataPatchSchema,
} from './table-data-edit';
import type { PresentationArtifactStore, StoredArtifact } from './artifact-store';
import { createArtworkStyleAtlas } from './artwork-pipeline';
import { appliedLearnedCapabilityIds } from './capability-composition';
import {
  appliedTemplateCapsuleIds,
  type CapabilityCapsule,
  type CapabilityMemory,
} from './capability-memory';
import type { PresentationCapabilitySelector } from './capability-selection';
import {
  applyChartDataPatch,
  assertChartDataPatchTarget,
  chartDataPatchSchema,
} from './chart-data-edit';
import {
  createPresentationDecision,
  mergePresenceTabs,
  presenceIsForeground,
  PRESENTATION_PRESENCE_TTL_MS,
  type PresentationCollaborationHook,
} from './collaboration-plugin';
import type { PresentationGenerationContextFactory } from './composition';
import {
  contentInputFingerprint,
  isRasterVisual,
  type PresentationContentCompiler,
  readContentIntents,
  readVisualAssetBindings,
} from './content-intent';
import { assertPresentationPublishable, inspectPresentationContent } from './content-quality';
import {
  assertDeckVisualConsistency,
  bindDeckVisualSystem,
  createDeckVisualSystem,
  deckBodyRegion,
  deckPageRole,
  readDeckVisualSystem,
  renderDeckVisualFrame,
} from './deck-visual-system';
import { designFingerprint, designReferencePayload } from './design-evidence';
import type { PresentationExecutionLease } from './execution-lease';
import type {
  PresentationJobRepository,
  PresentationPresenceTab,
  StoredPresentationJob,
} from './file-storage';
import type { PresentationGenerationCapability } from './generation-capability';
import type { PresentationGenerationEventPublisherFactory } from './generation-handler';
import type { ImageGenerationCapability } from './image-generation-capability';
import type { ImageGenerationSlot, ImageGenerationSlotOutput } from './image-generation-planner';
import { initialDesignPlan } from './initial-design';
import {
  applyTeacherLessonInstruction,
  bindLessonPlan,
  compileLessonInput,
  prepareLessonDraft,
} from './lesson';
import type { MultimodalChatPort } from './multimodal-chat-provider';
import {
  applyObjectPositionPatch,
  canvasMoveForSlide,
  objectPositionPatchSchema,
} from './object-position-edit';
import { prepareNativeDataExport } from './native-data-export';
import { validatePresentationPlan } from './planner';
import {
  PRESENTATION_JOB_EVENT_TYPES,
  type PresentationJobEventPublisherPort,
  type PresentationJobEventPublishInput,
} from './publisher';
import type {
  PresentationRevisionAssetPlanner,
  PresentationRevisionAssetResult,
} from './revision-assets';
import { presentationImageRefs } from './revision-assets';
import { renderSemanticBlocks, semanticAuthoringSvg, semanticBlockSchema } from './semantic-blocks';
import { recoverSemanticSlideLayout } from './semantic-layout-recovery';
import { attachSourceDocumentImages } from './source-document-images';
import { rebalanceMixedLessonStages, rebasePlanForLessonStages } from './stage-capacity';
import { presentationStageHandoff } from './stage-handoff';
import {
  checkStoryboardCompatibility,
  diagnoseStoryboardLayout,
  intentLayoutInputs,
  isExhaustedLearnedLayout,
  type StoryboardCompatibility,
} from './storyboard-compatibility';
import { normalizeGroupOpacity, normalizeRasterOpacity } from './svg-compatibility';
import type {
  FilePresentationTemplateLibrary,
  TemplateApplication,
  TemplateProfile,
  TemplateReference,
  TemplateVisualProfile,
} from './templates';
import { templateVisualNeedsInput, templateVisualNeedsRefresh } from './templates';
import { composeTemplateApplications } from './templates/composition';
import {
  type PresentationVisualCritic,
  type PresentationVisualReview,
  retainUnresolvedVisualIssues,
  retryTransientVisualReview,
} from './visual-critic';
import { presentationVisualDirectionSchema } from './visual-direction';
import {
  reconcileEvidenceBasedVisualReview,
  stabilizePresentationVisuals,
  type VisualEvidenceAdjudication,
} from './visual-stabilizer';
import type {
  PresentationVisualStoryboard,
  PresentationVisualStoryboardPlanner,
} from './visual-storyboard';
import {
  presentationStoryboardInputFingerprint,
  presentationVisualStoryboardSchema,
} from './visual-storyboard';

/** Page-scoped providers may return a full plan. Only the requested page is authoritative. */
function applyRevisionScope(
  base: PresentationPlan,
  candidate: PresentationPlan,
  target: PresentationMessageInput['target'],
): PresentationPlan {
  if (target.type === 'deck') return candidate;
  const original = base.slides[target.slideNumber - 1];
  const replacement =
    original && candidate.slides.find((slide) => slide.slideId === original.slideId);
  if (!original || !replacement)
    throw Object.assign(new Error('修改结果缺少目标页'), { code: 'PRESENTATION_REPAIR_INVALID' });
  return {
    ...base,
    slides: base.slides.map((slide) =>
      slide.slideId === original.slideId ? { ...replacement, order: original.order } : slide,
    ),
  };
}

export interface PresentationGenerationPortScope extends RuntimeScope {
  readonly request: Request;
}

export interface PresentationGenerationPortOptions {
  readonly agentRoutingFingerprint?: string;
  readonly artifactStore: PresentationArtifactStore;
  readonly atomicRuntime?: AtomicRuntime;
  readonly capability: PresentationGenerationCapability;
  readonly capabilityMemory?: CapabilityMemory;
  readonly capabilitySelector?: PresentationCapabilitySelector;
  readonly collaborationHook?: PresentationCollaborationHook;
  readonly contentCompiler?: PresentationContentCompiler;
  readonly outlineCapability?: PresentationOutlineCapability;
  readonly contextFactory: PresentationGenerationContextFactory;
  readonly eventPublisherFactory?: PresentationGenerationEventPublisherFactory;
  /** Shared by account ports in one production composition. */
  readonly executionLimiter?: ExecutionLimiter;
  readonly idFactory?: () => string;
  readonly imageGenerationCapability?: ImageGenerationCapability;
  readonly layoutDiagnosisChat?: MultimodalChatPort;
  readonly maxExecutionMs?: number;
  readonly now?: () => string;
  readonly prepareCapabilityLibrary?: (scope: RuntimeScope) => Promise<void>;
  readonly repository?: PresentationJobRepository;
  readonly revisionAssetPlanner?: PresentationRevisionAssetPlanner;
  readonly templateLibrary?: FilePresentationTemplateLibrary;
  readonly visualCritic?: PresentationVisualCritic;
  readonly visualStoryboardPlanner?: PresentationVisualStoryboardPlanner;
}

interface JobEntry extends StoredPresentationJob {
  controller: AbortController;
  lease?: PresentationExecutionLease;
  leaseAcquisition?: Promise<PresentationExecutionLease | null>;
  localTask?: boolean;
  mutating?: boolean;
  passive?: boolean;
  persistence: Promise<void>;
  retryTimer?: ReturnType<typeof setTimeout>;
  task: Promise<void>;
}

// versionId is written atomically with the composed editable plan, before final
// review/export. An interrupted export must not replay that already saved edit.
const revisionIsComposed = (
  entry: StoredPresentationJob,
  message: NonNullable<PresentationJob['messages']>[number],
) =>
  Boolean(
    entry.plan && message.versionId && entry.revisionCheckpoint?.requestId !== message.requestId,
  );

const clone = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = clone(nested);
    }
    return output as T;
  }
  return value;
};

const planVisualFingerprint = (plan: PresentationPlan): string =>
  createHash('sha256')
    .update(plan.slides.map((slide) => `${slide.slideId}\u0000${slide.svg}`).join('\u0001'))
    .digest('hex');

/**
 * Prepared assets may enrich the outline with concrete refs, so compare only the
 * learned-template context that must never be rolled back by a retry cache.
 */
const learnedTemplateContextFingerprint = (input: PresentationJobInput): string => {
  const options = input.options as Record<string, unknown> | undefined;
  const visual = options?.templateVisual as Record<string, unknown> | undefined;
  const storyboard = options?.visualStoryboard as Record<string, unknown> | undefined;
  return createHash('sha256')
    .update(
      JSON.stringify({
        agentRoutingFingerprint: options?.agentRoutingFingerprint,
        storyboard: storyboard
          ? {
              inputFingerprint: storyboard.inputFingerprint,
              schemaVersion: storyboard.schemaVersion,
              templateId: storyboard.templateId,
              versionId: storyboard.versionId,
            }
          : null,
        contentIntents: options?.contentIntents,
        visualDirection: options?.visualDirection,
        learnedCapabilities: options?.learnedCapabilities,
        template: input.template ?? null,
        templateVersionId: options?.templateVersionId ?? null,
        visual: visual
          ? {
              analyzedAt: visual.analyzedAt,
              designProgram: visual.designProgram,
              schemaVersion: visual.schemaVersion,
              templateId: visual.templateId,
              versionId: visual.versionId,
            }
          : null,
      }),
    )
    .digest('hex');
};

// Older providers and checkpoints returned the main image directly.
const slotAssetIds = (slot: ImageGenerationSlotOutput & { assetRef?: string }): string[] =>
  Array.isArray(slot.assetRefs)
    ? slot.assetRefs.map(({ ref }) => ref)
    : typeof slot.assetRef === 'string' && slot.assetRef
      ? [slot.assetRef]
      : [];

const preparedAssetsMatchLearnedTemplate = (
  prepared: PresentationRevisionAssetResult | undefined,
  input: PresentationJobInput,
): prepared is PresentationRevisionAssetResult =>
  Boolean(
    prepared &&
    learnedTemplateContextFingerprint(prepared.input) === learnedTemplateContextFingerprint(input),
  );

const bindTemplateApplication = (
  input: PresentationJobInput,
  template: TemplateApplication,
): PresentationJobInput => ({
  ...input,
  template: template.templateId,
  options: {
    ...input.options,
    templateVersionId: template.versionId,
    templateVisual: template.visual,
    templateComponentSources: template.componentSources,
    templateSources: template.sources,
  },
});

/** Owned visual-page artifact ids only; skip unverified URLs and keep the learner bound. */
const trustedTemplatePageRefs = (template?: TemplateApplication): string[] => {
  const refs: string[] = [];
  for (const page of template?.visual?.pages ?? []) {
    if (typeof page.ref !== 'string' || !page.ref.trim()) continue;
    if (/^(?:https?:|data:|\/\/)/iu.test(page.ref)) continue;
    if (refs.includes(page.ref)) continue;
    refs.push(page.ref);
  }
  return refs.slice(0, 4);
};

const confirmedDeckLength = (input: PresentationJobInput): number | undefined => {
  const outline = input.options?.outline;
  if (Array.isArray(outline) && outline.length) return outline.length;
  return Number.isInteger(input.slideCount) && (input.slideCount ?? 0) > 0
    ? input.slideCount
    : undefined;
};

function editsPublishedObject(message: PresentationMessageInput, version: string): boolean {
  if (message.target.type !== 'slide' || message.template || message.patch) return false;
  const edits = [
    message.annotation,
    message.canvasCommand,
    message.tableDataPatch,
    message.chartDataPatch,
    message.objectPositionPatch,
  ].filter((edit) => edit !== undefined);
  return edits.length === 1 && edits[0].expectedVersionId === version;
}

function hasPublishedStoryboardForExactEdits(entry: StoredPresentationJob): boolean {
  const { job, input, plan } = entry;
  const version = job.versionId;
  if (
    !version ||
    job.delivery?.versionId !== version ||
    !job.delivery.pptxId ||
    !plan ||
    !entry.initialAssetsComplete
  )
    return false;
  const pending = job.messages?.filter(
    (message) => message.status === 'queued' || message.status === 'applying',
  );
  if (!pending?.length || !pending.every((message) => editsPublishedObject(message, version)))
    return false;
  const saved = presentationVisualStoryboardSchema.safeParse(input.options?.visualStoryboard);
  const visual = input.options?.templateVisual as TemplateApplication['visual'];
  const receipt = entry.stageHandoffs?.['storyboard:deck'];
  if (!saved.success || !visual?.designProgram || !input.options?.deckVisualSystem || !receipt)
    return false;
  const board = saved.data;
  return (
    board.templateId === input.template &&
    board.versionId === input.options?.templateVersionId &&
    board.templateId === visual.templateId &&
    board.versionId === visual.versionId &&
    receipt.inputVersion === board.inputFingerprint &&
    receipt.outputVersion === designFingerprint(input.options?.visualStoryboard) &&
    board.slides.length === plan.slides.length &&
    confirmedDeckLength(input) === plan.slides.length &&
    board.slides.every((slide, index) => slide.slideId === plan.slides[index].slideId)
  );
}

const normalizeInput = (value: PresentationJobInput): PresentationJobInput | undefined => {
  if (!value || typeof value !== 'object') return;
  const input = value as PresentationJobInput & { options?: Record<string, unknown> };
  const notebookId =
    input.notebookId === undefined || input.notebookId === ''
      ? 'studio'
      : typeof input.notebookId === 'string' && input.notebookId.trim()
        ? input.notebookId.trim()
        : undefined;
  const prompt =
    typeof input.prompt === 'string' && input.prompt.trim()
      ? input.prompt.trim()
      : typeof input.options?.prompt === 'string' && input.options.prompt.trim()
        ? input.options.prompt.trim()
        : undefined;
  const title =
    input.title === undefined || input.title === ''
      ? prompt?.split(/\r?\n/, 1)[0]?.trim().slice(0, 120) || '智能演示文稿'
      : typeof input.title === 'string' && input.title.trim()
        ? input.title.trim()
        : undefined;
  const sourceVersionIds =
    input.sourceVersionIds === undefined
      ? []
      : Array.isArray(input.sourceVersionIds) &&
          input.sourceVersionIds.every((id) => typeof id === 'string' && id.trim())
        ? input.sourceVersionIds.map((id) => id.trim())
        : undefined;
  if (!notebookId || !title || !sourceVersionIds) return;
  return {
    ...input,
    notebookId,
    title,
    sourceVersionIds,
    ...(prompt ? { prompt } : {}),
  };
};

const errorSnapshot = (error: unknown): NonNullable<PresentationJob['error']> => ({
  code:
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'PRESENTATION_INTERNAL_ERROR',
  message: error instanceof Error ? error.message : 'Presentation generation failed',
});

/**
 * Bridges the asynchronous generation pipeline to the legacy PresentationPort
 * surface used by `/jobs`. Creation returns a queued job immediately; the
 * planner, image capability and ppt-master worker continue in the background.
 */
/** Prefer a checkpointed revision when every newer unfinished edit died in transport. */
export function selectResumeMessage<
  T extends { error?: unknown; requestId: string; status?: string },
>(messages: T[] | undefined, checkpointRequestId?: string): T | undefined {
  const unfinished = (messages ?? []).filter((message) => message.status !== 'applied');
  const newest = unfinished.at(-1);
  const checkpoint = checkpointRequestId
    ? unfinished.find((message) => message.requestId === checkpointRequestId)
    : undefined;
  if (!checkpoint || !newest || checkpoint === newest) return newest;
  const newer = unfinished.slice(unfinished.indexOf(checkpoint) + 1);
  const transportOnly = newer.every((message) =>
    /HTTP 50[03]|CHAT_UNAVAILABLE|模型连接暂时中断|transport interrupted/iu.test(
      String(message.error ?? ''),
    ),
  );
  return transportOnly ? checkpoint : newest;
}

/**
 * Required raster visuals whose slot never received an asset: a page split or a late content
 * compile can add requirements after the initial asset pass, and the planner then holds a
 * required image with no href and ships a blank page. The assets step owns completeness.
 */
const requiresAssetPreparation = (
  input: PresentationJobInput,
  plan?: PresentationPlan,
): boolean => {
  const bound = new Map(
    (plan?.slides ?? []).map((slide) => {
      const assets = (slide.metadata?.visualAssets ?? []) as { visualId?: string }[];
      return [
        slide.slideId,
        new Set(assets.flatMap((asset) => (asset?.visualId ? [asset.visualId] : []))),
      ] as const;
    }),
  );
  const preparedSlots = input.options?.generatedImageSlots as
    | {
        slideId: string;
        state: string;
        assetRefs?: { ref: string }[];
        visualBinding?: { visualId: string };
      }[]
    | undefined;
  for (const slot of Array.isArray(preparedSlots) ? preparedSlots : []) {
    if (
      slot.state !== 'ready' ||
      !slot.assetRefs?.some((asset) => asset.ref?.trim()) ||
      !slot.visualBinding?.visualId
    )
      continue;
    const ids = bound.get(slot.slideId) ?? new Set<string>();
    ids.add(slot.visualBinding.visualId);
    bound.set(slot.slideId, ids);
  }
  return readContentIntents(input).some((page) =>
    (page.visuals ?? []).some(
      (visual) =>
        visual.required === true &&
        isRasterVisual(visual) &&
        !bound.get(page.slideId)?.has(visual.id),
    ),
  );
};

export class PresentationGenerationPort implements PresentationPort {
  private readonly jobs = new Map<string, JobEntry>();
  private readonly presence = new Map<string, Map<string, { seenAt: number; active: boolean }>>();
  private readonly loading = new Map<string, Promise<JobEntry | undefined>>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private disposed = false;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly options: PresentationGenerationPortOptions,
    private readonly scope: PresentationGenerationPortScope,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => `presentation-${randomUUID()}`);
  }

  private bindAgentRouting(input: PresentationJobInput): PresentationJobInput {
    const fingerprint = this.options.agentRoutingFingerprint;
    if (!fingerprint && !Object.hasOwn(input.options ?? {}, 'agentRoutingFingerprint'))
      return input;
    const { agentRoutingFingerprint: _untrusted, ...options } = input.options ?? {};
    return {
      ...input,
      ...(Object.keys(options).length || fingerprint
        ? {
            options: {
              ...options,
              ...(fingerprint ? { agentRoutingFingerprint: fingerprint } : {}),
            },
          }
        : { options: undefined }),
    };
  }

  private recordHandoff(
    entry: JobEntry,
    ...args: Parameters<typeof presentationStageHandoff>
  ): void {
    const receipt = presentationStageHandoff(...args);
    entry.stageHandoffs = {
      ...entry.stageHandoffs,
      [receipt.stage + ':' + receipt.subject]: receipt,
    };
  }

  private async imageHandoffDigests(slot: ImageGenerationSlotOutput) {
    const refs = slotAssetIds(slot);
    if (slot.state !== 'ready' || !refs.length) return undefined;
    const digests: Record<string, string> = Object.create(null);
    for (const ref of refs) {
      const artifact = await this.options.artifactStore.get(this.scope, ref);
      if (!artifact?.bytes?.length || !/^image\/(?:png|jpeg|webp)$/u.test(artifact.mimeType ?? ''))
        return undefined;
      digests[ref] = createHash('sha256').update(artifact.bytes).digest('hex');
    }
    return digests;
  }

  async createJob(input: PresentationJobInput): Promise<PresentationJob> {
    if (this.disposed)
      throw Object.assign(new Error('Presentation generation port is disposed'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    let normalizedInput = normalizeInput(compileLessonInput(input));
    if (!normalizedInput)
      throw Object.assign(new Error('notebookId, title and sourceVersionIds are required'), {
        code: 'PRESENTATION_INVALID',
      });
    normalizedInput = this.bindAgentRouting(normalizedInput);
    if (Object.hasOwn(normalizedInput.options ?? {}, 'layoutCompatibility')) {
      const { layoutCompatibility: _untrusted, ...options } = normalizedInput.options!;
      normalizedInput = { ...normalizedInput, options };
    }
    const jobId = this.idFactory();
    const timestamp = this.now();
    const controller = new AbortController();
    const chatOrigin = readChatOrigin(normalizedInput);
    const job: PresentationJob = {
      ...(chatOrigin ? { chatOrigin } : {}),
      jobId,
      state: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      title: normalizedInput.title,
      aspectRatio: normalizedInput.aspectRatio ?? '16:9',
      slideCount: normalizedInput.slideCount,
      projectId: randomUUID(),
      messages: [],
      revisions: [],
    };
    const entry: JobEntry = {
      controller,
      input: clone(normalizedInput),
      initialAssetsComplete: !this.options.revisionAssetPlanner,
      preparedAssets: {},
      job,
      task: Promise.resolve(),
      persistence: Promise.resolve(),
    };
    this.jobs.set(jobId, entry);
    await this.save(entry);
    entry.task = this.run(entry);
    return clone(job);
  }

  private async applyCanvasCommand(
    entry: JobEntry,
    plan: PresentationPlan,
    message: PresentationMessageInput,
  ) {
    if (message.target.type !== 'slide' || !message.canvasCommand) throw Error('请选择一个页面');
    const number = message.target.slideNumber;
    const slide = plan.slides[number - 1];
    if (!slide) throw Error('找不到页面');
    const command = message.canvasCommand;
    const snapshotId = (version: string, id: string) =>
      `${entry.job.jobId}:${version}:canvas-source:${id}`;
    const page = await editCanvasPage(
      slide,
      number,
      command,
      message.requestId,
      async (version, n) => {
        const rev = entry.job.revisions?.find((r) => r.versionId === version);
        const id = plan.slides[n - 1]?.slideId;
        const artifactId = `${entry.job.jobId}:${version}:slide:${id}`;
        if (!id || !rev?.artifactIds.includes(artifactId))
          throw Error('找不到本稿中所选的历史页面');
        if (version === command.expectedVersionId) return plan.slides[n - 1];
        const snapshot = await this.options.artifactStore.get(this.scope, snapshotId(version, id));
        if (snapshot?.bytes)
          return JSON.parse(
            new TextDecoder().decode(snapshot.bytes),
          ) as PresentationPlan['slides'][number];
        const a = await this.options.artifactStore.get(this.scope, artifactId);
        if (!a?.bytes || a.type !== 'svg' || a.metadata?.slideId !== id)
          throw Error('历史页面不可用');
        const metadata = { ...a.metadata };
        for (const key of [
          'notes',
          'artifactRole',
          'nativeData',
          'aspectRatio',
          'jobId',
          'order',
          'slideNumber',
          'slideId',
          'versionId',
          'type',
          'mimeType',
          'planId',
          'quality',
          'status',
          'uri',
        ])
          delete metadata[key];
        return {
          metadata,
          notes: typeof a.metadata.notes === 'string' ? a.metadata.notes : undefined,
          order: n,
          slideId: id,
          svg: new TextDecoder().decode(a.bytes),
        };
      },
    );
    const updated = validatePresentationPlan({
      ...plan,
      slides: plan.slides.map((s) => (s === slide ? page : s)),
    });
    return updated;
  }

  private save(entry: JobEntry): Promise<void> {
    if (entry.passive)
      throw Object.assign(new Error('任务正在其他执行器中运行，请稍后继续'), {
        code: 'PRESENTATION_CONFLICT',
      });
    entry.lease?.signal.throwIfAborted();
    const snapshot = clone({
      input: entry.input,
      job: entry.job,
      plan: entry.plan,
      preparedAssets: entry.preparedAssets,
      initialAssetsComplete: entry.initialAssetsComplete,
      draftCheckpoint: entry.draftCheckpoint,
      revisionCheckpoint: entry.revisionCheckpoint,
      stageHandoffs: entry.stageHandoffs,
    });
    entry.persistence = entry.persistence
      .catch(() => undefined)
      .then(() => this.options.repository?.saveJob(this.scope, snapshot));
    return entry.persistence;
  }

  private async entry(jobId: string): Promise<JobEntry | undefined> {
    const cached = this.jobs.get(jobId);
    if (
      cached &&
      (!this.options.repository?.acquireLease ||
        cached.localTask ||
        cached.mutating ||
        cached.leaseAcquisition ||
        cached.lease ||
        (cached.job.state === 'queued' && cached.retryTimer))
    )
      return cached;
    const pending = this.loading.get(jobId);
    if (pending) return pending;
    const load = (async () => {
      const stored = await this.options.repository?.getJob(this.scope, jobId);
      // A request may have pinned the cached entry while this storage read was in flight.
      if (cached?.mutating || cached?.localTask || cached?.leaseAcquisition || cached?.lease)
        return cached;
      if (!stored) return undefined;
      const entry: JobEntry = {
        ...stored,
        controller: new AbortController(),
        task: Promise.resolve(),
        persistence: Promise.resolve(),
      };
      if (entry.job.state === 'running' || entry.job.state === 'queued') {
        if (this.disposed) entry.passive = true;
        else if (this.options.repository?.acquireLease) {
          entry.lease =
            (await this.options.repository.acquireLease(this.scope, jobId)) ?? undefined;
          entry.passive = !entry.lease;
          if (entry.lease) {
            const fresh = await this.options.repository.getJob(this.scope, jobId);
            if (fresh) Object.assign(entry, fresh);
            if (entry.job.state !== 'running' && entry.job.state !== 'queued') {
              await entry.lease.release();
              entry.lease = undefined;
              entry.passive = false;
            } else {
              entry.job.recovery = {
                attempts: (entry.job.recovery?.attempts ?? 0) + 1,
                resumedAt: this.now(),
                completedSlides:
                  entry.plan?.slides.length ??
                  entry.draftCheckpoint?.slides.length ??
                  entry.revisionCheckpoint?.completedSlideIds.length ??
                  0,
              };
              for (const message of entry.job.messages ?? [])
                if (message.status === 'applying' || message.status === 'queued')
                  message.status = revisionIsComposed(entry, message) ? 'applying' : 'queued';
              entry.job.state = 'queued';
              entry.job.error = undefined;
            }
          }
        } else {
          entry.job.state = 'failed';
          entry.job.error = {
            code: 'PRESENTATION_INTERRUPTED',
            message:
              'Generation was interrupted. Your saved pages and instructions are available; retry to continue.',
          };
          for (const message of entry.job.messages ?? [])
            if (message.status === 'applying' && !revisionIsComposed(entry, message))
              message.status = 'queued';
        }
      }
      if (entry.job.state === 'waiting_input') {
        const last = entry.job.collaboration?.decisions.at(-1);
        // A saved answer without a queued continuation must remain actionable after restart.
        if (last?.status === 'answered') last.status = 'pending';
      }
      await this.restoreOwnedAssetReferences(entry);
      this.jobs.set(jobId, entry);
      if (entry.lease) {
        if ((entry.job.recovery?.attempts ?? 0) > 3) {
          entry.job.state = 'waiting_input';
          entry.job.collaboration ??= { mode: 'adaptive', automaticAttempts: 0, decisions: [] };
          entry.job.collaboration.decisions.push(
            createPresentationDecision('conflict', randomUUID(), this.now()),
          );
          await this.save(entry);
          await entry.lease.release();
          entry.lease = undefined;
        } else {
          await this.save(entry);
          entry.task = this.run(entry);
        }
      }
      return entry;
    })().finally(() => this.loading.delete(jobId));
    this.loading.set(jobId, load);
    return load;
  }

  private async acquireEntryLease(entry: JobEntry, signal?: AbortSignal) {
    if (entry.lease) return entry.lease;
    if (!entry.leaseAcquisition) {
      const repository = this.options.repository;
      if (!repository?.acquireLease) return null;
      entry.leaseAcquisition = repository
        .acquireLease(this.scope, entry.job.jobId, signal)
        .then((lease) => {
          if (lease) entry.lease = lease;
          return lease;
        })
        .finally(() => {
          entry.leaseAcquisition = undefined;
        });
    }
    return entry.leaseAcquisition;
  }

  private async releaseEntryLease(entry: JobEntry) {
    const lease = entry.lease;
    if (!lease) return;
    await lease.release();
    if (entry.lease === lease) entry.lease = undefined;
  }

  private async mutate<T>(jobId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(jobId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed)
          throw Object.assign(new Error('Presentation service is restarting'), {
            code: 'PROVIDER_UNAVAILABLE',
          });
        const entry = await this.entry(jobId);
        if (!entry) return action();
        if (entry.passive)
          throw Object.assign(new Error('任务由其他执行器处理，请刷新当前进度后继续'), {
            code: 'PRESENTATION_CONFLICT',
          });
        entry.mutating = true;
        try {
          // A terminal state is published before the previous worker finishes its writes
          // and lease cleanup. Keep that ownership until this mutation can take it over.
          if (entry.localTask && entry.job.state !== 'running' && entry.job.state !== 'queued')
            await entry.task;
          if (this.options.repository?.acquireLease && !entry.lease) {
            if (!(await this.acquireEntryLease(entry)))
              throw Object.assign(new Error('任务已在继续，请刷新当前进度'), {
                code: 'PRESENTATION_CONFLICT',
              });
            if (!entry.localTask) {
              const stored = await this.options.repository.getJob(this.scope, jobId);
              if (stored) Object.assign(entry, stored);
            }
          }
          return await action();
        } finally {
          try {
            if (!entry.localTask) {
              await entry.persistence.catch(() => undefined);
              await this.releaseEntryLease(entry);
            }
          } finally {
            entry.mutating = false;
          }
        }
      });
    this.mutations.set(jobId, task);
    try {
      return await task;
    } finally {
      if (this.mutations.get(jobId) === task) this.mutations.delete(jobId);
    }
  }

  async updatePresence(jobId: string, input: PresentationPresenceInput): Promise<void> {
    if (input?.mode) return this.mutate(jobId, () => this.updatePresenceOwned(jobId, input));
    return this.updatePresenceOwned(jobId, input);
  }
  private async updatePresenceOwned(
    jobId: string,
    input: PresentationPresenceInput,
  ): Promise<void> {
    if (
      !input ||
      typeof input.tabId !== 'string' ||
      !/^[\w-]{1,100}$/.test(input.tabId) ||
      typeof input.visible !== 'boolean' ||
      typeof input.focused !== 'boolean' ||
      (input.mode !== undefined && !['adaptive', 'ask', 'auto'].includes(input.mode))
    )
      throw Object.assign(new Error('Invalid presentation presence'), {
        code: 'PRESENTATION_INVALID',
      });
    const entry = await this.entry(jobId);
    if (!entry)
      throw Object.assign(new Error('Presentation job does not exist'), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    const now = Date.parse(this.now());
    const tabs = this.presence.get(jobId) ?? new Map();
    for (const [id, tab] of tabs)
      if (now - tab.seenAt > PRESENTATION_PRESENCE_TTL_MS) tabs.delete(id);
    if (tabs.size >= 16 && !tabs.has(input.tabId)) tabs.delete(tabs.keys().next().value!);
    tabs.set(input.tabId, { seenAt: now, active: input.visible && input.focused });
    this.presence.set(jobId, tabs);
    // Forward through the shared store so the executor holding the lease sees this tab too.
    await this.persistPresence(jobId, {
      tabId: input.tabId,
      active: input.visible && input.focused,
      seenAt: now,
    });
    if (entry.passive) {
      if (input.mode)
        throw Object.assign(new Error('任务由其他执行器处理，请稍后重试偏好设置'), {
          code: 'PRESENTATION_CONFLICT',
        });
      return;
    }
    if (input.mode && input.mode !== entry.job.collaboration?.mode) {
      entry.job.collaboration = {
        automaticAttempts: 0,
        decisions: [],
        ...entry.job.collaboration,
        mode: input.mode ?? entry.job.collaboration?.mode ?? 'adaptive',
      };
      entry.job.updatedAt = this.now();
      await this.save(entry);
    }
  }

  private async persistPresence(jobId: string, tab: PresentationPresenceTab): Promise<void> {
    const save = this.options.repository?.savePresence;
    if (!save) return;
    // Presence is best-effort: a storage hiccup must not fail the tab's update.
    await save.call(this.options.repository, this.scope, jobId, [tab]).catch(() => undefined);
  }

  /** Merge local and shared presence so a peer executor's tab is honoured here. */
  private async isForeground(jobId: string, now: number): Promise<boolean> {
    const persisted = await this.options.repository
      ?.readPresence?.(this.scope, jobId)
      .catch(() => undefined);
    const merged = mergePresenceTabs(this.presence.get(jobId) ?? new Map(), persisted ?? []);
    return presenceIsForeground(merged.values(), now);
  }

  async answerDecision(jobId: string, input: PresentationDecisionAnswer): Promise<PresentationJob> {
    return this.mutate(jobId, () => this.answerDecisionOwned(jobId, input));
  }
  private async answerDecisionOwned(
    jobId: string,
    input: PresentationDecisionAnswer,
  ): Promise<PresentationJob> {
    if (
      !input ||
      typeof input.decisionId !== 'string' ||
      typeof input.requestId !== 'string' ||
      !input.requestId.trim() ||
      input.requestId.length > 100 ||
      !['retry', 'revise', 'defer'].includes(input.action) ||
      (input.content !== undefined &&
        (typeof input.content !== 'string' || input.content.length > 3000)) ||
      (input.action === 'revise' && !input.content?.trim())
    )
      throw Object.assign(new Error('请填写有效的决定或补充要求'), {
        code: 'PRESENTATION_INVALID',
      });
    const entry = await this.entry(jobId);
    if (entry?.passive)
      throw Object.assign(new Error('任务正在其他执行器中运行，请刷新当前进度'), {
        code: 'PRESENTATION_CONFLICT',
      });
    const collaboration = entry?.job.collaboration;
    const decision = collaboration?.decisions.find((item) => item.id === input.decisionId);
    if (!entry || !decision || !collaboration)
      throw Object.assign(new Error('This decision no longer exists'), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    if (decision.answer?.requestId === input.requestId) {
      if (
        decision.answer.action !== input.action ||
        decision.answer.content !== input.content?.trim()
      )
        throw Object.assign(new Error('A response id cannot be reused'), {
          code: 'PRESENTATION_CONFLICT',
        });
      // Recover a crash between persisting the answer and scheduling its continuation.
      if (entry.job.state !== 'waiting_input') return clone(entry.job);
      if (input.action === 'revise')
        return this.sendMessageOwned(jobId, {
          content: input.content!.trim(),
          requestId: `decision:${input.requestId}`,
          target: { type: 'deck' },
        });
      return this.retryJobOwned(jobId);
    }
    if (entry.job.state !== 'waiting_input' || decision.status === 'answered')
      throw Object.assign(new Error('问题已更新，请查看当前待决定事项'), {
        code: 'PRESENTATION_CONFLICT',
      });
    if (input.action === 'defer') {
      decision.status = 'deferred';
      entry.job.updatedAt = this.now();
      await this.save(entry);
      await this.publishSnapshot(entry, PRESENTATION_JOB_EVENT_TYPES.progress);
      return clone(entry.job);
    }
    decision.status = 'answered';
    decision.answer = {
      action: input.action,
      content: input.content?.trim(),
      requestId: input.requestId,
      answeredAt: this.now(),
    };
    collaboration.automaticAttempts = 0;
    await this.save(entry);
    try {
      if (input.action === 'revise')
        return await this.sendMessageOwned(jobId, {
          content: input.content!.trim(),
          requestId: `decision:${input.requestId}`,
          target: { type: 'deck' },
        });
      return await this.retryJobOwned(jobId);
    } catch (error) {
      if (entry.job.state === 'waiting_input') {
        decision.status = 'pending';
        await this.save(entry);
      }
      throw error;
    }
  }

  async sendMessage(jobId: string, input: PresentationMessageInput): Promise<PresentationJob> {
    return this.mutate(jobId, () => this.sendMessageOwned(jobId, input));
  }
  private async sendMessageOwned(
    jobId: string,
    input: PresentationMessageInput,
  ): Promise<PresentationJob> {
    if (this.disposed)
      throw Object.assign(new Error('Presentation provider is disposed'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    const entry = await this.entry(jobId);
    if (entry?.passive)
      throw Object.assign(new Error('任务正在其他执行器中运行，请刷新当前进度'), {
        code: 'PRESENTATION_CONFLICT',
      });
    if (!entry)
      throw Object.assign(new Error('Presentation job does not exist'), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    if (
      !input ||
      typeof input.content !== 'string' ||
      !input.content.trim() ||
      input.content.length > 4000 ||
      typeof input.requestId !== 'string' ||
      !input.requestId.trim() ||
      input.requestId.length > 128 ||
      !input.target ||
      !['deck', 'slide'].includes(input.target.type) ||
      (input.target.type === 'slide' &&
        (!Number.isInteger(input.target.slideNumber) ||
          input.target.slideNumber < 1 ||
          input.target.slideNumber > (entry.plan?.slides.length ?? entry.input.slideCount ?? 60)))
    ) {
      throw Object.assign(new Error('A message, request id and valid slide target are required'), {
        code: 'PRESENTATION_INVALID',
      });
    }
    if (
      input.annotation &&
      !entry.job.messages?.some((message) => message.requestId === input.requestId)
    ) {
      if (
        entry.job.state !== 'completed' ||
        input.annotation.expectedVersionId !== entry.job.versionId
      )
        throw Object.assign(new Error('请打开最新完成的版本，重新框选后再发送。'), {
          code: 'PRESENTATION_CONFLICT',
        });
      validateAnnotation(entry.plan, input);
    }
    if (input.patch) {
      if (
        !entry.job.messages?.some((message) => message.requestId === input.requestId) &&
        (input.patch.expectedVersionId !== entry.job.versionId ||
          entry.job.state === 'running' ||
          entry.job.state === 'queued')
      )
        throw Object.assign(new Error('Read the latest version before replacing a page'), {
          code: 'PRESENTATION_CONFLICT',
        });
      if (
        !entry.plan ||
        input.target.type !== 'slide' ||
        entry.plan.slides[input.target.slideNumber - 1]?.slideId !== input.patch.slideId
      )
        throw Object.assign(new Error('Page patch target does not match'), {
          code: 'PRESENTATION_INVALID',
        });
      validatePresentationPlan({
        ...entry.plan,
        slides: entry.plan.slides.map((slide) =>
          slide.slideId === input.patch!.slideId ? { ...slide, ...input.patch } : slide,
        ),
      });
    }
    const objectEdits = [
      input.chartDataPatch,
      input.canvasCommand,
      input.objectPositionPatch,
      input.tableDataPatch,
    ].filter((edit) => edit !== undefined);
    if (objectEdits.length) {
      const position = input.objectPositionPatch !== undefined;
      const parsed =
        input.canvasCommand !== undefined
          ? canvasCommandSchema.safeParse(input.canvasCommand)
          : position
            ? objectPositionPatchSchema.safeParse(input.objectPositionPatch)
            : input.tableDataPatch !== undefined
              ? tableDataPatchSchema.safeParse(input.tableDataPatch)
              : chartDataPatchSchema.safeParse(input.chartDataPatch);
      if (
        !parsed.success ||
        input.target.type !== 'slide' ||
        input.patch ||
        input.annotation ||
        input.template ||
        objectEdits.length !== 1
      )
        throw Object.assign(new Error('请选择单页中的一个对象并提交一项有效修改'), {
          code: 'PRESENTATION_INVALID',
        });
      if (!entry.job.messages?.some((message) => message.requestId === input.requestId)) {
        if (
          !entry.plan ||
          entry.job.state !== 'completed' ||
          parsed.data.expectedVersionId !== entry.job.versionId
        )
          throw Object.assign(new Error('请打开最新完成的版本后修改对象'), {
            code: 'PRESENTATION_CONFLICT',
          });
        try {
          if (input.canvasCommand) {
            const cmd = input.canvasCommand;
            if (cmd.kind === 'restore') {
              const step = canvasHistory(entry.job)[cmd.direction].at(-1);
              if (
                !step ||
                step.id !== cmd.operationId ||
                step.page !== input.target.slideNumber ||
                (cmd.direction === 'undo' ? step.before : step.after) !== cmd.version
              )
                throw Error('该画布修改已变化，请刷新后重试');
            }
            await this.applyCanvasCommand(entry, entry.plan, input);
          } else if (input.objectPositionPatch)
            moveCanvasObject(
              canvasMoveForSlide(entry.plan, input.target, input.objectPositionPatch).move,
            );
          else if (input.tableDataPatch) {
            const slideId = entry.plan.slides[input.target.slideNumber - 1].slideId;
            const published = await this.options.artifactStore.get(
              this.scope,
              `${entry.job.jobId}:${entry.job.versionId}:slide:${slideId}`,
            );
            const manifest = published?.metadata?.nativeData as { tables?: unknown } | undefined;
            if (
              !Array.isArray(manifest?.tables) ||
              !manifest.tables.includes(input.tableDataPatch.blockId)
            )
              throw new Error('此版本尚未导出可编辑的原生表格，请打开最新版或选择表格外的内容');
            assertTableDataPatchTarget(entry.plan, input.target, input.tableDataPatch);
          } else if (input.chartDataPatch)
            assertChartDataPatchTarget(entry.plan, input.target, input.chartDataPatch);
        } catch (error) {
          throw Object.assign(error instanceof Error ? error : new Error('对象无法修改'), {
            code: 'PRESENTATION_INVALID',
          });
        }
      }
    }
    if (input.template) {
      if (!this.options.templateLibrary)
        throw Object.assign(new Error('Template library is unavailable'), {
          code: 'PROVIDER_UNAVAILABLE',
        });
      const resolved = await this.options.templateLibrary.resolve(this.scope, input.template);
      input = {
        ...input,
        template: { templateId: resolved.templateId, versionId: resolved.versionId },
      };
    }
    const existing = entry.job.messages?.find((message) => message.requestId === input.requestId);
    if (existing) {
      if (
        !isDeepStrictEqual(existing.annotation, input.annotation) ||
        !isDeepStrictEqual(existing.canvasCommand, input.canvasCommand) ||
        !isDeepStrictEqual(existing.tableDataPatch, input.tableDataPatch) ||
        JSON.stringify(existing.objectPositionPatch) !==
          JSON.stringify(input.objectPositionPatch) ||
        JSON.stringify(existing.chartDataPatch) !== JSON.stringify(input.chartDataPatch) ||
        JSON.stringify(existing.patch) !== JSON.stringify(input.patch) ||
        JSON.stringify(existing.template) !== JSON.stringify(input.template) ||
        existing.content !== input.content.trim() ||
        existing.target.type !== input.target.type ||
        (existing.target.type === 'slide' &&
          input.target.type === 'slide' &&
          existing.target.slideNumber !== input.target.slideNumber)
      ) {
        throw Object.assign(
          new Error('A request id cannot be reused for a different instruction'),
          { code: 'PRESENTATION_INVALID' },
        );
      }
      return clone(entry.job);
    }
    if ((entry.job.messages?.length ?? 0) >= 200)
      throw Object.assign(new Error('This presentation has reached its message limit'), {
        code: 'PRESENTATION_INVALID',
      });
    entry.job.messages = [
      ...(entry.job.messages ?? []),
      { ...clone(input), content: input.content.trim(), createdAt: this.now(), status: 'queued' },
    ];
    const active = entry.job.state === 'running' || entry.job.state === 'queued';
    if (entry.job.state === 'waiting_input') {
      if (entry.job.collaboration) entry.job.collaboration.automaticAttempts = 0;
      for (const decision of entry.job.collaboration?.decisions ?? []) {
        if (decision.status === 'answered') continue;
        decision.status = 'answered';
        decision.answer = {
          action: 'revise',
          content: input.content.trim(),
          requestId: input.requestId,
          answeredAt: this.now(),
        };
      }
    }
    if (!active) {
      entry.controller = new AbortController();
      entry.job.state = 'queued';
      entry.job.error = undefined;
      await entry.task;
      if (entry.controller.signal.aborted) return clone(entry.job);
      entry.job.state = 'queued';
    }
    entry.job.updatedAt = this.now();
    await this.save(entry);
    await this.publishSnapshot(entry, PRESENTATION_JOB_EVENT_TYPES.progress);
    if (!active) entry.task = this.run(entry);
    return clone(entry.job);
  }

  private planAssetIds(
    plan: PresentationPlan,
    target?: PresentationMessageInput['target'],
  ): string[] {
    const slides =
      target?.type === 'slide'
        ? plan.slides.slice(target.slideNumber - 1, target.slideNumber)
        : plan.slides;
    return [
      ...new Set(
        slides.flatMap((slide) => {
          const metadataRefs = Array.isArray(slide.metadata?.generatedAssetRefs)
            ? slide.metadata.generatedAssetRefs.filter(
                (ref): ref is string => typeof ref === 'string',
              )
            : [];
          const hrefRefs = [
            ...slide.svg.matchAll(/\/api\/runtime\/presentation\/artifacts\/([^"'<>?\s]+)/g),
          ].flatMap((match) => {
            try {
              return [decodeURIComponent(match[1])];
            } catch {
              return [];
            }
          });
          return [...metadataRefs, ...hrefRefs];
        }),
      ),
    ];
  }

  /** Migrate old rendered plans without sending embedded image bytes as model text. */
  private async restoreOwnedAssetReferences(entry: JobEntry): Promise<void> {
    if (!entry.plan?.slides.some((slide) => slide.svg.includes('data:image/'))) return;
    const ids = [
      ...new Set([
        ...this.planAssetIds(entry.plan),
        ...(entry.job.artifactIds ?? []).filter((id) => id.startsWith('image-')),
        ...Object.values(entry.preparedAssets ?? {}).flatMap(
          (prepared) => prepared.assetArtifactIds,
        ),
      ]),
    ];
    const owned = new Map<string, string>();
    for (const id of ids) {
      const artifact = await this.options.artifactStore.get(this.scope, id);
      if (
        artifact?.bytes &&
        ['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mimeType ?? '')
      ) {
        owned.set(
          `data:${artifact.mimeType};base64,${Buffer.from(artifact.bytes).toString('base64')}`,
          id,
        );
      }
    }
    let changed = false;
    entry.plan = {
      ...entry.plan,
      slides: entry.plan.slides.map((slide) => {
        const restored: string[] = [];
        const svg = slide.svg.replaceAll(
          /(\b(?:xlink:)?href\s*=\s*)(["'])(data:image\/(?:png|jpeg|webp);base64,[^"']+)\2/giu,
          (match, prefix: string, quote: string, data: string) => {
            const id = owned.get(data.replaceAll(/\s/g, ''));
            if (!id) return match;
            restored.push(id);
            changed = true;
            return `${prefix}${quote}/api/runtime/presentation/artifacts/${encodeURIComponent(id)}?raw=true${quote}`;
          },
        );
        return restored.length
          ? {
              ...slide,
              svg,
              metadata: {
                ...slide.metadata,
                generatedAssetRefs: [
                  ...new Set([
                    ...(Array.isArray(slide.metadata?.generatedAssetRefs)
                      ? slide.metadata.generatedAssetRefs.filter(
                          (ref): ref is string => typeof ref === 'string',
                        )
                      : []),
                    ...restored,
                  ]),
                ],
              },
            }
          : slide;
      }),
    };
    if (changed) await this.save(entry);
  }

  private async embedOwnedAssets(
    plan: PresentationPlan,
    capsules: CapabilityCapsule[] = [],
    revision?: { jobId: string; previousVersionId: string; editedSlideIds: ReadonlySet<string> },
  ): Promise<PresentationPlan> {
    const slides = await Promise.all(
      plan.slides.map(async (slide) => {
        if (revision && !revision.editedSlideIds.has(slide.slideId)) {
          const ref = `${revision.jobId}:${revision.previousVersionId}:slide:${slide.slideId}`;
          const previous = await this.options.artifactStore.get(this.scope, ref);
          if (
            previous?.bytes &&
            previous.mimeType === 'image/svg+xml' &&
            previous.metadata?.slideId === slide.slideId &&
            previous.metadata?.versionId === revision.previousVersionId
          )
            return {
              ...slide,
              svg: new TextDecoder().decode(previous.bytes),
              ...(previous.metadata.contentBlocks || previous.metadata.designCompilation
                ? {
                    metadata: {
                      ...slide.metadata,
                      ...(previous.metadata.contentBlocks
                        ? { contentBlocks: previous.metadata.contentBlocks }
                        : {}),
                      ...(previous.metadata.designCompilation
                        ? { designCompilation: previous.metadata.designCompilation }
                        : {}),
                    },
                  }
                : {}),
            };
        }
        let svg = normalizeGroupOpacity(slide.svg);
        svg = await normalizeRasterOpacity(svg, async (ref, opacity) => {
          const match = /^\/api\/runtime\/presentation\/artifacts\/([^?]+)(?:\?raw=true)?$/.exec(
            ref,
          );
          if (!match || !this.options.atomicRuntime)
            throw new Error('图片透明度需要可读取的素材与资产处理服务');
          const transformed = await this.options.atomicRuntime.invoke<{ ref: string }>(
            'assets.transform',
            { ref: decodeURIComponent(match[1]), opacity },
            { scope: this.scope },
          );
          return `/api/runtime/presentation/artifacts/${encodeURIComponent(transformed.ref)}`;
        });
        const pattern =
          /(?:https?:\/\/[^/"'<>]+)?\/api\/runtime\/presentation\/artifacts\/([^"'<>?\s]+)(?:\?raw=true)?/g;
        for (const match of svg.matchAll(pattern)) {
          const artifact = await this.options.artifactStore.get(
            this.scope,
            decodeURIComponent(match[1]),
          );
          if (
            !artifact?.bytes ||
            !['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mimeType ?? '')
          ) {
            throw Object.assign(new Error('A referenced presentation image is unavailable'), {
              code: 'ARTIFACT_BYTES_UNAVAILABLE',
            });
          }
          svg = svg.replaceAll(
            match[0],
            `data:${artifact.mimeType};base64,${Buffer.from(artifact.bytes).toString('base64')}`,
          );
        }
        return { ...slide, svg };
      }),
    );
    const embedded = { ...plan, slides };
    return !revision &&
      capsules.length &&
      (plan.designSpec?.deckVisualSystem as { schemaVersion?: number } | undefined)
        ?.schemaVersion === 3
      ? stabilizePresentationVisuals(embedded, undefined, capsules, 'export')
      : embedded;
  }

  private async publishSnapshot(entry: JobEntry, type: string): Promise<void> {
    const publisher = await this.options.eventPublisherFactory?.(
      this.scope,
      entry.job.jobId,
      this.scope.request,
    );
    try {
      publisher?.publish({
        jobId: entry.job.jobId,
        type,
        data: { job: clone(entry.job) },
        scope: this.scope,
      });
    } finally {
      publisher?.dispose();
    }
  }

  async getJob(jobId: string): Promise<PresentationJob | null> {
    const entry = await this.entry(jobId);
    if (!entry) return null;
    let artifactIds = entry.job.artifactIds;
    if (this.options.artifactStore.listByJob && (!artifactIds || artifactIds.length === 0)) {
      try {
        const stored = await this.options.artifactStore.listByJob(this.scope, jobId);
        if (stored.length > 0) {
          artifactIds = stored.map((s) => s.artifactId);
        }
      } catch {
        // Non-fatal if listByJob fails
      }
    }
    return clone({
      ...entry.job,
      ...(artifactIds && artifactIds.length > 0 ? { artifactIds } : {}),
    });
  }

  async cancelJob(jobId: string): Promise<PresentationJob> {
    return this.mutate(jobId, () => this.cancelJobOwned(jobId));
  }
  private async cancelJobOwned(jobId: string): Promise<PresentationJob> {
    const entry = await this.entry(jobId);
    if (entry?.passive)
      throw Object.assign(new Error('任务正在其他执行器中运行，请稍后取消'), {
        code: 'PRESENTATION_CONFLICT',
      });
    if (!entry)
      throw Object.assign(new Error(`Presentation job does not exist: ${jobId}`), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    if (
      entry.job.state === 'queued' ||
      entry.job.state === 'running' ||
      entry.job.state === 'waiting_input'
    ) {
      clearTimeout(entry.retryTimer);
      entry.controller.abort();
      entry.job = { ...entry.job, state: 'cancelled', updatedAt: this.now() };
      for (const message of entry.job.messages ?? [])
        if (message.status === 'applying' && !revisionIsComposed(entry, message))
          message.status = 'queued';
      await this.save(entry);
      await this.publishSnapshot(entry, PRESENTATION_JOB_EVENT_TYPES.cancelled);
    }
    return clone(entry.job);
  }

  async deleteJob(jobId: string): Promise<void> {
    return this.mutate(jobId, () => this.deleteJobOwned(jobId));
  }
  private async deleteJobOwned(jobId: string): Promise<void> {
    const entry = await this.entry(jobId);
    if (entry?.passive)
      throw Object.assign(new Error('任务正在其他执行器中运行，请稍后删除'), {
        code: 'PRESENTATION_CONFLICT',
      });
    if (!entry)
      throw Object.assign(new Error(`Presentation job does not exist: ${jobId}`), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    if (!this.options.repository?.removeJob)
      throw Object.assign(new Error('Presentation deletion is unavailable'), {
        code: 'PROVIDER_UNAVAILABLE',
      });

    entry.controller.abort();
    clearTimeout(entry.retryTimer);
    await entry.task.catch(() => undefined);
    await entry.persistence.catch(() => undefined);
    const ownedArtifacts = (await this.options.artifactStore.listByJob?.(this.scope, jobId)) ?? [];
    await Promise.all(
      [...new Set(ownedArtifacts.map((artifact) => artifact.artifactId))].map((artifactId) =>
        this.options.artifactStore.remove(this.scope, artifactId),
      ),
    );
    await this.options.repository.removeJob(this.scope, jobId);
    this.jobs.delete(jobId);
    this.presence.delete(jobId);
    this.loading.delete(jobId);
  }

  async retryJob(jobId: string): Promise<PresentationJob> {
    return this.mutate(jobId, () => this.retryJobOwned(jobId));
  }
  private async retryJobOwned(jobId: string): Promise<PresentationJob> {
    const entry = await this.entry(jobId);
    if (!entry)
      throw Object.assign(new Error(`Presentation job does not exist: ${jobId}`), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    if (entry.job.state === 'running' || entry.job.state === 'queued') return clone(entry.job);
    if (entry.job.collaboration) {
      entry.job.collaboration.automaticAttempts = 0;
      for (const decision of entry.job.collaboration.decisions) {
        if (decision.status === 'answered') continue;
        decision.status = 'answered';
        decision.answer = { action: 'retry', requestId: randomUUID(), answeredAt: this.now() };
      }
    }
    const reexportCompleted = entry.job.state === 'completed';
    entry.controller = new AbortController();
    entry.job.state = 'queued';
    await entry.task;
    if (entry.controller.signal.aborted) return clone(entry.job);
    entry.job.state = 'queued';
    entry.job.error = undefined;
    // Resume only the newest unfinished instruction. Older queued edits can
    // survive a provider failure when the user keeps working; replaying that
    // backlog would apply stale requests before the latest visible task.
    // A checkpointed revision is the exception: later instructions that died
    // on transport before changing a page must not discard the pages already laid out.
    const unfinishedEdit = reexportCompleted
      ? undefined
      : selectResumeMessage(
          entry.job.messages?.filter((message) => !revisionIsComposed(entry, message)),
          entry.revisionCheckpoint?.requestId,
        );
    for (const message of entry.job.messages ?? []) {
      if (
        revisionIsComposed(entry, message) &&
        (message.status === 'queued' || message.status === 'applying')
      ) {
        message.status = 'applying';
        continue;
      }
      if (message === unfinishedEdit) {
        message.status = 'queued';
        delete message.error;
      } else if (message.status === 'queued' || message.status === 'applying') {
        message.status = 'failed';
        message.error = 'Skipped because a newer edit was resumed.';
      }
    }
    await this.save(entry);
    entry.task = this.run(entry);
    return clone(entry.job);
  }

  async getArtifact(artifactId: string): Promise<ArtifactSnapshot | null> {
    try {
      const stored = await this.options.artifactStore.get(this.scope, artifactId);
      if (!stored) return null;
      const { bytes: _bytes, ...snapshot } = stored;
      return {
        ...snapshot,
        status: snapshot.status ?? 'ready',
        uri: snapshot.uri?.startsWith('/api/runtime/presentation/artifacts/')
          ? `/api/runtime/presentation/artifacts/${encodeURIComponent(artifactId)}?raw=true`
          : (snapshot.uri ??
            `/api/runtime/presentation/artifacts/${encodeURIComponent(artifactId)}?raw=true`),
      };
    } catch {
      // Single-artifact read failure is isolated to this artifact
      return null;
    }
  }

  async getRawArtifact(artifactId: string): Promise<StoredArtifact | null> {
    try {
      return await this.options.artifactStore.get(this.scope, artifactId);
    } catch {
      return null;
    }
  }

  async exportArtifact(
    artifactId: string,
    format: 'pptx' | 'svg' | 'pdf' | 'quality-report',
  ): Promise<ExportResult> {
    let artifact = await this.getArtifact(artifactId);
    if (!artifact)
      throw Object.assign(new Error(`Artifact does not exist: ${artifactId}`), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    if (format !== 'pptx' && format !== 'svg' && format !== 'pdf' && format !== 'quality-report')
      throw Object.assign(new Error(`Unsupported export format: ${format}`), {
        code: 'PRESENTATION_INVALID',
      });
    if (artifact.type !== format) {
      const jobId = artifact.metadata?.jobId;
      const versionId = artifact.metadata?.versionId;
      const siblings =
        typeof jobId === 'string'
          ? ((await this.options.artifactStore.listByJob?.(this.scope, jobId)) ?? [])
          : [];
      artifact =
        siblings.find(
          (candidate) =>
            candidate.type === format &&
            candidate.status === 'ready' &&
            candidate.metadata?.versionId === versionId,
        ) ?? null;
      if (!artifact)
        throw Object.assign(new Error(`No ${format} export is available for this version`), {
          code: 'PRESENTATION_INVALID',
        });
    }
    const uri = `/api/runtime/presentation/artifacts/${encodeURIComponent(artifact.artifactId)}?raw=true`;
    return {
      artifactId: artifact.artifactId,
      format,
      mimeType:
        artifact.mimeType ??
        (format === 'pptx'
          ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
          : format === 'svg'
            ? 'image/svg+xml'
            : 'application/pdf'),
      uri,
    };
  }

  private async readTrustedImages(ids: string[]) {
    const images = [];
    for (const ref of [...new Set(ids)].slice(0, 32)) {
      const artifact = await this.options.artifactStore.get(this.scope, ref);
      if (
        !artifact?.bytes ||
        artifact.bytes.length > 8 * 1024 * 1024 ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mimeType ?? '')
      )
        continue;
      images.push({
        ref,
        mimeType: artifact.mimeType!,
        base64: Buffer.from(artifact.bytes).toString('base64'),
      });
    }
    return images;
  }

  private async ensureTemplateApplication(
    reference: TemplateReference,
    jobId: string,
    signal: AbortSignal,
    publisher?: Pick<PresentationJobEventPublisherPort, 'publish'>,
  ): Promise<TemplateApplication> {
    if (!this.options.templateLibrary)
      throw Object.assign(new Error('Template library is unavailable'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    const profile = await this.options.templateLibrary.get(
      this.scope,
      reference.templateId,
      reference.versionId,
    );
    const cachedVisual =
      profile && typeof this.options.templateLibrary.getVisual === 'function'
        ? await this.options.templateLibrary.getVisual(this.scope, {
            templateId: profile.templateId,
            versionId: profile.versionId,
          })
        : null;
    const needsVisualAnalysis =
      profile?.source.kind === 'pptx' ||
      (cachedVisual ? templateVisualNeedsRefresh(cachedVisual) : false);
    if (needsVisualAnalysis) {
      if (!profile)
        throw Object.assign(new Error('Template does not exist in this scope'), {
          code: 'PRESENTATION_NOT_FOUND',
        });
      const runtime = this.options.atomicRuntime;
      const canAnalyze = Boolean(
        runtime &&
        (await runtime.catalog()).some(
          (tool) => tool.name === 'presentation.template.analyzeVisual',
        ),
      );
      if (!runtime || !canAnalyze)
        throw Object.assign(new Error('Visual analysis is required to apply this template'), {
          code: 'PROVIDER_UNAVAILABLE',
        });
      const analyzed = await runtime.invoke<TemplateVisualProfile>(
        'presentation.template.analyzeVisual',
        { templateId: profile.templateId, versionId: profile.versionId },
        {
          jobId,
          onEvent: (event) =>
            publisher?.publish({
              data: { activity: presentationActivity(event).text, phase: 'template' },
              idempotencyKey: `${event.operationId}:${event.state}`,
              jobId,
              type: PRESENTATION_JOB_EVENT_TYPES.progress,
            }),
          scope: this.scope,
          signal,
        },
      );
      if (templateVisualNeedsInput(analyzed))
        throw Object.assign(new Error(analyzed.learning.questions[0].question), {
          code: 'PRESENTATION_TEMPLATE_INPUT_REQUIRED',
          details: { questions: analyzed.learning.questions },
        });
    }
    const template = await this.options.templateLibrary.resolve(this.scope, {
      templateId: profile?.templateId ?? reference.templateId,
      versionId: profile?.versionId ?? reference.versionId,
    });
    if (needsVisualAnalysis && !template.visual)
      throw Object.assign(
        new Error('Template visual analysis is required before applying this template'),
        { code: 'PRESENTATION_INVALID' },
      );
    return template.visual
      ? {
          ...template,
          visual: await createArtworkStyleAtlas(
            template.visual,
            this.options.artifactStore,
            this.scope,
          ),
        }
      : template;
  }

  private async ensureContentIntents(
    input: PresentationJobInput,
    jobId: string,
    signal: AbortSignal,
  ): Promise<PresentationJobInput> {
    if (!this.options.contentCompiler) return input;
    const previous = input.options?.contentIntents as
      Awaited<ReturnType<PresentationContentCompiler['compile']>> | undefined;
    if (previous?.inputFingerprint === contentInputFingerprint(input)) {
      const slides = readContentIntents(input);
      if (designFingerprint(previous.slides) === designFingerprint(slides)) return input;
      return { ...input, options: { ...input.options, contentIntents: { ...previous, slides } } };
    }
    const revision = input.options?.contentRevision as
      { target?: PresentationMessageInput['target'] } | undefined;
    const target = revision?.target;
    const outline = input.options?.outline;
    const scoped =
      target?.type === 'slide' &&
      Array.isArray(outline) &&
      previous?.slides.length === outline.length;
    const compileInput: PresentationJobInput = scoped
      ? {
          ...input,
          slideCount: 1,
          options: {
            ...input.options,
            outline: [outline[target.slideNumber - 1]],
            originalSlideNumbers: [target.slideNumber],
            contentIntents: {
              slides: [{ ...previous!.slides[target.slideNumber - 1], slideId: 'slide-1' }],
            },
            contentRevision: { ...revision, target: { type: 'slide', slideNumber: 1 } },
            imageSlots: Array.isArray(input.options?.imageSlots)
              ? input.options.imageSlots.flatMap((slot: any) =>
                  slot.slideId === `slide-${target.slideNumber}`
                    ? [{ ...slot, slideId: 'slide-1' }]
                    : [],
                )
              : undefined,
          },
        }
      : input;
    const canCompile = (await this.options.atomicRuntime?.catalog())?.some(
      (tool) => tool.name === 'presentation.content.compile',
    );
    let compiled: Awaited<ReturnType<PresentationContentCompiler['compile']>>;
    try {
      compiled = canCompile
        ? await this.options.atomicRuntime!.invoke<
            Awaited<ReturnType<PresentationContentCompiler['compile']>>
          >(
            'presentation.content.compile',
            { input: compileInput },
            { scope: this.scope, signal, jobId },
          )
        : await this.options.contentCompiler.compile(compileInput, { scope: this.scope, signal });
    } catch (error) {
      if (signal.aborted || (error as { code?: string }).code) throw error;
      throw Object.assign(
        new Error('内容规划尚未通过校验，资料和已完成页面已保留', { cause: error }),
        { code: 'PRESENTATION_VISUAL_PLAN_FAILED' },
      );
    }
    const slides = scoped
      ? previous!.slides.map((slide, index) =>
          index + 1 === target!.slideNumber
            ? { ...compiled.slides[0], slideId: `slide-${index + 1}` }
            : slide,
        )
      : compiled.slides.map((slide, index) =>
          target?.type === 'slide' && target.slideNumber !== index + 1
            ? (previous?.slides[index] ?? slide)
            : slide,
        );
    const normalized = { ...input, slideCount: slides.length };
    return {
      ...normalized,
      options: {
        ...input.options,
        contentIntents: { slides, inputFingerprint: contentInputFingerprint(normalized) },
        ...(compiled.visualDirection
          ? {
              visualDirection: compiled.visualDirection,
              visualDirectionFingerprint: contentInputFingerprint(normalized),
            }
          : {}),
      },
    };
  }

  private async prepareStoryboardLayout(
    entry: JobEntry,
    input: PresentationJobInput,
    capsules: CapabilityCapsule[],
    signal: AbortSignal,
  ) {
    const memory = this.options.capabilityMemory;
    if (!memory?.candidates || entry.plan || !capsules.length) return { input, capsules };
    const inputKey = (chosen: CapabilityCapsule[]) =>
      designFingerprint([
        intentLayoutInputs(input),
        designReferencePayload(chosen),
        readDeckVisualSystem(input),
      ]);
    const previous = input.options?.layoutCompatibility as StoryboardCompatibility | undefined;
    const saved = entry.stageHandoffs?.['compatibility:deck'];
    if (
      saved?.inputVersion === inputKey(capsules) &&
      saved.outputVersion === designFingerprint(previous) &&
      previous?.pages.every((page) => page.layoutIds.length)
    )
      return { input, capsules };

    const first = await checkStoryboardCompatibility(input, capsules, []);
    if (!first) return { input, capsules };
    const requiresReselection =
      !first.styleId ||
      first.pages.some(
        (page) => !page.layoutIds.length || !page.layoutIds.includes(page.preferredLayoutId ?? ''),
      );
    const candidates = requiresReselection
      ? await memory.candidates(
          this.scope,
          '简洁网格 明亮背景 分栏 图文 公式 表格 可编辑对象 swiss-minimal',
          input.aspectRatio ?? '16:9',
          { includeMeasuredStyles: true },
        )
      : [];
    signal.throwIfAborted();
    const report = candidates.length
      ? (await checkStoryboardCompatibility(input, capsules, candidates))!
      : first;
    if (
      ![...capsules, ...candidates].some(
        (capsule) => capsule.kind === 'layout' && capsule.designReference?.slots?.length,
      )
    )
      return { input, capsules };
    const primary = report.styleId ?? report.previousStyleId;
    const required = report.pages.flatMap((page) => page.layoutIds.slice(0, 1));
    const ids = [
      ...new Set([
        ...(primary ? [primary] : []),
        ...required,
        ...capsules.filter((c) => c.kind !== 'style').map((c) => c.id),
        ...report.pages.flatMap((page) => page.layoutIds),
      ]),
    ].slice(0, 10);
    const composition =
      ids.length === capsules.length && ids.every((id, index) => capsules[index].id === id)
        ? undefined
        : await memory.compose(this.scope, ids, true);
    const nextCapsules = composition?.capsules ?? capsules;
    const appliedIds = new Set(nextCapsules.map(({ id }) => id));
    const final = {
      ...report,
      inputVersion: inputKey(nextCapsules),
      previousStyleId: previous?.previousStyleId ?? report.previousStyleId,
      pages: report.pages.map((page) => ({
        ...page,
        layoutIds: page.layoutIds.filter((id) => appliedIds.has(id)),
      })),
    };
    const updated = {
      ...input,
      options: {
        ...input.options,
        ...(composition ? { learnedCapabilities: composition } : {}),
        layoutCompatibility: final,
      },
    };
    this.recordHandoff(
      entry,
      'compatibility',
      'deck',
      final.inputVersion,
      final,
      this.options.agentRoutingFingerprint,
    );
    entry.input = clone(updated);
    await this.save(entry);
    const blocked = final.pages.filter((page) => !page.layoutIds.length);
    if (blocked.length) {
      const diagnosis = await this.layoutDiagnosis(
        {
          failure: 'storyboard-candidates-exhausted',
          pages: blocked,
          candidates: designReferencePayload([...capsules, ...candidates]).slice(0, 30),
        },
        entry.job.jobId,
        signal,
      );
      this.recordHandoff(
        entry,
        'diagnosis',
        'storyboard',
        final.inputVersion,
        diagnosis,
        this.options.agentRoutingFingerprint,
      );
      await this.save(entry);
      throw Object.assign(
        new Error(
          '分镜版式重选后仍无法容纳第 ' +
            blocked.map((page) => page.slideId.replace('slide-', '')).join('、') +
            ' 页的全部对象。' +
            (diagnosis.result?.reason ?? ' 请更换模板或调整这些页面的内容分配。'),
        ),
        { code: 'PRESENTATION_INVALID' },
      );
    }
    return { input: updated, capsules: nextCapsules };
  }

  private async layoutDiagnosis(evidence: unknown, jobId: string, signal: AbortSignal) {
    if (!this.options.layoutDiagnosisChat) return { status: 'unconfigured' as const };
    try {
      return {
        status: 'completed' as const,
        result: await diagnoseStoryboardLayout(this.options.layoutDiagnosisChat, evidence, {
          idempotencyKey: `layout-diagnosis:${jobId}:${designFingerprint(evidence)}`,
          scope: this.scope,
          signal,
        }),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return { status: 'unavailable' as const };
    }
  }

  private async ensureVisualStoryboard(
    input: PresentationJobInput,
    template: TemplateApplication,
    jobId: string,
    signal: AbortSignal,
    publisher?: Pick<PresentationJobEventPublisherPort, 'publish'>,
  ): Promise<PresentationJobInput> {
    if (!template.visual?.designProgram || !this.options.visualStoryboardPlanner) return input;
    if (!confirmedDeckLength(input)) return input;
    const existing = input.options?.visualStoryboard as
      Partial<PresentationVisualStoryboard> | undefined;
    if (
      existing?.templateId === template.templateId &&
      existing.versionId === template.versionId &&
      existing.inputFingerprint === presentationStoryboardInputFingerprint(input) &&
      existing.slides?.length === confirmedDeckLength(input)
    ) {
      return input;
    }
    publisher?.publish({
      data: { activity: '正在把模板语言编排成整稿故事板', phase: 'template' },
      idempotencyKey: `template-storyboard:${template.versionId}`,
      jobId,
      type: PRESENTATION_JOB_EVENT_TYPES.progress,
    });
    const operationInput = { jobInput: input, template };
    const canInvoke = Boolean(
      this.options.atomicRuntime &&
      (await this.options.atomicRuntime.catalog()).some(
        (tool) => tool.name === 'presentation.template.mapDeck',
      ),
    );
    const storyboard = presentationVisualStoryboardSchema.parse(
      canInvoke
        ? await this.options.atomicRuntime!.invoke<PresentationVisualStoryboard>(
            'presentation.template.mapDeck',
            operationInput,
            {
              jobId,
              onEvent: (event) =>
                publisher?.publish({
                  data: { activity: presentationActivity(event).text, phase: 'template' },
                  idempotencyKey: `${event.operationId}:${event.state}`,
                  jobId,
                  type: PRESENTATION_JOB_EVENT_TYPES.progress,
                }),
              scope: this.scope,
              signal,
            },
          )
        : await this.options.visualStoryboardPlanner.plan(operationInput, {
            scope: this.scope,
            signal,
          }),
    );
    if (
      storyboard.templateId !== template.templateId ||
      storyboard.versionId !== template.versionId ||
      storyboard.inputFingerprint !== presentationStoryboardInputFingerprint(input)
    ) {
      throw Object.assign(new Error('Visual storyboard does not match this template and outline'), {
        code: 'PRESENTATION_INVALID',
      });
    }
    return {
      ...input,
      options: { ...input.options, visualStoryboard: storyboard },
    };
  }

  private async reviewAndRepairVisualPlan(
    plan: PresentationPlan,
    input: PresentationJobInput,
    template: TemplateApplication | undefined,
    jobId: string,
    signal: AbortSignal,
    publisher?: Pick<PresentationJobEventPublisherPort, 'publish'>,
    editableSlideIds?: ReadonlySet<string>,
    exactObjectSlideIds?: ReadonlySet<string>,
  ): Promise<PresentationPlan> {
    input = this.bindAgentRouting(input);
    if (
      !this.options.visualCritic ||
      (!template?.visual && plan.designSpec?.contentPolicyVersion !== 1)
    )
      return plan;
    const designCapsules =
      (input.options?.learnedCapabilities as { capsules?: CapabilityCapsule[] } | undefined)
        ?.capsules ?? [];
    if (designCapsules.length)
      plan = {
        ...plan,
        designSpec: {
          ...plan.designSpec,
          designSourceContract: designReferencePayload(designCapsules),
          designStageInputs: {
            selectionFingerprint: input.options?.capabilitySelectionFingerprint,
            sourceFingerprint: designFingerprint(designReferencePayload(designCapsules)),
            storyboardInputFingerprint: (
              input.options?.visualStoryboard as { inputFingerprint?: string } | undefined
            )?.inputFingerprint,
          },
        },
      };
    if (input.options?.agentRoutingFingerprint || plan.designSpec?.agentRoutingFingerprint) {
      const { agentRoutingFingerprint: _previousRoute, ...designSpec } = plan.designSpec ?? {};
      plan = {
        ...plan,
        designSpec: {
          ...designSpec,
          ...(input.options?.agentRoutingFingerprint
            ? { agentRoutingFingerprint: input.options.agentRoutingFingerprint }
            : {}),
        },
      };
    }
    if (input.options?.layoutCompatibility)
      plan = {
        ...plan,
        designSpec: { ...plan.designSpec, layoutCompatibility: input.options.layoutCompatibility },
      };
    plan = await stabilizePresentationVisuals(
      plan,
      template,
      designCapsules,
      'pre-review',
      editableSlideIds,
      exactObjectSlideIds,
    );
    const previous = plan.designSpec?.templateVisualReview as
      | {
          planFingerprint?: string;
          agentRoutingFingerprint?: string;
          templateId?: string;
          versionId?: string;
          final?: PresentationVisualReview;
          reviewVersion?: number;
        }
      | undefined;
    const reviewVersion =
      (plan.designSpec?.deckVisualSystem as { schemaVersion?: number } | undefined)
        ?.schemaVersion === 3
        ? 3
        : 2;
    if (
      previous?.agentRoutingFingerprint === input.options?.agentRoutingFingerprint &&
      previous?.templateId === template?.templateId &&
      previous?.versionId === template?.versionId &&
      previous?.final?.passed === true &&
      previous.reviewVersion === reviewVersion &&
      (plan.designSpec?.contentPolicyVersion !== 1 || inspectPresentationContent(plan).passed) &&
      previous?.planFingerprint === planVisualFingerprint(plan)
    ) {
      assertPresentationPublishable(plan);
      return plan;
    }
    const review = async (candidate: PresentationPlan): Promise<PresentationVisualReview> => {
      const operationInput = { plan: candidate, template };
      const canInvoke = Boolean(
        this.options.atomicRuntime &&
        (await this.options.atomicRuntime.catalog()).some(
          (tool) => tool.name === 'presentation.template.reviewDeck',
        ),
      );
      return retryTransientVisualReview(
        () =>
          canInvoke
            ? this.options.atomicRuntime!.invoke<PresentationVisualReview>(
                'presentation.template.reviewDeck',
                operationInput,
                {
                  jobId,
                  onEvent: (event) =>
                    publisher?.publish({
                      data: { activity: presentationActivity(event).text, phase: 'template' },
                      idempotencyKey: `${event.operationId}:${event.state}`,
                      jobId,
                      type: PRESENTATION_JOB_EVENT_TYPES.progress,
                    }),
                  scope: this.scope,
                  signal,
                },
              )
            : this.options.visualCritic!.review(operationInput, { scope: this.scope, signal }),
        signal,
      );
    };
    const evidenceAdjudications = new Map<string, VisualEvidenceAdjudication>();
    const withMeasuredContent = (
      candidate: PresentationPlan,
      visual: PresentationVisualReview,
    ): PresentationVisualReview => {
      const evidence = reconcileEvidenceBasedVisualReview(visual, candidate);
      for (const adjudication of evidence.adjudications)
        evidenceAdjudications.set(
          JSON.stringify([
            adjudication.slideId,
            adjudication.visualId,
            adjudication.category,
            adjudication.reason,
          ]),
          adjudication,
        );
      const reconciled = evidence.review;
      if (candidate.designSpec?.contentPolicyVersion !== 1) return reconciled;
      const deterministic = inspectPresentationContent(candidate);
      return deterministic.passed
        ? reconciled
        : {
            ...reconciled,
            passed: false,
            issues: [
              ...reconciled.issues,
              ...deterministic.issues.map((issue) => ({
                ...issue,
                category: issue.category === 'geometry' ? ('composition' as const) : issue.category,
              })),
            ],
          };
    };
    const initial = withMeasuredContent(
      plan,
      retainUnresolvedVisualIssues(
        await review(plan),
        previous?.reviewVersion === reviewVersion &&
          previous?.planFingerprint === planVisualFingerprint(plan)
          ? previous.final
          : undefined,
      ),
    );
    // Keep advisory style findings visible without regenerating an already publishable
    // page. Unnecessary rewrites can introduce new layout defects and repeat paid work.
    const repairable = (issue: PresentationVisualReview['issues'][number]) =>
      issue.severity !== 'minor' && (!editableSlideIds || editableSlideIds.has(issue.slideId));
    let corrections = initial.issues.filter(repairable);
    let repaired = plan;
    const repairedSlideIds: string[] = [];
    const repairFailures: Array<{ code: string; slideId: string }> = [];
    let final = initial;
    let finalReviewError: string | undefined;
    for (let repairRound = 0; repairRound < 2 && corrections.length; repairRound++) {
      publisher?.publish({
        data: {
          activity: `发现视觉偏差，正在做第 ${repairRound + 1} 轮局部修正`,
          phase: 'planner',
        },
        idempotencyKey: `template-repair:${template?.versionId ?? 'original'}:${repairRound}`,
        jobId,
        type: PRESENTATION_JOB_EVENT_TYPES.progress,
      });
      const repairedBeforeRound = repairedSlideIds.length;
      const groups = new Map<string, typeof corrections>();
      for (const issue of corrections) {
        groups.set(issue.slideId, [...(groups.get(issue.slideId) ?? []), issue]);
      }
      for (const [slideId, issues] of groups) {
        const slide = repaired.slides.find((item) => item.slideId === slideId);
        if (!slide) continue;
        publisher?.publish({
          jobId,
          type: PRESENTATION_JOB_EVENT_TYPES.progress,
          idempotencyKey: `template-repair-page:${template?.versionId ?? 'original'}:${repairRound}:${slideId}:${planVisualFingerprint(repaired)}`,
          data: { phase: 'planner', activity: `正在调整第 ${slide.order} 页，完成后复核整稿` },
        });
        const layoutFailure = issues.find((issue) => isExhaustedLearnedLayout(issue.evidence));
        const diagnosis = layoutFailure
          ? await this.layoutDiagnosis(
              {
                failure: layoutFailure.evidence,
                slideId,
                candidates: designReferencePayload(designCapsules),
                layoutCompatibility: input.options?.layoutCompatibility,
                objects: (
                  slide.metadata?.contentBlocks as { kind: string; rect: unknown }[] | undefined
                )?.map(({ kind, rect }) => ({ kind, rect })),
              },
              jobId,
              signal,
            )
          : undefined;
        const entry = this.jobs.get(jobId);
        if (entry && diagnosis) {
          this.recordHandoff(
            entry,
            'diagnosis',
            slideId,
            planVisualFingerprint(repaired),
            diagnosis,
            this.options.agentRoutingFingerprint,
          );
          await this.save(entry);
        }
        const editableArtwork = readVisualAssetBindings(slide.metadata?.visualAssets).filter(
          (asset) => asset.kind !== 'source-figure',
        );
        const repairArtwork =
          !exactObjectSlideIds?.has(slideId) &&
          !layoutFailure &&
          issues.some(
            (issue) =>
              (['artwork-style', 'cutout'].includes(issue.category) &&
                editableArtwork.some(
                  (asset) => !issue.visualId || asset.visualId === issue.visualId,
                )) ||
              (issue.category === 'legibility' &&
                /图片|图像|插图|素材|image|raster/iu.test(
                  `${issue.evidence} ${issue.instruction}`,
                ) &&
                !/放大|扩大|加宽|提高.{0,8}(?:高度|宽度|占比)|增大|enlarge|viewport|display size|placement/iu.test(
                  issue.instruction,
                ) &&
                editableArtwork.some(
                  (asset) => !issue.visualId || asset.visualId === issue.visualId,
                )) ||
              ((issue.category === 'scientific-semantics' ||
                (issue.category === 'template-fidelity' && !!issue.visualId)) &&
                readVisualAssetBindings(slide.metadata?.visualAssets).some(
                  (asset) =>
                    ['scientific-illustration', 'scientific-diagram', 'chart'].includes(
                      asset.kind,
                    ) &&
                    (!issue.visualId || asset.visualId === issue.visualId),
                )),
          );
        const repairContent = issues.some((issue) =>
          ['density', 'formula', 'scientific-semantics'].includes(issue.category),
        );
        const revision: PresentationMessageInput = {
          content: [
            ...(repairContent
              ? [
                  '修复内容表达：公式用结构化公式节点重新渲染；科研图修复结构化规格；密集文字精简到核心结论和3–5个要点，将删减的解释移入notes，不得缩小字号。',
                ]
              : []),
            repairArtwork
              ? '视觉复核后的素材修正。仅处理本页中有像素证据的画风、抠图、图内文字可读性或科研插图结构语义问题，按visualId定位素材并决定重绘、去底或保留背景；对科研插图缺失的部件、错误关系或图片内不可读标签用Image修正，不要仅移动SVG。图内必要文字必须完整、字号适合投影；复用其余素材，保留事实、文字含义、讲稿和其它页面。'
              : '视觉复核后的最小修正。只修改本页 SVG 的层级、间距、构图锚点、可读性或模板气质；保留事实、文字含义、讲稿和所有现有图片引用，不生成新素材。',
            ...(diagnosis?.result ? ['版式诊断建议：' + diagnosis.result.repairInstruction] : []),
            ...issues.map((issue) => {
              const instruction = issue.instruction.replaceAll(
                /缩小字号|微调(?:文字)?字号/gu,
                '加宽容器或拆到下一页，保持当前字号',
              );
              return `${issue.category}（${issue.severity}）${issue.visualId ? ` visualId=${issue.visualId}` : ''}：${instruction}；证据：${issue.evidence}`;
            }),
            '结构容量：公式保持实测字号，锁定通栏由服务器装上。配图若低于可读高度，拆成推导页和图解页，不要把图再压小，也不要缩小字号。',
          ]
            .join('\n')
            .slice(0, 4000),
          // A later regeneration may reuse the same template/page while changing
          // its content. Keep retries stable without reusing another plan's assets.
          requestId: `template-visual-repair:${createHash('sha256')
            .update(JSON.stringify([template?.versionId, repaired, input, slideId, issues]))
            .digest('hex')
            .slice(0, 24)}`,
          target: { slideNumber: slide.order, type: 'slide' },
        };
        try {
          if (repairArtwork && !this.options.revisionAssetPlanner)
            throw Object.assign(new Error('Artwork repair is unavailable'), {
              code: 'IMAGE_UNAVAILABLE',
            });
          const prepared = repairArtwork
            ? await this.prepareAssets(
                { ...input, options: { ...input.options, templateVisual: template?.visual } },
                repaired,
                revision,
                jobId,
                signal,
                publisher,
              )
            : { input, assetArtifactIds: [] };
          const candidate = await this.options.capability.plan(
            this.bindAgentRouting(prepared.input),
            {
              abortSignal: signal,
              basePlan: repaired,
              jobId,
              revision,
              scope: this.scope,
              template,
              trustedImages: await this.readTrustedImages([
                ...this.planAssetIds(repaired, revision.target),
                ...prepared.assetArtifactIds,
                ...trustedTemplatePageRefs(template),
              ]),
            },
          );
          const candidateSlide = candidate.slides.find((item) => item.slideId === slideId);
          if (!candidateSlide) {
            throw Object.assign(new Error(`visual repair omitted slide ${slideId}`), {
              code: 'PRESENTATION_REPAIR_INVALID',
            });
          }
          if (exactObjectSlideIds?.has(slideId)) {
            const source = (page: typeof slide) =>
              Array.isArray(page.metadata?.contentBlocks)
                ? page.metadata.contentBlocks.map(
                    (block: { id: string; rect: unknown; spec?: unknown; latex?: string }) => [
                      block.id,
                      block.rect,
                      block.spec,
                      block.latex,
                    ],
                  )
                : [];
            if (designFingerprint(source(candidateSlide)) !== designFingerprint(source(slide)))
              throw Object.assign(new Error('视觉修复须保留已确认的对象位置和数据'), {
                code: 'PRESENTATION_REPAIR_INVALID',
              });
          }
          if (layoutFailure) {
            const refs = (page: PresentationPlan['slides'][number]) =>
              presentationImageRefs(page.svg).sort();
            const exactContent = (blocks: unknown) =>
              Array.isArray(blocks)
                ? blocks
                    .flatMap((raw) => {
                      const block = semanticBlockSchema.safeParse(raw);
                      if (!block.success) return [];
                      if (block.data.kind === 'formula')
                        return [JSON.stringify(block.data.latex.replaceAll(/\s+/gu, ''))];
                      if (block.data.spec.type === 'table')
                        return [JSON.stringify([block.data.spec.columns, block.data.spec.rows])];
                      return [];
                    })
                    .sort()
                : [];
            if (
              designFingerprint(refs(slide)) !== designFingerprint(refs(candidateSlide)) ||
              designFingerprint(exactContent(slide.metadata?.contentBlocks)) !==
                designFingerprint(
                  exactContent(
                    candidateSlide.metadata?.contentBlocks ?? slide.metadata?.contentBlocks,
                  ),
                )
            )
              throw Object.assign(
                new Error('Layout repair must preserve the existing images, formulas and data'),
                { code: 'PRESENTATION_REPAIR_INVALID' },
              );
          }
          // Keep page identity, outline and speaker notes stable. Only an explicit
          // artwork correction may attach newly generated/processed asset refs.
          repaired = {
            ...repaired,
            planId: candidate.planId,
            slides: repaired.slides.map((item) =>
              item.slideId === slideId
                ? {
                    ...item,
                    svg: candidateSlide.svg,
                    ...(repairContent && typeof candidateSlide.notes === 'string'
                      ? { notes: candidateSlide.notes }
                      : {}),
                    ...(candidateSlide.metadata?.contentBlocks
                      ? {
                          metadata: {
                            ...item.metadata,
                            contentBlocks: candidateSlide.metadata.contentBlocks,
                          },
                        }
                      : {}),
                    ...(repairArtwork
                      ? {
                          metadata: {
                            ...item.metadata,
                            visualAssets: candidateSlide.metadata?.visualAssets,
                            visualRequirements: candidateSlide.metadata?.visualRequirements,
                            ...(candidateSlide.metadata?.contentBlocks
                              ? { contentBlocks: candidateSlide.metadata.contentBlocks }
                              : {}),
                            generatedAssetRefs: [
                              ...new Set([
                                ...this.planAssetIds({
                                  ...candidate,
                                  slides: [{ ...candidateSlide, metadata: undefined }],
                                }),
                                ...prepared.assetArtifactIds,
                              ]),
                            ],
                          },
                        }
                      : {}),
                  }
                : item,
            ),
          };
          repairedSlideIds.push(slideId);
        } catch (error) {
          if (signal.aborted) throw error;
          repairFailures.push({
            code:
              error &&
              typeof error === 'object' &&
              'code' in error &&
              typeof error.code === 'string'
                ? error.code
                : 'PRESENTATION_REPAIR_UNAVAILABLE',
            slideId,
          });
          publisher?.publish({
            data: {
              activity: `第 ${slide.order} 页视觉修正暂不可用，保留已完成页面`,
              phase: 'planner',
            },
            idempotencyKey: `template-repair-skipped:${template?.versionId ?? 'original'}:${repairRound}:${slideId}`,
            jobId,
            type: PRESENTATION_JOB_EVENT_TYPES.progress,
          });
        }
      }
      repaired = await stabilizePresentationVisuals(
        repaired,
        template,
        designCapsules,
        'post-repair',
        new Set(repairedSlideIds.slice(repairedBeforeRound)),
        exactObjectSlideIds,
      );
      if (repairedSlideIds.length === repairedBeforeRound && repaired === plan) break;
      try {
        final = withMeasuredContent(repaired, await review(repaired));
        finalReviewError = undefined;
        corrections = final.issues.filter(repairable);
      } catch (error) {
        if (signal.aborted) throw error;
        finalReviewError =
          error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'PRESENTATION_REVIEW_UNAVAILABLE';
        break;
      }
    }
    return {
      ...repaired,
      designSpec: {
        ...repaired.designSpec,
        templateVisualReview: {
          reviewVersion,
          agentRoutingFingerprint: input.options?.agentRoutingFingerprint,
          designSourceFingerprint: designFingerprint(plan.designSpec?.designSourceContract),
          final,
          ...(evidenceAdjudications.size
            ? { evidenceAdjudications: [...evidenceAdjudications.values()] }
            : {}),
          ...(finalReviewError ? { finalReviewError } : {}),
          initial,
          planFingerprint: planVisualFingerprint(repaired),
          ...(repairFailures.length ? { repairFailures } : {}),
          repaired: repairedSlideIds.length > 0,
          repairedSlideIds,
          reviewedAt: this.now(),
          templateId: template?.templateId,
          versionId: template?.versionId,
        },
      },
    };
  }

  private async prepareAssets(
    jobInput: PresentationJobInput,
    basePlan: PresentationPlan,
    revision: PresentationMessageInput,
    jobId: string,
    signal: AbortSignal,
    publisher?: Pick<PresentationJobEventPublisherPort, 'publish'>,
  ): Promise<PresentationRevisionAssetResult> {
    if (!this.options.revisionAssetPlanner)
      return { input: jobInput, intents: [], assetArtifactIds: [] };
    const input = { jobInput, basePlan, revision };
    const onEvent: NonNullable<AtomicInvocation['onEvent']> = (event) => {
      publisher?.publish({
        jobId,
        type: PRESENTATION_JOB_EVENT_TYPES.progress,
        idempotencyKey: `operation:${event.operationId}:${event.state}`,
        data: { activity: presentationActivity(event).text, phase: 'assets' },
      });
    };
    return this.options.atomicRuntime
      ? this.options.atomicRuntime.invoke('presentation.assets.prepare', input, {
          scope: this.scope,
          jobId,
          signal,
          onEvent,
        })
      : this.options.revisionAssetPlanner.prepare({
          ...input,
          scope: this.scope,
          jobId,
          signal,
          onEvent,
        });
  }

  async listTemplates() {
    await this.options.prepareCapabilityLibrary?.(this.scope);
    if (!this.options.templateLibrary) return [];
    return this.options.atomicRuntime
      ? this.options.atomicRuntime.invoke('presentation.template.list', {}, { scope: this.scope })
      : this.options.templateLibrary.list(this.scope);
  }
  async deleteTemplate(templateId: string): Promise<void> {
    if (!this.options.templateLibrary)
      throw Object.assign(new Error('Template library unavailable'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    await this.options.templateLibrary.remove(this.scope, templateId);
  }
  async learnTemplate(name: string, jobId: string) {
    const entry = await this.entry(jobId);
    if (!entry?.plan)
      throw Object.assign(new Error('No saved pages to learn from'), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    if (!this.options.templateLibrary)
      throw Object.assign(new Error('Template library unavailable'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    const input = { name, plan: entry.plan };
    return this.options.atomicRuntime
      ? this.options.atomicRuntime.invoke<TemplateProfile>('presentation.template.learn', input, {
          scope: this.scope,
          jobId,
        })
      : this.options.templateLibrary.learnFromPlan(this.scope, input);
  }
  async importTemplate(name: string, bytes: Uint8Array) {
    if (!this.options.templateLibrary)
      throw Object.assign(new Error('Template library unavailable'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    return this.options.atomicRuntime
      ? this.options.atomicRuntime.invoke(
          'presentation.template.import',
          { name },
          { scope: this.scope, services: { upload: bytes } },
        )
      : this.options.templateLibrary.importPptx(this.scope, { name, bytes });
  }
  async applyTemplate(
    jobId: string,
    input: { templateId: string; versionId?: string; requestId: string },
  ) {
    if (!this.options.templateLibrary)
      throw Object.assign(new Error('Template library unavailable'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    const template = await this.options.templateLibrary.resolve(this.scope, input);
    return this.sendMessage(jobId, {
      content: `应用模板「${template.name}」的视觉风格与适合各页内容的版式，保留本稿的主题、事实和文字含义。`,
      requestId: input.requestId,
      target: { type: 'deck' },
      template: { templateId: template.templateId, versionId: template.versionId },
    });
  }
  private readonly publicOperations = new Set([
    'presentation.teaching.analyze',
    'presentation.teaching.search',
    'presentation.teaching.compose',
    'presentation.lesson.plan',
    'presentation.lesson.compile',
    'presentation.lesson.revise',
    'presentation.lesson.validate',
    'presentation.memory.search',
    'presentation.memory.load',
    'presentation.memory.compose',
    'presentation.memory.recordOutcome',
    'presentation.memory.promote',
    'presentation.formula.render',
    'presentation.formula.measure',
    'presentation.diagram.measure',
    'presentation.diagram.render',
    'presentation.job.read',
    'presentation.job.list',
    'assets.inspect',
    'assets.list',
    'assets.applyMask',
    'presentation.template.extractAssets',
    'presentation.template.extractMedia',
    'presentation.template.render',
    'presentation.template.analyzeVisual',
    'presentation.template.extractComponent',
    'assets.transform',
    'assets.removeBackground',
    'assets.keyColor',
    'assets.compose',
    'assets.generate',
    'skills.catalog',
    'skills.run',
    'skills.autorun',
    'presentation.template.inspectNative',
    'presentation.template.listNativeOutputs',
    'presentation.template.fillNative',
    'presentation.template.restoreNative',
    'presentation.learning.list',
    'presentation.learning.read',
    'presentation.validation.options',
    'presentation.validation.create',
    'presentation.validation.start',
    'presentation.validation.status',
    'presentation.validation.cancel',
    'presentation.trial.start',
    'presentation.trial.status',
    'presentation.trial.cancel',
    'presentation.trial.list',
    'presentation.trial.read',
    'presentation.trial.choose',
    'presentation.page.read',
    'presentation.page.replace',
    'presentation.job.message',
    'presentation.job.export',
    'presentation.template.fromJob',
    'presentation.template.list',
    'presentation.template.apply',
    'presentation.template.resolve',
  ]);
  async listJobs(origin?: PresentationJob['chatOrigin']) {
    const persisted = (await this.options.repository?.listJobs?.(this.scope)) ?? [];
    const jobs = new Map(persisted.map((job) => [job.jobId, job]));
    for (const entry of this.jobs.values())
      if (!entry.passive) jobs.set(entry.job.jobId, entry.job);
    const matches = [...jobs.values()]
      .filter(
        (job) =>
          !origin ||
          (job.chatOrigin?.agentId === origin.agentId &&
            job.chatOrigin.topicId === origin.topicId &&
            job.chatOrigin.messageId === origin.messageId),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 100)
      .map(clone);
    if (!origin) return { jobs: matches };
    return {
      jobs: await Promise.all(
        matches.map(async (job) =>
          job.state === 'completed' && !job.delivery
            ? ((await this.getJob(job.jobId)) ?? job)
            : job,
        ),
      ),
    };
  }
  async readPlan(jobId: string) {
    const entry = await this.entry(jobId);
    if (!entry?.plan)
      throw Object.assign(new Error('Presentation pages not found'), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    return clone({ job: entry.job, plan: entry.plan });
  }
  async replacePage(input: {
    jobId: string;
    page: number;
    expectedVersionId: string;
    requestId: string;
    svg: string;
    notes?: string;
  }) {
    const { job, plan } = await this.readPlan(input.jobId);
    const existing = job.messages?.find((message) => message.requestId === input.requestId);
    if (
      existing?.patch?.svg === input.svg &&
      existing.patch.notes === input.notes &&
      existing.target.type === 'slide' &&
      existing.target.slideNumber === input.page
    )
      return job;
    if (
      job.versionId !== input.expectedVersionId ||
      job.state === 'queued' ||
      job.state === 'running'
    )
      throw Object.assign(
        new Error('The presentation has changed. Read the latest page before replacing it.'),
        { code: 'PRESENTATION_CONFLICT' },
      );
    const slide = plan.slides[input.page - 1];
    if (!slide)
      throw Object.assign(new Error('Page not found'), { code: 'PRESENTATION_NOT_FOUND' });
    return this.sendMessage(input.jobId, {
      content: `更新第 ${input.page} 页`,
      requestId: input.requestId,
      target: { type: 'slide', slideNumber: input.page },
      patch: {
        expectedVersionId: input.expectedVersionId,
        slideId: slide.slideId,
        svg: input.svg,
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      },
    });
  }
  async listOperations() {
    if (!this.options.atomicRuntime) return { tools: [], plugins: [], operations: [] };
    const catalog = await this.options.atomicRuntime.catalog();
    return {
      tools: catalog.filter((tool) => this.publicOperations.has(tool.name)),
      runtimeTools: catalog,
      ...(await this.options.atomicRuntime.snapshot(this.scope)),
    };
  }
  async executeOperation(name: string, input: unknown, signal?: AbortSignal) {
    if (!this.options.atomicRuntime || !this.publicOperations.has(name))
      throw Object.assign(new Error('Operation not available through this presentation session'), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    return this.options.atomicRuntime.invoke(name, input, {
      scope: this.scope,
      services: { port: this },
      signal,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.jobs.values()) {
      clearTimeout(entry.retryTimer);
      entry.controller.abort();
    }
    this.presence.clear();
    await Promise.allSettled([...this.jobs.values()].map(({ task }) => task));
  }

  /**
   * Pin every mounted plugin for the whole run, not just `presentation`. Otherwise a
   * plugin such as `assets` can be replaced between two calls of the same job and the
   * job would mix implementation versions.
   */
  private async acquireRunLeases(): Promise<(() => void) | undefined> {
    const runtime = this.options.atomicRuntime;
    if (!runtime) return undefined;
    const ids =
      typeof runtime.pluginIds === 'function' ? await runtime.pluginIds() : ['presentation'];
    const releases: (() => void)[] = [];
    try {
      for (const id of ids) releases.push(await runtime.acquire(id));
    } catch (error) {
      for (const done of releases.reverse()) done();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const done of releases.reverse()) done();
    };
  }

  private run(entry: JobEntry): Promise<void> {
    entry.localTask = true;
    return withPresentationAgentJob(entry.job.jobId, () =>
      this.runOwned(entry, entry.input, entry.controller),
    );
  }

  private async runOwned(
    entry: JobEntry,
    input: PresentationJobInput,
    controller: AbortController,
  ): Promise<void> {
    const jobId = entry.job.jobId;
    const update = (patch: Partial<PresentationJob>): void => {
      if (entry.job.state === 'cancelled' && patch.state !== 'cancelled') return;
      if (controller.signal.aborted && patch.state !== 'cancelled') return;
      entry.job = { ...entry.job, ...patch, updatedAt: this.now() };
    };
    // Defer one turn so createJob can return the queued snapshot first.
    await Promise.resolve();
    if (controller.signal.aborted) {
      update({ state: 'cancelled' });
      if (!entry.mutating) await this.releaseEntryLease(entry);
      entry.localTask = false;
      return;
    }
    let release: (() => void) | undefined;
    let releaseCapacity: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const deadline = setTimeout(
      () =>
        controller.abort(
          Object.assign(new Error('本轮执行超时，进度已保留，请决定如何继续'), {
            code: 'PRESENTATION_TASK_TIMEOUT',
          }),
        ),
      this.options.maxExecutionMs ?? 45 * 60_000,
    );
    const leaseLost = () => controller.abort(entry.lease?.signal.reason);
    try {
      if (
        this.options.repository?.acquireLease &&
        !entry.lease &&
        !(await this.acquireEntryLease(entry, controller.signal))
      ) {
        entry.passive = true;
        return;
      }
      entry.lease?.signal.addEventListener('abort', leaseLost, { once: true });
      entry.passive = false;
      releaseCapacity = await this.options.executionLimiter?.acquire(controller.signal);
      if (controller.signal.aborted) {
        update({ state: 'cancelled' });
        await this.save(entry);
        return;
      }
      update({ state: 'running' });
      heartbeat = setInterval(() => {
        if (controller.signal.aborted) return;
        entry.job.heartbeatAt = this.now();
        void this.save(entry)
          .then(() => this.publishSnapshot(entry, PRESENTATION_JOB_EVENT_TYPES.progress))
          .catch(() =>
            controller.abort(
              Object.assign(new Error('Task checkpoint storage is unavailable'), {
                code: 'PRESENTATION_PERSIST_FAILED',
              }),
            ),
          );
      }, 15_000);
      release = await this.acquireRunLeases();
      const context = this.options.contextFactory(jobId);
      const publisher = this.options.eventPublisherFactory
        ? await this.options.eventPublisherFactory(this.scope, jobId, this.scope.request)
        : undefined;
      try {
        await this.save(entry);
        publisher?.publish({
          data: {
            job: clone(entry.job),
            ...(entry.job.recovery
              ? {
                  activity: `服务已恢复，保留 ${entry.job.recovery.completedSlides} 页检查点并继续制作`,
                  phase: 'recovery',
                }
              : {}),
          },
          idempotencyKey: `state:running:${entry.job.updatedAt}`,
          jobId,
          scope: this.scope,
          type: PRESENTATION_JOB_EVENT_TYPES.progress,
        });
        let generationInput = this.bindAgentRouting(clone(input));
        let reusePublishedStoryboard = hasPublishedStoryboardForExactEdits(entry);
        // An edit received while the initial deck is incomplete should shape that
        // first render, rather than forcing a second complete 18-page pass afterwards.
        const initialInstruction = !entry.plan
          ? selectResumeMessage(entry.job.messages, entry.revisionCheckpoint?.requestId)
          : undefined;
        const initialInstructionApplied =
          initialInstruction &&
          !initialInstruction.patch &&
          !initialInstruction.tableDataPatch &&
          !initialInstruction.chartDataPatch &&
          !initialInstruction.objectPositionPatch &&
          !initialInstruction.canvasCommand &&
          !initialInstruction.annotation &&
          !initialInstruction.template
            ? initialInstruction
            : undefined;
        if (initialInstructionApplied) {
          generationInput = applyTeacherLessonInstruction(
            generationInput,
            initialInstructionApplied,
          );
          generationInput = {
            ...generationInput,
            options: {
              ...generationInput.options,
              contentRevision: {
                content: initialInstructionApplied.content,
                requestId: initialInstructionApplied.requestId,
                target: initialInstructionApplied.target,
              },
            },
          };
          initialInstructionApplied.status = 'applying';
          entry.input = clone(generationInput);
          await this.save(entry);
        }
        // Keep an incomplete draft's fingerprint stable. Add source visuals on
        // initial creation or a later revision of the completed plan.
        if (!reusePublishedStoryboard && (!entry.draftCheckpoint || entry.plan)) {
          const sourceInput = generationInput;
          generationInput = await attachSourceDocumentImages(generationInput, {
            store: this.options.artifactStore,
            scope: this.scope,
            signal: controller.signal,
          });
          if (generationInput !== sourceInput) {
            entry.input = clone(generationInput);
            await this.save(entry);
          }
        }
        // Direct creation provides a brief and a length. Persist the same editable
        // page structure as the conversation flow before content batching or layout selection.
        if (
          // Existing saved direct jobs predate the mode flag and carry their brief in options.prompt.
          (generationInput.options?.creationMode === 'direct' ||
            typeof generationInput.options?.prompt === 'string') &&
          this.options.outlineCapability &&
          this.options.contentCompiler &&
          !entry.plan &&
          !entry.draftCheckpoint &&
          !generationInput.options?.contentIntents &&
          !generationInput.options?.lessonPlan &&
          !(
            Array.isArray(generationInput.options?.outline) &&
            generationInput.options.outline.length
          )
        ) {
          publisher?.publish({
            jobId,
            type: PRESENTATION_JOB_EVENT_TYPES.progress,
            data: { activity: '正在将简报整理成逐页大纲', phase: 'planner' },
          });
          const {
            options: current,
            aspectRatio,
            language,
            title,
            prompt,
            slideCount,
          } = generationInput;
          const materials =
            current?.materials === undefined
              ? undefined
              : presentationMaterialsSchema.parse(current.materials);
          const { slides } = await this.options.outlineCapability.execute(
            {
              operation: 'propose',
              exactSlideCount: slideCount,
              brief: {
                topic: title,
                slideCount,
                language,
                materials,
                aspectRatio:
                  aspectRatio === '4:3' || aspectRatio === '16:9' ? aspectRatio : undefined,
                style: typeof current?.style === 'string' ? current.style : undefined,
                audience: typeof current?.audience === 'string' ? current.audience : undefined,
                research: typeof current?.research === 'string' ? current.research : undefined,
              },
              instruction: [
                prompt,
                slideCount
                  ? `整稿共 ${slideCount} 页。保留用户逐页指定的页序、标题、事实、数字和表达要求。`
                  : undefined,
              ]
                .filter(Boolean)
                .join('\n'),
            },
            { scope: this.scope, signal: controller.signal },
          );
          generationInput = {
            ...generationInput,
            slideCount: slides.length,
            options: { ...current, outline: slides },
          };
          input = generationInput;
          entry.input = clone(generationInput);
          await this.save(entry);
        }
        if (!entry.plan && !entry.draftCheckpoint)
          await this.options.prepareCapabilityLibrary?.(this.scope);
        if (
          !entry.plan &&
          !this.options.imageGenerationCapability &&
          Array.isArray(input.options?.imageSlots) &&
          input.options.imageSlots.length > 0 &&
          !Object.values(entry.stageHandoffs ?? {}).some((handoff) => handoff.stage === 'image')
        )
          throw Object.assign(new Error('Image generation provider is not configured'), {
            code: 'PROVIDER_UNAVAILABLE',
          });
        const pinnedMemory = generationInput.options?.learnedCapabilities as
          { capsules?: CapabilityCapsule[] } | undefined;
        let learnedCapsules = pinnedMemory?.capsules ?? [];
        let templateCapsules: CapabilityCapsule[] = [];
        if (this.options.capabilityMemory && !entry.plan && !entry.draftCheckpoint) {
          const selectionFingerprint = createHash('sha256')
            .update(
              JSON.stringify({
                title: input.title,
                prompt: input.prompt,
                outline: input.options?.outline,
                style: input.options?.style,
                styleWorkspaceId: input.options?.styleWorkspaceId,
                capabilityIds: input.options?.capabilityIds,
              }),
            )
            .digest('hex');
          const requestedIds =
            (entry.stageHandoffs?.['compatibility:deck'] &&
            input.options?.capabilitySelectionFingerprint === selectionFingerprint
              ? pinnedMemory?.capsules?.map((capsule) => capsule.id)
              : undefined) ??
            input.options?.capabilityIds ??
            (input.options?.capabilitySelectionFingerprint === selectionFingerprint ||
            (!entry.plan && input.options?.visualDirection)
              ? pinnedMemory?.capsules?.map((capsule) => capsule.id)
              : undefined);
          if (
            requestedIds !== undefined &&
            (!Array.isArray(requestedIds) || requestedIds.some((id) => typeof id !== 'string'))
          )
            throw Object.assign(
              new Error('capabilityIds must be a list of learned capability ids'),
              { code: 'PRESENTATION_INVALID' },
            );
          const query = [
            input.title,
            input.prompt,
            input.options?.style,
            JSON.stringify(input.options?.outline ?? []),
          ]
            .filter(Boolean)
            .join(' ')
            .slice(0, 12_000);
          const capsules = requestedIds
            ? []
            : this.options.capabilitySelector && this.options.capabilityMemory.candidates
              ? [
                  ...new Map(
                    (
                      await Promise.all([
                        this.options.capabilityMemory.candidates(
                          this.scope,
                          String(input.options?.style ?? ''),
                          input.aspectRatio ?? '16:9',
                        ),
                        this.options.capabilityMemory.candidates(
                          this.scope,
                          query,
                          input.aspectRatio ?? '16:9',
                        ),
                      ])
                    )
                      .flat()
                      .map((capsule) => [capsule.id, capsule]),
                  ).values(),
                ]
              : await this.options.capabilityMemory.search(this.scope, query, 6, true);
          const preset = getPresentationStylePreset(input.options?.styleWorkspaceId);
          const pinned =
            preset && !requestedIds
              ? ((await this.options.capabilityMemory.resolveWorkspaces?.(this.scope, [
                  preset.id,
                  ...((input.aspectRatio ?? '16:9') === '16:9'
                    ? [preset.coverLayout, preset.textLayout]
                    : []),
                ])) ?? [])
              : [];
          const selectable = pinned.length
            ? [
                ...new Map(
                  [...pinned, ...capsules.filter((capsule) => capsule.kind !== 'style')].map(
                    (capsule) => [capsule.id, capsule],
                  ),
                ).values(),
              ]
            : capsules;
          const chosen =
            (requestedIds as string[] | undefined) ??
            (this.options.capabilitySelector
              ? await this.options.capabilitySelector.select(input, selectable, {
                  scope: this.scope,
                  signal: controller.signal,
                })
              : selectable.map(({ id }) => id));
          const selectedIds = pinned.length
            ? [...new Set([...pinned.map((capsule) => capsule.id), ...chosen])].slice(0, 10)
            : chosen;
          const composed = await this.options.capabilityMemory.compose(
            this.scope,
            selectedIds,
            true,
          );
          learnedCapsules = composed.capsules;
          generationInput = {
            ...generationInput,
            options: {
              ...generationInput.options,
              learnedCapabilities: composed,
              capabilitySelectionFingerprint: selectionFingerprint,
            },
          };
          entry.input = clone(generationInput);
          await this.save(entry);
        }
        const uncompiledInput = generationInput;
        const needsInitialContent =
          !entry.plan && (!entry.draftCheckpoint || Boolean(initialInstructionApplied));
        if (!reusePublishedStoryboard && this.options.contentCompiler) {
          publisher?.publish({
            jobId,
            type: PRESENTATION_JOB_EVENT_TYPES.progress,
            data: { activity: '正在识别公式、科研图与每页的核心内容', phase: 'planner' },
          });
        }
        // Content art direction needs the selected templates and shared master.
        const loadedTemplates = await (async () => {
          if (reusePublishedStoryboard && this.options.templateLibrary) {
            // Open only the immutable template versions used to publish this deck.
            const sources = uncompiledInput.options
              ?.templateSources as TemplateApplication['sources'];
            const pinned = sources?.length
              ? sources
              : [
                  {
                    templateId: uncompiledInput.template!,
                    versionId: uncompiledInput.options!.templateVersionId as string,
                  },
                ];
            return Promise.all(
              pinned.map((ref) => this.options.templateLibrary!.resolve(this.scope, ref)),
            );
          }
          const references: TemplateReference[] = [];
          if (uncompiledInput.template)
            references.push({
              templateId: uncompiledInput.template,
              versionId: uncompiledInput.options?.templateVersionId as string | undefined,
            });
          if (this.options.templateLibrary)
            for (const capsule of learnedCapsules.toSorted(
              (a, b) => Number(b.kind === 'style') - Number(a.kind === 'style'),
            )) {
              const { templateId, versionId } = capsule.source;
              if (
                !templateId ||
                !versionId ||
                references.some((ref) => ref.templateId === templateId)
              )
                continue;
              const visual = await this.options.templateLibrary
                .getVisual(this.scope, { templateId, versionId })
                .catch(() => null);
              if (!visual || templateVisualNeedsInput(visual) || templateVisualNeedsRefresh(visual))
                continue;
              references.push({ templateId, versionId });
              if (references.length >= 4) break;
            }
          const templates: TemplateApplication[] = [];
          for (const reference of references)
            templates.push(
              await this.ensureTemplateApplication(reference, jobId, controller.signal, publisher),
            );
          return templates;
        })();
        const selectedFamilies: Record<string, string> = {};
        for (const capsule of learnedCapsules.toSorted(
          (a, b) => Number(b.kind === 'style') - Number(a.kind === 'style'),
        ))
          if (
            capsule.source.templateId &&
            capsule.source.familyId &&
            !selectedFamilies[capsule.source.templateId]
          )
            selectedFamilies[capsule.source.templateId] = capsule.source.familyId;
        const composedTemplate = loadedTemplates.length
          ? composeTemplateApplications(loadedTemplates, selectedFamilies)
          : undefined;
        let template: TemplateApplication | undefined = composedTemplate?.application;
        if (template && reusePublishedStoryboard) {
          template = {
            ...template,
            visual: generationInput.options!.templateVisual as TemplateApplication['visual'],
          };
        } else if (template) {
          generationInput = bindTemplateApplication(generationInput, template);
          if (loadedTemplates[0]?.visual && this.options.capabilityMemory) {
            templateCapsules = await this.options.capabilityMemory.learn(
              this.scope,
              loadedTemplates[0].visual,
            );
          }
          generationInput = {
            ...generationInput,
            options: {
              ...generationInput.options,
              templateStyleVisual: composedTemplate?.styleVisual ?? loadedTemplates[0]?.visual,
            },
          };
        }
        if (!reusePublishedStoryboard)
          generationInput = bindDeckVisualSystem(
            generationInput,
            createDeckVisualSystem(generationInput, template),
          );
        if (needsInitialContent && this.options.contentCompiler?.prepareVisualDirection) {
          publisher?.publish({
            jobId,
            type: PRESENTATION_JOB_EVENT_TYPES.progress,
            data: {
              activity: '正在根据整份资料和已学模板规划各页选材与统一画风',
              phase: 'planner',
            },
          });
          generationInput = await this.options.contentCompiler.prepareVisualDirection(
            generationInput,
            { scope: this.scope, signal: controller.signal },
          );
          entry.input = clone(generationInput);
          await this.save(entry);
        }
        const compiledInput =
          this.options.contentCompiler && needsInitialContent
            ? await this.ensureContentIntents(generationInput, jobId, controller.signal)
            : generationInput;
        generationInput = reusePublishedStoryboard
          ? compiledInput
          : rebalanceMixedLessonStages(compiledInput);
        const content = generationInput.options?.contentIntents as
          Awaited<ReturnType<PresentationContentCompiler['compile']>> | undefined;
        if (content?.inputFingerprint)
          this.recordHandoff(
            entry,
            'content',
            'deck',
            content.inputFingerprint,
            content.slides,
            this.options.agentRoutingFingerprint,
          );
        if (generationInput !== compiledInput) {
          if (entry.plan)
            entry.plan = rebasePlanForLessonStages(entry.plan, compiledInput, generationInput);
          delete entry.draftCheckpoint;
          delete entry.revisionCheckpoint;
          delete entry.preparedAssets;
          entry.job.slideCount = generationInput.slideCount ?? entry.job.slideCount;
        }
        entry.input = clone(generationInput);
        await this.save(entry);
        if (!reusePublishedStoryboard) {
          const preflight = await this.prepareStoryboardLayout(
            entry,
            generationInput,
            learnedCapsules,
            controller.signal,
          );
          generationInput = preflight.input;
          learnedCapsules = preflight.capsules;
        }
        if (template && !reusePublishedStoryboard) {
          generationInput = await this.ensureVisualStoryboard(
            generationInput,
            template,
            jobId,
            controller.signal,
            publisher,
          );
          const storyboard = generationInput.options?.visualStoryboard as
            PresentationVisualStoryboard | undefined;
          if (storyboard?.inputFingerprint)
            this.recordHandoff(
              entry,
              'storyboard',
              'deck',
              storyboard.inputFingerprint,
              storyboard,
              this.options.agentRoutingFingerprint,
            );
          if (
            !(entry.plan && entry.initialAssetsComplete) &&
            !entry.plan?.designSpec?.templateVisualReview &&
            entry.preparedAssets?.initial &&
            !preparedAssetsMatchLearnedTemplate(entry.preparedAssets.initial, generationInput)
          ) {
            const preparedAssets = { ...entry.preparedAssets };
            delete preparedAssets.initial;
            entry.preparedAssets = preparedAssets;
            entry.initialAssetsComplete = false;
          }
          entry.input = clone(generationInput);
          await this.save(entry);
        }
        if (!reusePublishedStoryboard)
          generationInput = bindDeckVisualSystem(
            generationInput,
            createDeckVisualSystem(generationInput, template),
          );
        const deckVisualSystem = readDeckVisualSystem(generationInput);
        // Compiled content changes invalidate prepared art even without a template.
        if (
          !(entry.plan && entry.initialAssetsComplete) &&
          !entry.plan?.designSpec?.templateVisualReview &&
          entry.preparedAssets?.initial &&
          !preparedAssetsMatchLearnedTemplate(entry.preparedAssets.initial, generationInput)
        ) {
          const preparedAssets = { ...entry.preparedAssets };
          delete preparedAssets.initial;
          entry.preparedAssets = preparedAssets;
          entry.initialAssetsComplete = false;
        }
        // Restore completed asset bindings before checking coverage. The original job input
        // may predate asset preparation even though its checkpoint is already complete.
        if (
          !entry.plan &&
          entry.initialAssetsComplete &&
          preparedAssetsMatchLearnedTemplate(entry.preparedAssets?.initial, generationInput)
        ) {
          generationInput = bindDeckVisualSystem(
            clone(entry.preparedAssets.initial.input),
            deckVisualSystem,
          );
        }
        // A resume can inherit compiled intents whose required raster slot never received an
        // asset (a page split or a compile after the initial asset pass). Re-run the assets
        // step for them instead of letting the planner ship a page with a missing figure.
        if (
          !entry.plan?.designSpec?.templateVisualReview &&
          requiresAssetPreparation(generationInput, entry.plan)
        ) {
          const preparedAssets = { ...entry.preparedAssets };
          delete preparedAssets.initial;
          entry.preparedAssets = preparedAssets;
          entry.initialAssetsComplete = false;
          entry.input = clone(generationInput);
          await this.save(entry);
        }
        const slots = (generationInput.options as { imageSlots?: unknown[] } | undefined)
          ?.imageSlots;
        const imageArtifactIds: string[] = [
          ...new Set([
            ...(entry.job.artifactIds ?? []).filter((id) => id.startsWith('image-')),
            ...Object.values(entry.preparedAssets ?? {}).flatMap(
              (prepared) => prepared.assetArtifactIds,
            ),
          ]),
        ];
        if (!entry.plan && Array.isArray(slots) && slots.length > 0) {
          if (controller.signal.aborted) return;
          const validatedSlots: ImageGenerationSlot[] = slots.map((rawSlot, index) => {
            if (!rawSlot || typeof rawSlot !== 'object') {
              throw Object.assign(new Error(`imageSlots[${index}] must be an object`), {
                code: 'PRESENTATION_INVALID',
                path: `options.imageSlots[${index}]`,
              });
            }
            const slot = rawSlot as Record<string, unknown>;
            const slotId =
              typeof slot.slotId === 'string' && slot.slotId.trim()
                ? slot.slotId.trim()
                : `slot-${index + 1}`;
            const slideId =
              typeof slot.slideId === 'string' && slot.slideId.trim()
                ? slot.slideId.trim()
                : `slide-${index + 1}`;
            const prompt =
              typeof slot.prompt === 'string' && slot.prompt.trim()
                ? slot.prompt.trim()
                : undefined;
            if (!prompt) {
              throw Object.assign(new Error(`imageSlots[${index}].prompt is required`), {
                code: 'PRESENTATION_INVALID',
                path: `options.imageSlots[${index}].prompt`,
              });
            }
            const idempotencyKey =
              typeof slot.idempotencyKey === 'string' && slot.idempotencyKey.trim()
                ? slot.idempotencyKey.trim()
                : `${jobId}:${slideId}:${slotId}`;
            const content = readContentIntents(generationInput).find((c) => c.slideId === slideId);
            if (
              content?.visuals &&
              !content.visuals.some((v) => v.id === slotId && isRasterVisual(v))
            )
              throw Object.assign(
                new Error(
                  `Image slot ${slideId}/${slotId} must match a compiled raster visual, not a formula or precise chart`,
                ),
                { code: 'PRESENTATION_INVALID' },
              );
            return {
              ...slot,
              idempotencyKey,
              prompt,
              slideId,
              slotId,
            } as ImageGenerationSlot;
          });

          const subject = (slot: Pick<ImageGenerationSlot, 'slideId' | 'slotId'>) =>
            JSON.stringify([slot.slideId, slot.slotId]);
          const prior = Array.isArray(entry.input.options?.generatedImageSlots)
            ? (entry.input.options.generatedImageSlots as ImageGenerationSlotOutput[])
            : [];
          const ready = new Map<string, ImageGenerationSlotOutput>();
          const pending: ImageGenerationSlot[] = [];
          for (const slot of validatedSlots) {
            const key = subject(slot);
            const receipt = entry.stageHandoffs?.['image:' + key];
            const saved = prior.find((item) => subject(item) === key);
            if (
              receipt?.schemaVersion === 1 &&
              receipt.inputVersion === designFingerprint(slot) &&
              saved &&
              receipt.outputVersion === designFingerprint(saved)
            ) {
              const digests = await this.imageHandoffDigests(saved);
              if (
                digests &&
                designFingerprint(digests) === designFingerprint(receipt.assetDigests)
              ) {
                ready.set(key, saved);
                continue;
              }
            }
            pending.push(slot);
          }
          if (pending.length) {
            if (!this.options.imageGenerationCapability)
              throw Object.assign(new Error('Image generation provider is not configured'), {
                code: 'PROVIDER_UNAVAILABLE',
              });
            const generated = this.options.atomicRuntime
              ? await this.options.atomicRuntime.invoke<
                  Awaited<ReturnType<ImageGenerationCapability['generate']>>
                >(
                  'presentation.assets.generate',
                  { slots: pending },
                  { scope: this.scope, jobId, signal: controller.signal },
                )
              : await this.options.imageGenerationCapability.generate(this.scope, pending, {
                  jobId,
                  signal: controller.signal,
                });
            for (const slot of generated.slots) ready.set(subject(slot), slot);
          }
          const images = validatedSlots.flatMap((slot) => {
            const result = ready.get(subject(slot));
            return result ? [result] : [];
          });
          imageArtifactIds.push(...images.flatMap(slotAssetIds));
          generationInput = {
            ...generationInput,
            options: {
              ...generationInput.options,
              generatedImageSlots: images.map((slot) => {
                const visual = readContentIntents(generationInput)
                  .find((c) => c.slideId === slot.slideId)
                  ?.visuals?.find((v) => v.id === slot.slotId && isRasterVisual(v));
                return {
                  ...slot,
                  ...(visual
                    ? {
                        visualBinding: {
                          visualId: visual.id,
                          kind: visual.kind,
                          origin: 'generated',
                        },
                      }
                    : {}),
                };
              }),
              imageSlots: validatedSlots,
            },
          };
          // Commit the asset handoff before page authors start. A restart must
          // recover owned slot bindings as well as the generation event history.
          entry.input = clone(generationInput);
          for (const slot of entry.input.options!
            .generatedImageSlots as ImageGenerationSlotOutput[]) {
            const key = subject(slot);
            const request = validatedSlots.find((item) => subject(item) === key)!;
            const digests = await this.imageHandoffDigests(slot);
            if (digests)
              this.recordHandoff(
                entry,
                'image',
                key,
                designFingerprint(request),
                slot,
                undefined,
                digests,
              );
          }
          entry.job.artifactIds = [
            ...new Set([...(entry.job.artifactIds ?? []), ...imageArtifactIds]),
          ];
          await this.save(entry);
        }
        do {
          if (controller.signal.aborted) return;
          const versionId = randomUUID();
          const revisionContext = this.options.contextFactory(`${jobId}-${versionId}`);
          const progressPublisher: PresentationJobEventPublisherPort | undefined = publisher
            ? {
                scope: publisher.scope,
                assertScope: (scope) => publisher.assertScope(scope),
                dispose: () => undefined,
                publish: ((event: PresentationJobEventPublishInput) => {
                  const data = event.data as Record<string, unknown>;
                  return publisher.publish({
                    ...event,
                    type: /completed|failed|cancelled/.test(event.type)
                      ? PRESENTATION_JOB_EVENT_TYPES.progress
                      : event.type,
                    idempotencyKey: event.idempotencyKey
                      ? `${versionId}:${event.idempotencyKey}`
                      : undefined,
                    data: {
                      ...data,
                      job: {
                        ...(data?.job as object),
                        ...entry.job,
                        messages: clone(entry.job.messages),
                        revisions: clone(entry.job.revisions),
                        state: 'running',
                      },
                    },
                  });
                }) as PresentationJobEventPublisherPort['publish'],
              }
            : undefined;
          const design = !entry.plan ? initialDesignPlan(generationInput) : undefined;
          if (
            design &&
            entry.initialAssetsComplete === false &&
            !Array.isArray(slots) &&
            this.options.revisionAssetPlanner
          ) {
            progressPublisher?.publish({
              jobId,
              type: PRESENTATION_JOB_EVENT_TYPES.progress,
              data: { activity: '正在设计各页的素材与留白', phase: 'assets' },
              idempotencyKey: 'initial-asset-design',
            });
            const prepared =
              entry.preparedAssets?.initial ??
              (await this.prepareAssets(
                generationInput,
                design,
                {
                  content: '根据完整需求、逐页大纲与模板视觉规范设计初始素材，页面尚未排版。',
                  requestId: 'initial-assets',
                  target: { type: 'deck' },
                },
                jobId,
                controller.signal,
                progressPublisher,
              ));
            entry.preparedAssets = { ...entry.preparedAssets, initial: prepared };
            generationInput = bindDeckVisualSystem(
              this.bindAgentRouting(prepared.input),
              deckVisualSystem,
            );
            entry.preparedAssets.initial = { ...prepared, input: clone(generationInput) };
            imageArtifactIds.push(...prepared.assetArtifactIds);
            entry.initialAssetsComplete = true;
            entry.input = clone(generationInput);
            await this.save(entry);
          }
          // A resumed job may have finished asset preparation but failed before
          // the first complete plan. Rehydrate its owned refs/layouts, not just
          // artifact IDs; the planner otherwise sees a required image with no href.
          if (
            !entry.plan &&
            entry.initialAssetsComplete &&
            entry.preparedAssets?.initial &&
            preparedAssetsMatchLearnedTemplate(entry.preparedAssets.initial, generationInput)
          ) {
            generationInput = bindDeckVisualSystem(
              this.bindAgentRouting(clone(entry.preparedAssets.initial.input)),
              deckVisualSystem,
            );
          }
          const initialAssetPlanning =
            !entry.plan?.designSpec?.templateVisualReview &&
            entry.initialAssetsComplete === false &&
            !Array.isArray(slots) &&
            !!this.options.revisionAssetPlanner;
          generationInput = this.bindAgentRouting(generationInput);
          const draftFingerprint = createHash('sha256')
            .update(JSON.stringify(generationInput))
            .digest('hex');
          const publishSlideDraft = async (slide: PresentationPlan['slides'][number]) => {
            slide = prepareLessonDraft(slide, generationInput);
            if (controller.signal.aborted) return;
            const previousDrafts =
              entry.draftCheckpoint?.fingerprint === draftFingerprint
                ? entry.draftCheckpoint.slides
                : [];
            const embedded = await this.embedOwnedAssets({
              planId: 'draft',
              title: input.title,
              aspectRatio: input.aspectRatio ?? '16:9',
              sourceVersionIds: [...input.sourceVersionIds],
              slides: [slide],
            });
            const draftDigest = createHash('sha256').update(slide.svg).digest('hex').slice(0, 16);
            // Artifacts are immutable. A revised preview needs a new identity and event.
            const artifactId = `${jobId}:${versionId}:draft:${slide.slideId}:${draftDigest}`;
            const artifact = await this.options.artifactStore.put(this.scope, {
              artifactId,
              bytes: new TextEncoder().encode(embedded.slides[0].svg),
              type: 'svg',
              mimeType: 'image/svg+xml',
              name: `${slide.slideId}.svg`,
              status: 'ready',
              metadata: {
                ...slide.metadata,
                notes: slide.notes,
                jobId,
                versionId,
                slideId: slide.slideId,
                order: slide.order,
                slideNumber: slide.order,
                aspectRatio: input.aspectRatio,
                draft: true,
              },
            });
            this.recordHandoff(
              entry,
              'page',
              slide.slideId,
              draftFingerprint,
              { svg: slide.svg, notes: slide.notes, blocks: slide.metadata?.contentBlocks },
              this.options.agentRoutingFingerprint,
            );
            entry.draftCheckpoint = {
              fingerprint: draftFingerprint,
              slides: [
                ...previousDrafts.filter((s) => s.slideId !== slide.slideId),
                clone(slide),
              ].sort((a, b) => a.order - b.order),
            };
            entry.job.artifactIds = [...new Set([...(entry.job.artifactIds ?? []), artifactId])];
            await this.save(entry);
            progressPublisher?.publish({
              jobId,
              type: PRESENTATION_JOB_EVENT_TYPES.artifactReady,
              idempotencyKey: `draft:${slide.slideId}:${draftDigest}`,
              data: {
                artifact,
                artifactIds: entry.job.artifactIds,
                activity: `第 ${slide.order} 页草稿已就绪`,
                currentSlide: slide.order,
                totalSlides: input.slideCount,
                phase: 'planner',
              },
            });
          };
          const produced = await this.options.capability.execute(this.scope, generationInput, {
            ...revisionContext,
            initialPlan: entry.plan,
            preparePlan: async (initialPlan) => {
              let plan = initialPlan;
              entry.plan = clone(plan);
              await this.save(entry);
              if (initialAssetPlanning) {
                const initialRevision: PresentationMessageInput = {
                  content: (input.prompt || input.title).slice(0, 4000),
                  requestId: 'initial-assets',
                  target: { type: 'deck' },
                };
                const prepared =
                  entry.preparedAssets?.initial ??
                  (await this.prepareAssets(
                    generationInput,
                    plan,
                    initialRevision,
                    jobId,
                    controller.signal,
                    progressPublisher,
                  ));
                entry.preparedAssets = {
                  ...entry.preparedAssets,
                  initial: prepared,
                };
                await this.save(entry);
                generationInput = this.bindAgentRouting(prepared.input);
                imageArtifactIds.push(...prepared.assetArtifactIds);
                if (
                  prepared.assetArtifactIds.length > 0 ||
                  prepared.intents.some((intent) => intent.action !== 'reuse')
                ) {
                  plan = await this.options.capability.plan(generationInput, {
                    scope: this.scope,
                    abortSignal: controller.signal,
                    basePlan: plan,
                    revision: initialRevision,
                    template,
                    jobId,
                    trustedImages: await this.readTrustedImages([
                      ...this.planAssetIds(plan, initialRevision.target),
                      ...prepared.assetArtifactIds,
                      ...trustedTemplatePageRefs(template),
                    ]),
                  });
                }
              }
              entry.initialAssetsComplete = true;
              entry.plan = clone(plan);
              entry.job.slideCount = plan.slides.length;
              await this.save(entry);
              for (;;) {
                if (controller.signal.aborted)
                  throw Object.assign(new Error('Presentation cancelled'), {
                    code: 'PRESENTATION_WORKER_CANCELLED',
                  });
                const message = entry.job.messages?.find((message) => message.status === 'queued');
                if (!message) break;
                message.status = 'applying';
                delete message.error;
                await this.save(entry);
                await this.publishSnapshot(entry, PRESENTATION_JOB_EVENT_TYPES.progress);
                if (!message.versionId) {
                  if (
                    reusePublishedStoryboard &&
                    !editsPublishedObject(message, entry.job.versionId!)
                  ) {
                    // A broad instruction may arrive while a scoped edit is already running.
                    // Template changes and content compilation map their own new storyboard below.
                    reusePublishedStoryboard = false;
                    if (
                      template &&
                      !message.template &&
                      (message.patch || !this.options.contentCompiler)
                    ) {
                      generationInput = await this.ensureVisualStoryboard(
                        generationInput,
                        template,
                        jobId,
                        controller.signal,
                        progressPublisher,
                      );
                      entry.input = clone(generationInput);
                      const board = generationInput.options?.visualStoryboard as
                        PresentationVisualStoryboard | undefined;
                      if (board)
                        this.recordHandoff(
                          entry,
                          'storyboard',
                          'deck',
                          board.inputFingerprint,
                          board,
                          this.options.agentRoutingFingerprint,
                        );
                    }
                    if (loadedTemplates[0]?.visual && this.options.capabilityMemory)
                      templateCapsules = await this.options.capabilityMemory.learn(
                        this.scope,
                        loadedTemplates[0].visual,
                      );
                  }
                  if (
                    !message.patch &&
                    !message.tableDataPatch &&
                    !message.chartDataPatch &&
                    !message.objectPositionPatch &&
                    !message.canvasCommand &&
                    !message.annotation
                  )
                    generationInput = applyTeacherLessonInstruction(generationInput, message);
                  if (
                    !message.patch &&
                    !message.tableDataPatch &&
                    !message.chartDataPatch &&
                    !message.objectPositionPatch &&
                    !message.canvasCommand &&
                    !message.annotation &&
                    this.options.contentCompiler
                  ) {
                    generationInput = await this.ensureContentIntents(
                      {
                        ...generationInput,
                        options: {
                          ...generationInput.options,
                          contentRevision: {
                            content: message.content,
                            requestId: message.requestId,
                            target: message.target,
                          },
                        },
                      },
                      jobId,
                      controller.signal,
                    );
                    if (template)
                      generationInput = await this.ensureVisualStoryboard(
                        generationInput,
                        template,
                        jobId,
                        controller.signal,
                        progressPublisher ?? publisher,
                      );
                    entry.input = clone(generationInput);
                    await this.save(entry);
                  }
                  if (message.template) {
                    template = await this.ensureTemplateApplication(
                      message.template,
                      jobId,
                      controller.signal,
                      progressPublisher ?? publisher,
                    );
                    templateCapsules =
                      template.visual && this.options.capabilityMemory
                        ? await this.options.capabilityMemory.learn(this.scope, template.visual)
                        : [];
                    generationInput = bindTemplateApplication(generationInput, template);
                    generationInput = await this.ensureVisualStoryboard(
                      generationInput,
                      template,
                      jobId,
                      controller.signal,
                      progressPublisher ?? publisher,
                    );
                    entry.input = clone(generationInput);
                    await this.save(entry);
                  }
                  // A preview can inline an image that the editable source references by ID.
                  // All undoable edits snapshot the same source, including direct typing.
                  const editable =
                    message.canvasCommand ??
                    message.tableDataPatch ??
                    message.chartDataPatch ??
                    message.objectPositionPatch ??
                    (message.annotation?.textRuns ? message.annotation : undefined);
                  if (editable && message.target.type === 'slide') {
                    const source = plan.slides[message.target.slideNumber - 1];
                    if (source) {
                      const artifactId = `${entry.job.jobId}:${editable.expectedVersionId}:canvas-source:${source.slideId}`;
                      if (!(await this.options.artifactStore.get(this.scope, artifactId)))
                        await this.options.artifactStore.put(this.scope, {
                          artifactId,
                          type: 'document',
                          mimeType: 'application/json',
                          name: 'canvas-source.json',
                          bytes: new TextEncoder().encode(JSON.stringify(source)),
                        });
                    }
                  }
                  if (
                    message.tableDataPatch ||
                    message.chartDataPatch ||
                    message.objectPositionPatch
                  ) {
                    try {
                      const runtime = this.options.atomicRuntime;
                      const updated = message.tableDataPatch
                        ? applyTableDataPatch(plan, generationInput, message)
                        : message.chartDataPatch
                          ? await applyChartDataPatch(plan, generationInput, message)
                          : {
                              input: generationInput,
                              ...(await applyObjectPositionPatch(
                                plan,
                                message,
                                runtime
                                  ? (move) =>
                                      runtime.invoke<CanvasRect>('canvas.object.move', move, {
                                        jobId,
                                        scope: this.scope,
                                        signal: controller.signal,
                                      })
                                  : moveCanvasObject,
                              )),
                            };
                      plan = updated.plan;
                      generationInput = updated.input;
                      entry.input = clone(generationInput);
                      this.recordHandoff(
                        entry,
                        'page',
                        updated.slideId,
                        designFingerprint(
                          message.tableDataPatch ??
                            message.chartDataPatch ??
                            message.objectPositionPatch,
                        ),
                        plan.slides.find((page) => page.slideId === updated.slideId),
                      );
                    } catch (error) {
                      throw Object.assign(
                        error instanceof Error ? error : new Error('对象修改无法保存'),
                        { code: 'PRESENTATION_INVALID' },
                      );
                    }
                  } else if (message.canvasCommand) {
                    plan = await this.applyCanvasCommand(entry, plan, message);
                    const index =
                      message.target.type === 'slide' ? message.target.slideNumber - 1 : -1;
                    const meta = plan.slides[index]?.metadata;
                    const outline = generationInput.options?.outline;
                    if (meta && Array.isArray(outline)) {
                      generationInput = {
                        ...generationInput,
                        options: {
                          ...generationInput.options,
                          outline: outline.map((o, i) =>
                            i === index
                              ? {
                                  ...o,
                                  ...(typeof meta.title === 'string' && { title: meta.title }),
                                  ...(Array.isArray(meta.outline) && { keyPoints: meta.outline }),
                                }
                              : o,
                          ),
                        },
                      };
                      entry.input = clone(generationInput);
                    }
                  } else if (message.patch) {
                    const patch = {
                      plan,
                      slideId: message.patch.slideId,
                      svg: message.patch.svg,
                      notes: message.patch.notes,
                    };
                    plan = this.options.atomicRuntime
                      ? await this.options.atomicRuntime.invoke<PresentationPlan>(
                          'presentation.slide.replace',
                          patch,
                          { scope: this.scope, jobId, signal: controller.signal },
                        )
                      : validatePresentationPlan({
                          ...plan,
                          slides: plan.slides.map((slide) =>
                            slide.slideId === message.patch!.slideId
                              ? { ...slide, ...message.patch }
                              : slide,
                          ),
                        });
                  } else {
                    if (message.annotation) validateAnnotation(plan, message);
                    let prepared = message.annotation
                      ? { input: generationInput, assetArtifactIds: [] as string[], intents: [] }
                      : preparedAssetsMatchLearnedTemplate(
                            entry.preparedAssets?.[`message:${message.requestId}`],
                            generationInput,
                          )
                        ? entry.preparedAssets?.[`message:${message.requestId}`]
                        : undefined;
                    if (!prepared) {
                      progressPublisher?.publish({
                        jobId,
                        type: PRESENTATION_JOB_EVENT_TYPES.progress,
                        idempotencyKey: `assets:${message.requestId}`,
                        data: { activity: '正在规划各页素材', phase: 'assets' },
                      });
                      prepared = await this.prepareAssets(
                        generationInput,
                        plan,
                        message,
                        jobId,
                        controller.signal,
                        progressPublisher,
                      );
                    }
                    entry.preparedAssets = {
                      ...entry.preparedAssets,
                      [`message:${message.requestId}`]: prepared,
                    };
                    await this.save(entry);
                    generationInput = this.bindAgentRouting(prepared.input);
                    imageArtifactIds.push(...prepared.assetArtifactIds);
                    progressPublisher?.publish({
                      jobId,
                      type: PRESENTATION_JOB_EVENT_TYPES.progress,
                      idempotencyKey: `layout:${message.requestId}`,
                      data: {
                        activity:
                          message.target.type === 'slide'
                            ? `正在排版第 ${message.target.slideNumber} 页`
                            : '素材已就绪，正在排版页面',
                        phase: 'planner',
                      },
                    });
                    const base = plan;
                    const revised = message.annotation?.textRuns
                      ? applyCanvasText(plan, message)
                      : await this.options.capability.plan(generationInput, {
                          ...revisionContext.plannerContext,
                          userContentRevision: !message.annotation,
                          scope: this.scope,
                          abortSignal: controller.signal,
                          basePlan: plan,
                          revision: message,
                          completedRevisionSlideIds:
                            entry.revisionCheckpoint?.requestId === message.requestId
                              ? entry.revisionCheckpoint.completedSlideIds
                              : [],
                          onRevisionSlide: async (partial: PresentationPlan, slideId: string) => {
                            const prior =
                              entry.revisionCheckpoint?.requestId === message.requestId
                                ? entry.revisionCheckpoint.completedSlideIds
                                : [];
                            entry.revisionCheckpoint = {
                              requestId: message.requestId,
                              completedSlideIds: [...new Set([...prior, slideId])],
                            };
                            entry.plan = clone(applyRevisionScope(base, partial, message.target));
                            await this.save(entry);
                            progressPublisher?.publish({
                              jobId,
                              type: PRESENTATION_JOB_EVENT_TYPES.progress,
                              idempotencyKey: `layout:${message.requestId}:${slideId}`,
                              data: {
                                activity: `第 ${partial.slides.find((s) => s.slideId === slideId)?.order ?? '?'} 页已排版，继续下一页`,
                                phase: 'planner',
                              },
                            });
                          },
                          trustedImages: await this.readTrustedImages([
                            ...this.planAssetIds(plan, message.target),
                            ...prepared.assetArtifactIds,
                            ...trustedTemplatePageRefs(template),
                          ]),
                          template,
                          jobId,
                        });
                    plan = applyRevisionScope(base, revised, message.target);
                    const outline = generationInput.options?.outline;
                    if (Array.isArray(outline)) {
                      const target = message.target;
                      const updatedOutline = outline.map((item, index) => {
                        if (target.type === 'slide' && target.slideNumber !== index + 1)
                          return item;
                        const meta = plan.slides[index]?.metadata;
                        if (message.annotation)
                          return item &&
                            typeof meta?.title === 'string' &&
                            meta.title !== base.slides[index]?.metadata?.title
                            ? { ...item, title: meta.title }
                            : item;
                        return meta && item
                          ? {
                              ...item,
                              ...(typeof meta.title === 'string' ? { title: meta.title } : {}),
                              ...(Array.isArray(meta.outline) ? { keyPoints: meta.outline } : {}),
                            }
                          : item;
                      });
                      generationInput = {
                        ...generationInput,
                        options: { ...generationInput.options, outline: updatedOutline },
                      };
                      entry.input = clone(generationInput);
                    }
                  }
                }
                if (controller.signal.aborted)
                  throw Object.assign(new Error('Presentation cancelled'), {
                    code: 'PRESENTATION_WORKER_CANCELLED',
                  });
                entry.plan = clone(plan);
                if (entry.revisionCheckpoint?.requestId === message.requestId)
                  delete entry.revisionCheckpoint;
                message.versionId = versionId;
                // Keep applying until the revised pages and deck are actually persisted.
                await this.save(entry);
              }
              const applying =
                entry.job.messages?.filter(
                  (message) => message.status === 'applying' && message.versionId,
                ) ?? [];
              // Run on both fresh and resumed revisions. An already composed drag
              // still owns its exact drop coordinates when publication is retried.
              for (const edit of applying) {
                const cmd = edit.canvasCommand;
                if (
                  edit.target.type !== 'slide' ||
                  (cmd?.kind !== 'translate' && cmd?.kind !== 'moveMany')
                )
                  continue;
                const index = edit.target.slideNumber - 1;
                const ids =
                  cmd.kind === 'translate'
                    ? [cmd.object]
                    : cmd.moves.filter((move) => move.dx || move.dy).map((move) => move.object);
                const page = recordCanvasPlacement(plan.slides[index], edit.requestId, ids);
                if (page !== plan.slides[index])
                  plan = {
                    ...plan,
                    slides: plan.slides.map((slide, i) => (i === index ? page : slide)),
                  };
              }
              const editedSlideIds =
                entry.job.versionId &&
                applying.length &&
                applying.every(({ target }) => target.type === 'slide')
                  ? new Set(
                      applying.flatMap(({ target }) =>
                        target.type === 'slide'
                          ? [plan.slides[target.slideNumber - 1].slideId]
                          : [],
                      ),
                    )
                  : undefined;
              // Region edits have already spliced their selected SVG spans. The critic can
              // inspect the entire deck; no layout, frame or repair may rewrite those spans' peers.
              const reflowableSlideIds =
                editedSlideIds &&
                new Set(
                  [...editedSlideIds].filter((slideId) => {
                    const edits = applying.filter(
                      ({ target }) =>
                        target.type === 'deck' ||
                        plan.slides[target.slideNumber - 1]?.slideId === slideId,
                    );
                    return !edits.every(
                      (edit) => edit.canvasCommand || edit.annotation || edit.tableDataPatch,
                    );
                  }),
                );
              const exactObjectSlideIds = new Set(
                plan.slides
                  .filter((slide) => {
                    const edits = applying.filter(
                      ({ target }) =>
                        target.type === 'deck' ||
                        plan.slides[target.slideNumber - 1]?.slideId === slide.slideId,
                    );
                    return (
                      edits.length > 0 &&
                      edits.every(
                        (edit) =>
                          edit.canvasCommand || edit.chartDataPatch || edit.objectPositionPatch,
                      )
                    );
                  })
                  .map((slide) => slide.slideId),
              );
              // Replay typed content through the current renderer, including retained pages
              // from older checkpoints. The critic must inspect what this version exports.
              if (plan.designSpec?.contentPolicyVersion === 1)
                plan = {
                  ...plan,
                  slides: await Promise.all(
                    plan.slides.map(async (slide) => {
                      if (reflowableSlideIds && !reflowableSlideIds.has(slide.slideId))
                        return slide;
                      const blocks = slide.metadata?.contentBlocks;
                      if (!Array.isArray(blocks) || !blocks.length) return slide;
                      try {
                        const rendered = await renderSemanticBlocks(
                          semanticAuthoringSvg(slide.svg, blocks),
                          blocks,
                        );
                        return { ...slide, svg: rendered.svg };
                      } catch (error) {
                        if (!/Cannot recover editable content anchor/u.test(String(error))) {
                          // A saved slot may predate the current native renderer's minimum size.
                          // Refit it through its learned layout before retrying the same content.
                          if (
                            !slide.metadata?.compiledDesign ||
                            !learnedCapsules.length ||
                            exactObjectSlideIds.has(slide.slideId)
                          )
                            throw error;
                          const resized = await stabilizePresentationVisuals(
                            plan,
                            template,
                            learnedCapsules,
                            'pre-review',
                            new Set([slide.slideId]),
                          );
                          const updated = resized.slides.find(
                            (item) => item.slideId === slide.slideId,
                          );
                          if (!updated?.metadata?.compiledDesign) throw error;
                          return updated;
                        }
                        const intent = readContentIntents(generationInput).find(
                          (item) => item.slideId === slide.slideId,
                        );
                        const system = readDeckVisualSystem(generationInput);
                        if (!intent || !system) throw error;
                        const role = deckPageRole(generationInput, slide.slideId, slide.order);
                        const recovered = await recoverSemanticSlideLayout({
                          aspectRatio: plan.aspectRatio,
                          intent,
                          rawBlocks: blocks,
                          title: String(slide.metadata?.title ?? ''),
                          deckBody: deckBodyRegion(system, role),
                          visibleContent: Array.isArray(slide.metadata?.outline)
                            ? (slide.metadata.outline as string[])
                            : [],
                          imageRefs: presentationImageRefs(slide.svg),
                        });
                        return {
                          ...slide,
                          svg: renderDeckVisualFrame(recovered.svg, system, {
                            title: String(slide.metadata?.title ?? ''),
                            role,
                            order: slide.order,
                            total: plan.slides.length,
                          }),
                          metadata: {
                            ...slide.metadata,
                            contentBlocks: recovered.blocks,
                            layoutRecovered: true,
                          },
                          notes: [
                            slide.notes,
                            'overflowNotes' in recovered ? recovered.overflowNotes : undefined,
                          ]
                            .filter(Boolean)
                            .join('\n'),
                        };
                      }
                    }),
                  ),
                };
              const currentMaster = readDeckVisualSystem(generationInput);
              if (currentMaster)
                plan = {
                  ...plan,
                  slides: plan.slides.map((slide) =>
                    slide.metadata?.deckVisualSystemId &&
                    (!reflowableSlideIds || reflowableSlideIds.has(slide.slideId))
                      ? {
                          ...slide,
                          svg: renderDeckVisualFrame(slide.svg, currentMaster, {
                            title: String(slide.metadata?.title ?? ''),
                            role: deckPageRole(generationInput, slide.slideId, slide.order),
                            order: slide.order,
                            total: plan.slides.length,
                          }),
                        }
                      : slide,
                  ),
                };
              plan = bindLessonPlan(plan, generationInput, reflowableSlideIds);
              const priorReview = initialPlan.designSpec?.templateVisualReview as
                | {
                    final?: PresentationVisualReview;
                    authoredVersion?: string;
                  }
                | undefined;
              // User-authored transforms and clipboard transactions deliberately allow
              // overlapping objects. Keep the reviewed generation as provenance and run
              // the normal document, PPT Master and native-data checks for this version.
              const manual =
                entry.job.delivery?.versionId === entry.job.versionId &&
                entry.job.versionId &&
                priorReview?.final?.passed &&
                applying.length > 0 &&
                applying.every(
                  (edit) =>
                    edit.canvasCommand ||
                    edit.objectPositionPatch ||
                    edit.annotation?.textRuns ||
                    edit.tableDataPatch ||
                    edit.chartDataPatch,
                );
              if (manual) {
                plan = {
                  ...plan,
                  designSpec: {
                    ...plan.designSpec,
                    templateVisualReview: {
                      mode: 'manual-canvas',
                      authoredVersion: priorReview.authoredVersion ?? entry.job.versionId,
                      baseVersion: entry.job.versionId,
                      planFingerprint: planVisualFingerprint(plan),
                      reviewedAt: this.now(),
                      final: {
                        schemaVersion: 1,
                        passed: true,
                        issues: [],
                        summary: '画布修改已通过文稿结构检查。导出时继续校验整稿和原生对象。',
                      } satisfies PresentationVisualReview,
                    },
                  },
                };
              } else {
                plan = await this.reviewAndRepairVisualPlan(
                  plan,
                  generationInput,
                  template,
                  jobId,
                  controller.signal,
                  progressPublisher,
                  reflowableSlideIds,
                  exactObjectSlideIds,
                );
              }
              imageArtifactIds.push(...this.planAssetIds(plan));
              if (this.options.capabilityMemory && !reusePublishedStoryboard)
                plan = {
                  ...plan,
                  designSpec: {
                    ...plan.designSpec,
                    retrievedCapabilityIds: learnedCapsules.map(({ id }) => id),
                    learnedCapabilityIds: [
                      ...new Set([
                        ...appliedLearnedCapabilityIds(learnedCapsules, plan),
                        ...appliedTemplateCapsuleIds(templateCapsules, plan),
                      ]),
                    ],
                  },
                };
              plan = bindLessonPlan(plan, generationInput, reflowableSlideIds);
              const visualDirection = presentationVisualDirectionSchema.safeParse(
                generationInput.options?.visualDirection,
              );
              if (visualDirection.success)
                plan = {
                  ...plan,
                  slides: plan.slides.map((slide) => ({
                    ...slide,
                    metadata: {
                      ...slide.metadata,
                      autonomousVisualDecision: visualDirection.data.slides.find(
                        (page) => page.slideId === slide.slideId,
                      ),
                      illustrationStyle: visualDirection.data.illustrationStyle,
                    },
                  })),
                };
              if (editedSlideIds) {
                plan = {
                  ...plan,
                  slides: plan.slides.map((slide, index) =>
                    editedSlideIds.has(slide.slideId) ? slide : initialPlan.slides[index],
                  ),
                };
              }
              entry.plan = clone(plan);
              const review = plan.designSpec?.templateVisualReview;
              if (review)
                this.recordHandoff(
                  entry,
                  'review',
                  'deck',
                  planVisualFingerprint(plan),
                  review,
                  this.options.agentRoutingFingerprint,
                );
              await this.save(entry);
              // Publish the repaired draft even when final quality review still blocks export.
              // Otherwise the stage keeps showing the original, visibly broken composition.
              for (const slide of plan.slides) {
                const shown = entry.draftCheckpoint?.slides.find(
                  (draft) => draft.slideId === slide.slideId,
                );
                if (shown && shown.svg !== slide.svg) await publishSlideDraft(slide);
              }
              assertPresentationPublishable(plan);
              if (plan.designSpec?.deckVisualSystem && deckVisualSystem)
                assertDeckVisualConsistency(plan, deckVisualSystem);
              const embedded = await this.embedOwnedAssets(
                plan,
                learnedCapsules,
                editedSlideIds && entry.job.versionId
                  ? { jobId, previousVersionId: entry.job.versionId, editedSlideIds }
                  : undefined,
              );
              const tableEdits = applying.filter((edit) => edit.tableDataPatch);
              if (tableEdits.length) {
                const nativePages = revisionContext.workerContext.nativeData
                  ? prepareNativeDataExport(embedded.slides)
                  : [];
                for (const edit of tableEdits) {
                  const page =
                    edit.target.type === 'slide' && nativePages[edit.target.slideNumber - 1];
                  if (
                    !page ||
                    !page.tables.some((table) => table.blockId === edit.tableDataPatch!.blockId)
                  )
                    throw Object.assign(
                      new Error('当前版本无法将修改的表格导出为可编辑的 PowerPoint 表格'),
                      { code: 'PRESENTATION_INVALID' },
                    );
                }
              }
              return embedded;
            },
            plannerContext: {
              ...context.plannerContext,
              resumeSlides:
                !entry.plan && entry.draftCheckpoint?.fingerprint === draftFingerprint
                  ? entry.draftCheckpoint.slides
                  : undefined,
              onSlideStart: (page: number) => {
                progressPublisher?.publish({
                  jobId,
                  type: PRESENTATION_JOB_EVENT_TYPES.progress,
                  idempotencyKey: `composing:${page}`,
                  data: {
                    activity: `正在排版第 ${page} 页`,
                    currentSlide: page,
                    totalSlides: input.slideCount,
                    phase: 'planner',
                  },
                });
              },
              onSlideDraft: publishSlideDraft,
              template,
              trustedImages: await this.readTrustedImages([
                ...imageArtifactIds,
                ...trustedTemplatePageRefs(template),
              ]),
              jobId,
              abortSignal: controller.signal,
              scope: this.scope,
            },
            workerContext: {
              ...revisionContext.workerContext,
              jobId,
              versionId,
              abortSignal: controller.signal,
            },
            ...(progressPublisher
              ? { eventPublisher: progressPublisher, eventScope: this.scope }
              : {}),
          });
          if (controller.signal.aborted) return;
          // preparePlan already saved the editable reference plan. The pipeline result
          // contains the render-only copy with embedded image bytes.
          if (!entry.plan && produced.plan) entry.plan = clone(produced.plan);
          const artifactIds = [
            ...new Set([
              ...imageArtifactIds,
              ...produced.artifacts.map((artifact) => artifact.artifactId),
            ]),
          ];
          if (produced.artifacts.some((artifact) => artifact.status === 'failed')) {
            throw Object.assign(new Error('Some presentation files could not be saved'), {
              code: 'ARTIFACT_STORE_UNAVAILABLE',
            });
          }
          for (const message of entry.job.messages ?? []) {
            if (message.status === 'applying') {
              message.status = 'applied';
              delete message.error;
              message.versionId = versionId;
            }
          }
          if (entry.plan)
            this.recordHandoff(
              entry,
              'export',
              versionId,
              planVisualFingerprint(entry.plan),
              produced.artifacts.map(({ artifactId }) => artifactId),
              this.options.agentRoutingFingerprint,
            );
          entry.job.delivery = deliveryFromArtifacts(versionId, produced.artifacts);
          entry.job.versionId = versionId;
          entry.job.revisions = [
            ...(entry.job.revisions ?? []),
            { artifactIds, createdAt: this.now(), versionId },
          ];
          update({ artifactIds });
          await this.save(entry);
          await this.publishSnapshot(entry, PRESENTATION_JOB_EVENT_TYPES.progress);
        } while (entry.job.messages?.some((message) => message.status === 'queued'));
        if (this.options.capabilityMemory && entry.plan) {
          try {
            const appliedIds = entry.plan.designSpec?.learnedCapabilityIds;
            const verifiedIds = new Set(
              Array.isArray(appliedIds)
                ? appliedIds.filter((id): id is string => typeof id === 'string')
                : [],
            );
            const recipes = await this.options.capabilityMemory.learnRecipes(
              this.scope,
              entry.plan,
              template?.visual,
            );
            recipes.forEach((capsule) => verifiedIds.add(capsule.id));
            await this.options.capabilityMemory.recordOutcome(this.scope, {
              jobId,
              plan: entry.plan,
              capsuleIds: [...verifiedIds],
              result: 'passed',
            });
            entry.plan = {
              ...entry.plan,
              designSpec: {
                ...entry.plan.designSpec,
                learnedCapabilityIds: [...verifiedIds],
                learningStatus: 'verified',
              },
            };
          } catch {
            entry.plan = {
              ...entry.plan,
              designSpec: { ...entry.plan.designSpec, learningStatus: 'not-promoted' },
            };
          }
        }
        if (entry.job.collaboration) {
          entry.job.collaboration.automaticAttempts = 0;
          delete entry.job.collaboration.lastErrorCode;
        }
        update({ state: 'completed' });
        await this.save(entry);
        await this.publishSnapshot(entry, PRESENTATION_JOB_EVENT_TYPES.completed);
      } finally {
        publisher?.dispose();
      }
    } catch (error) {
      if (entry.lease?.signal.aborted) return;
      if (controller.signal.reason?.code === 'PRESENTATION_TASK_TIMEOUT') {
        entry.job.state = 'waiting_input';
        entry.job.error = undefined;
        entry.job.collaboration ??= { mode: 'adaptive', automaticAttempts: 0, decisions: [] };
        entry.job.collaboration.lastErrorCode = 'PRESENTATION_TASK_TIMEOUT';
        entry.job.collaboration.decisions = [
          ...entry.job.collaboration.decisions.slice(-19),
          createPresentationDecision('provider', randomUUID(), this.now()),
        ];
        for (const message of entry.job.messages ?? [])
          if (message.status === 'applying' && !revisionIsComposed(entry, message))
            message.status = 'queued';
        await this.save(entry);
        await this.publishSnapshot(entry, PRESENTATION_JOB_EVENT_TYPES.progress);
        return;
      }
      if (this.disposed) {
        entry.job = { ...entry.job, state: 'queued', error: undefined, updatedAt: this.now() };
        for (const message of entry.job.messages ?? [])
          if (message.status === 'applying' && !revisionIsComposed(entry, message))
            message.status = 'queued';
        await this.save(entry);
        return;
      }
      if (!controller.signal.aborted && this.options.collaborationHook) {
        const collaboration = entry.job.collaboration ?? {
          mode: 'adaptive' as const,
          automaticAttempts: 0,
          decisions: [],
        };
        const now = Date.parse(this.now());
        const foreground = await this.isForeground(jobId, now);
        const resolution = await this.options
          .collaborationHook(
            {
              code: errorSnapshot(error).code,
              mode: collaboration.mode,
              foreground,
              automaticAttempts: collaboration.automaticAttempts,
            },
            { scope: this.scope, jobId },
          )
          .catch(() => undefined);
        if (resolution && resolution.action !== 'fail' && !controller.signal.aborted) {
          collaboration.lastErrorCode = errorSnapshot(error).code;
          entry.job.collaboration = collaboration;
          for (const message of entry.job.messages ?? [])
            if (message.status === 'applying' && !revisionIsComposed(entry, message))
              message.status = 'queued';
          if (resolution.action === 'ask') {
            const decision = createPresentationDecision(
              resolution.category,
              randomUUID(),
              this.now(),
            );
            const cause = error instanceof Error ? error.cause : undefined;
            const nativeFailure =
              error instanceof NativeSlideQualityError
                ? error
                : cause instanceof NativeSlideQualityError
                  ? cause
                  : undefined;
            collaboration.decisions = [
              ...collaboration.decisions.slice(-19),
              nativeFailure
                ? { ...decision, detail: nativeFailure.message + decision.detail }
                : decision,
            ];
            update({ state: 'waiting_input', error: undefined });
          } else {
            collaboration.automaticAttempts++;
            update({ state: 'queued', error: undefined });
          }
          await this.save(entry);
          await this.publishSnapshot(entry, PRESENTATION_JOB_EVENT_TYPES.progress);
          if (resolution.action === 'retry') {
            entry.retryTimer = setTimeout(() => {
              entry.retryTimer = undefined;
              if (this.disposed || entry.controller.signal.aborted || entry.job.state !== 'queued')
                return;
              entry.controller = new AbortController();
              entry.task = this.run(entry);
            }, 1500 * collaboration.automaticAttempts);
          }
          return;
        }
      }
      if (this.options.capabilityMemory && entry.plan && !controller.signal.aborted) {
        const capsuleIds = entry.plan.designSpec?.learnedCapabilityIds;
        if (Array.isArray(capsuleIds))
          await this.options.capabilityMemory
            .recordOutcome(this.scope, {
              jobId,
              plan: entry.plan,
              capsuleIds: capsuleIds.filter((id): id is string => typeof id === 'string'),
              result: 'failed',
            })
            .catch(() => undefined);
      }
      for (const message of entry.job.messages ?? []) {
        if (message.status === 'applying' && !revisionIsComposed(entry, message)) {
          message.status = 'failed';
          message.error = error instanceof Error ? error.message : 'Revision failed';
        }
      }
      update({
        state: controller.signal.aborted ? 'cancelled' : 'failed',
        error: controller.signal.aborted ? undefined : errorSnapshot(error),
      });
      await this.save(entry).catch(() => undefined);
      await this.publishSnapshot(
        entry,
        controller.signal.aborted
          ? PRESENTATION_JOB_EVENT_TYPES.cancelled
          : PRESENTATION_JOB_EVENT_TYPES.failed,
      ).catch(() => undefined);
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      release?.();
      releaseCapacity?.();
      entry.lease?.signal.removeEventListener('abort', leaseLost);
      await entry.persistence.catch(() => undefined);
      // A synchronous edit or retry may already be handing this lease to its next run.
      if (!entry.mutating) await this.releaseEntryLease(entry);
      entry.localTask = false;
    }
  }
}

export const createPresentationGenerationPort = (
  options: PresentationGenerationPortOptions,
  scope: PresentationGenerationPortScope,
): PresentationGenerationPort => new PresentationGenerationPort(options, scope);
