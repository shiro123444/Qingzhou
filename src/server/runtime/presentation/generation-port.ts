import { createHash, randomUUID } from 'node:crypto';

import type {
  ArtifactSnapshot,
  ExportResult,
  PresentationJob,
  PresentationJobInput,
  PresentationMessageInput,
  PresentationPlan,
  PresentationPort,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { AtomicInvocation, AtomicRuntime } from '../atomic-runtime';
import { presentationActivity } from './activity';
import { validateAnnotation } from './annotation';
import type { PresentationArtifactStore, StoredArtifact } from './artifact-store';
import type { PresentationGenerationContextFactory } from './composition';
import type { PresentationJobRepository, StoredPresentationJob } from './file-storage';
import type { PresentationGenerationCapability } from './generation-capability';
import type { PresentationGenerationEventPublisherFactory } from './generation-handler';
import type { ImageGenerationCapability } from './image-generation-capability';
import type { ImageGenerationSlot } from './image-generation-planner';
import { initialDesignPlan } from './initial-design';
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
import { normalizePresentationSvg, normalizeRasterOpacity } from './svg-compatibility';
import type {
  FilePresentationTemplateLibrary,
  TemplateApplication,
  TemplateProfile,
  TemplateReference,
  TemplateVisualProfile,
} from './templates';
import { templateVisualNeedsInput, templateVisualNeedsRefresh } from './templates';
import type { PresentationVisualCritic, PresentationVisualReview } from './visual-critic';
import type {
  PresentationVisualStoryboard,
  PresentationVisualStoryboardPlanner,
} from './visual-storyboard';
import {
  presentationStoryboardInputFingerprint,
  presentationVisualStoryboardSchema,
} from './visual-storyboard';

export interface PresentationGenerationPortScope extends RuntimeScope {
  readonly request: Request;
}

export interface PresentationGenerationPortOptions {
  readonly artifactStore: PresentationArtifactStore;
  readonly atomicRuntime?: AtomicRuntime;
  readonly capability: PresentationGenerationCapability;
  readonly contextFactory: PresentationGenerationContextFactory;
  readonly eventPublisherFactory?: PresentationGenerationEventPublisherFactory;
  readonly idFactory?: () => string;
  readonly imageGenerationCapability?: ImageGenerationCapability;
  readonly now?: () => string;
  readonly repository?: PresentationJobRepository;
  readonly revisionAssetPlanner?: PresentationRevisionAssetPlanner;
  readonly templateLibrary?: FilePresentationTemplateLibrary;
  readonly visualCritic?: PresentationVisualCritic;
  readonly visualStoryboardPlanner?: PresentationVisualStoryboardPlanner;
}

interface JobEntry extends StoredPresentationJob {
  controller: AbortController;
  persistence: Promise<void>;
  task: Promise<void>;
}

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
        storyboard: storyboard
          ? {
              inputFingerprint: storyboard.inputFingerprint,
              schemaVersion: storyboard.schemaVersion,
              templateId: storyboard.templateId,
              versionId: storyboard.versionId,
            }
          : null,
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

const errorSnapshot = (error: unknown): PresentationJob['error'] => ({
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
export class PresentationGenerationPort implements PresentationPort {
  private readonly jobs = new Map<string, JobEntry>();
  private readonly loading = new Map<string, Promise<JobEntry | undefined>>();
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

  async createJob(input: PresentationJobInput): Promise<PresentationJob> {
    if (this.disposed)
      throw Object.assign(new Error('Presentation generation port is disposed'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    const normalizedInput = normalizeInput(input);
    if (!normalizedInput)
      throw Object.assign(new Error('notebookId, title and sourceVersionIds are required'), {
        code: 'PRESENTATION_INVALID',
      });
    const jobId = this.idFactory();
    const timestamp = this.now();
    const controller = new AbortController();
    const job: PresentationJob = {
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
    entry.task = this.run(jobId, normalizedInput, controller);
    return clone(job);
  }

  private save(entry: JobEntry): Promise<void> {
    const snapshot = clone({
      input: entry.input,
      job: entry.job,
      plan: entry.plan,
      preparedAssets: entry.preparedAssets,
      initialAssetsComplete: entry.initialAssetsComplete,
    });
    entry.persistence = entry.persistence
      .catch(() => undefined)
      .then(() => this.options.repository?.saveJob(this.scope, snapshot));
    return entry.persistence;
  }

  private async entry(jobId: string): Promise<JobEntry | undefined> {
    if (this.jobs.has(jobId)) return this.jobs.get(jobId);
    const pending = this.loading.get(jobId);
    if (pending) return pending;
    const load = (async () => {
      const stored = await this.options.repository?.getJob(this.scope, jobId);
      if (!stored) return undefined;
      const entry: JobEntry = {
        ...stored,
        controller: new AbortController(),
        task: Promise.resolve(),
        persistence: Promise.resolve(),
      };
      if (entry.job.state === 'running' || entry.job.state === 'queued') {
        entry.job.state = 'failed';
        entry.job.error = {
          code: 'PRESENTATION_INTERRUPTED',
          message:
            'Generation was interrupted. Your saved pages and instructions are available; retry to continue.',
        };
        for (const message of entry.job.messages ?? [])
          if (message.status === 'applying') message.status = 'queued';
      }
      await this.restoreOwnedAssetReferences(entry);
      this.jobs.set(jobId, entry);
      return entry;
    })().finally(() => this.loading.delete(jobId));
    this.loading.set(jobId, load);
    return load;
  }

  async sendMessage(jobId: string, input: PresentationMessageInput): Promise<PresentationJob> {
    if (this.disposed)
      throw Object.assign(new Error('Presentation provider is disposed'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    const entry = await this.entry(jobId);
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
      validateAnnotation(entry.plan, input);
      if (input.annotation.expectedVersionId !== entry.job.versionId)
        throw Object.assign(new Error('这一页已经更新，请重新标注后发送。'), {
          code: 'PRESENTATION_CONFLICT',
        });
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
        JSON.stringify(existing.annotation) !== JSON.stringify(input.annotation) ||
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
    if (!active) entry.task = this.run(jobId, entry.input, entry.controller);
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

  private async embedOwnedAssets(plan: PresentationPlan): Promise<PresentationPlan> {
    const slides = await Promise.all(
      plan.slides.map(async (slide) => {
        let svg = normalizePresentationSvg(slide.svg);
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
    return embedded;
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
    const entry = await this.entry(jobId);
    if (!entry)
      throw Object.assign(new Error(`Presentation job does not exist: ${jobId}`), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    if (entry.job.state === 'queued' || entry.job.state === 'running') {
      entry.controller.abort();
      entry.job = { ...entry.job, state: 'cancelled', updatedAt: this.now() };
      for (const message of entry.job.messages ?? [])
        if (message.status === 'applying') message.status = 'queued';
      await this.save(entry);
      await this.publishSnapshot(entry, PRESENTATION_JOB_EVENT_TYPES.cancelled);
    }
    return clone(entry.job);
  }

  async deleteJob(jobId: string): Promise<void> {
    const entry = await this.entry(jobId);
    if (!entry)
      throw Object.assign(new Error(`Presentation job does not exist: ${jobId}`), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    if (!this.options.repository?.removeJob)
      throw Object.assign(new Error('Presentation deletion is unavailable'), {
        code: 'PROVIDER_UNAVAILABLE',
      });

    entry.controller.abort();
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
    this.loading.delete(jobId);
  }

  async retryJob(jobId: string): Promise<PresentationJob> {
    const entry = await this.entry(jobId);
    if (!entry)
      throw Object.assign(new Error(`Presentation job does not exist: ${jobId}`), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    if (entry.job.state === 'running' || entry.job.state === 'queued') return clone(entry.job);
    entry.controller = new AbortController();
    entry.job.state = 'queued';
    await entry.task;
    if (entry.controller.signal.aborted) return clone(entry.job);
    entry.job.state = 'queued';
    entry.job.error = undefined;
    // Resume only the newest unfinished instruction. Older queued edits can
    // survive a provider failure when the user keeps working; replaying that
    // backlog would apply stale requests before the latest visible task.
    const unfinishedEdit = entry.job.messages?.findLast((message) => message.status !== 'applied');
    for (const message of entry.job.messages ?? []) {
      if (message === unfinishedEdit) {
        message.status = 'queued';
        delete message.error;
      } else if (message.status === 'queued' || message.status === 'applying') {
        message.status = 'failed';
        message.error = 'Skipped because a newer edit was resumed.';
      }
    }
    await this.save(entry);
    entry.task = this.run(jobId, entry.input, entry.controller);
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
    for (const ref of [...new Set(ids)].slice(-4)) {
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
    return template;
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
      | Partial<PresentationVisualStoryboard>
      | undefined;
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
  ): Promise<PresentationPlan> {
    if (!template?.visual || !this.options.visualCritic) return plan;
    const previous = plan.designSpec?.templateVisualReview as
      | { planFingerprint?: string; templateId?: string; versionId?: string }
      | undefined;
    if (
      previous?.templateId === template.templateId &&
      previous.versionId === template.versionId &&
      previous.planFingerprint === planVisualFingerprint(plan)
    ) {
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
      return canInvoke
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
        : this.options.visualCritic!.review(operationInput, { scope: this.scope, signal });
    };
    const initial = await review(plan);
    const corrections = initial.issues.filter((issue) => issue.severity !== 'minor');
    let repaired = plan;
    const repairedSlideIds: string[] = [];
    const repairFailures: Array<{ code: string; slideId: string }> = [];
    if (corrections.length) {
      publisher?.publish({
        data: { activity: '发现视觉偏差，正在做一次最小修正', phase: 'planner' },
        idempotencyKey: `template-repair:${template.versionId}`,
        jobId,
        type: PRESENTATION_JOB_EVENT_TYPES.progress,
      });
      const groups = new Map<string, typeof corrections>();
      for (const issue of corrections) {
        groups.set(issue.slideId, [...(groups.get(issue.slideId) ?? []), issue]);
      }
      for (const [slideId, issues] of [...groups].slice(0, 4)) {
        const slide = repaired.slides.find((item) => item.slideId === slideId);
        if (!slide) continue;
        const revision: PresentationMessageInput = {
          content: [
            '视觉复核后的最小修正。只修改本页 SVG 的层级、间距、构图锚点、可读性或模板气质；保留事实、文字含义、讲稿和所有现有图片引用，不生成新素材。',
            ...issues.map(
              (issue) =>
                `${issue.category}（${issue.severity}）：${issue.instruction}；证据：${issue.evidence}`,
            ),
          ]
            .join('\n')
            .slice(0, 4000),
          requestId: `template-visual-repair:${template.versionId}:${slideId}`,
          target: { slideNumber: slide.order, type: 'slide' },
        };
        try {
          const candidate = await this.options.capability.plan(input, {
            abortSignal: signal,
            basePlan: repaired,
            jobId,
            revision,
            scope: this.scope,
            template,
            trustedImages: await this.readTrustedImages([
              ...this.planAssetIds(repaired, revision.target),
              ...trustedTemplatePageRefs(template),
            ]),
          });
          const candidateSlide = candidate.slides.find((item) => item.slideId === slideId);
          if (!candidateSlide) {
            throw Object.assign(new Error(`visual repair omitted slide ${slideId}`), {
              code: 'PRESENTATION_REPAIR_INVALID',
            });
          }
          // A critic repair is deliberately narrower than a user revision: only the
          // rendered SVG may change. Keep page identity, outline metadata, speaker
          // notes, and asset associations exactly as they were before the repair.
          repaired = {
            ...repaired,
            planId: candidate.planId,
            slides: repaired.slides.map((item) =>
              item.slideId === slideId ? { ...item, svg: candidateSlide.svg } : item,
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
            idempotencyKey: `template-repair-skipped:${template.versionId}:${slideId}`,
            jobId,
            type: PRESENTATION_JOB_EVENT_TYPES.progress,
          });
        }
      }
    }
    let final = initial;
    let finalReviewError: string | undefined;
    if (repairedSlideIds.length) {
      try {
        final = await review(repaired);
      } catch (error) {
        if (signal.aborted) throw error;
        finalReviewError =
          error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'PRESENTATION_REVIEW_UNAVAILABLE';
      }
    }
    return {
      ...repaired,
      designSpec: {
        ...repaired.designSpec,
        templateVisualReview: {
          final,
          ...(finalReviewError ? { finalReviewError } : {}),
          initial,
          planFingerprint: planVisualFingerprint(repaired),
          ...(repairFailures.length ? { repairFailures } : {}),
          repaired: repairedSlideIds.length > 0,
          repairedSlideIds,
          reviewedAt: this.now(),
          templateId: template.templateId,
          versionId: template.versionId,
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
    publisher?: PresentationJobEventPublisherPort,
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
    'presentation.page.read',
    'presentation.page.replace',
    'presentation.job.message',
    'presentation.job.export',
    'presentation.template.fromJob',
    'presentation.template.list',
    'presentation.template.apply',
    'presentation.template.resolve',
  ]);
  async listJobs() {
    const persisted = (await this.options.repository?.listJobs?.(this.scope)) ?? [];
    const jobs = new Map(persisted.map((job) => [job.jobId, job]));
    for (const entry of this.jobs.values()) jobs.set(entry.job.jobId, entry.job);
    return {
      jobs: [...jobs.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 100)
        .map(clone),
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
  async executeOperation(name: string, input: unknown) {
    if (!this.options.atomicRuntime || !this.publicOperations.has(name))
      throw Object.assign(new Error('Operation not available through this presentation session'), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    return this.options.atomicRuntime.invoke(name, input, {
      scope: this.scope,
      services: { port: this },
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.jobs.values()) entry.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(({ task }) => task));
  }

  private async run(
    jobId: string,
    input: PresentationJobInput,
    controller: AbortController,
  ): Promise<void> {
    const update = (patch: Partial<PresentationJob>): void => {
      const entry = this.jobs.get(jobId);
      if (!entry) return;
      if (entry.job.state === 'cancelled' && patch.state !== 'cancelled') return;
      if (controller.signal.aborted && patch.state !== 'cancelled') return;
      entry.job = { ...entry.job, ...patch, updatedAt: this.now() };
    };
    // Defer one turn so createJob can return the queued snapshot first.
    await Promise.resolve();
    if (controller.signal.aborted) {
      update({ state: 'cancelled' });
      return;
    }
    update({ state: 'running' });
    const entry = this.jobs.get(jobId)!;
    let release: (() => void) | undefined;
    try {
      release = await this.options.atomicRuntime?.acquire('presentation');
      const context = this.options.contextFactory(jobId);
      const publisher = this.options.eventPublisherFactory
        ? await this.options.eventPublisherFactory(this.scope, jobId, this.scope.request)
        : undefined;
      try {
        await this.save(entry);
        publisher?.publish({
          data: { job: clone(entry.job) },
          idempotencyKey: `state:running:${entry.job.updatedAt}`,
          jobId,
          scope: this.scope,
          type: PRESENTATION_JOB_EVENT_TYPES.progress,
        });
        let generationInput = clone(input);
        let template: TemplateApplication | undefined;
        if (generationInput.template) {
          template = await this.ensureTemplateApplication(
            {
              templateId: generationInput.template,
              versionId: generationInput.options?.templateVersionId as string | undefined,
            },
            jobId,
            controller.signal,
            publisher,
          );
          generationInput = bindTemplateApplication(generationInput, template);
          generationInput = await this.ensureVisualStoryboard(
            generationInput,
            template,
            jobId,
            controller.signal,
            publisher,
          );
          if (
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
        const slots = (generationInput.options as { imageSlots?: unknown[] } | undefined)
          ?.imageSlots;
        let imageArtifactIds: string[] = [
          ...new Set([
            ...(entry.job.artifactIds ?? []).filter((id) => id.startsWith('image-')),
            ...Object.values(entry.preparedAssets ?? {}).flatMap(
              (prepared) => prepared.assetArtifactIds,
            ),
          ]),
        ];
        if (!entry.plan && Array.isArray(slots) && slots.length > 0) {
          if (controller.signal.aborted) return;
          if (!this.options.imageGenerationCapability) {
            throw Object.assign(new Error('Image generation provider is not configured'), {
              code: 'PROVIDER_UNAVAILABLE',
            });
          }
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
            return {
              ...slot,
              idempotencyKey,
              prompt,
              slideId,
              slotId,
            } as ImageGenerationSlot;
          });

          const images = this.options.atomicRuntime
            ? await this.options.atomicRuntime.invoke<
                Awaited<ReturnType<ImageGenerationCapability['generate']>>
              >(
                'presentation.assets.generate',
                { slots: validatedSlots },
                { scope: this.scope, jobId, signal: controller.signal },
              )
            : await this.options.imageGenerationCapability.generate(this.scope, validatedSlots, {
                jobId,
                signal: controller.signal,
              });
          imageArtifactIds = (images.slots ?? []).flatMap((slot) =>
            (slot.assetRefs ?? []).map((ref) => ref.ref.trim()),
          );
          generationInput = {
            ...generationInput,
            options: {
              ...generationInput.options,
              generatedImageSlots: images.slots,
              imageSlots: validatedSlots,
            },
          };
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
            generationInput = prepared.input;
            imageArtifactIds.push(...prepared.assetArtifactIds);
            entry.initialAssetsComplete = true;
            await this.save(entry);
          }
          const initialAssetPlanning =
            entry.initialAssetsComplete === false &&
            !Array.isArray(slots) &&
            !!this.options.revisionAssetPlanner;
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
                generationInput = prepared.input;
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
                  if (message.template) {
                    template = await this.ensureTemplateApplication(
                      message.template,
                      jobId,
                      controller.signal,
                      progressPublisher ?? publisher,
                    );
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
                  if (message.patch) {
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
                    generationInput = prepared.input;
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
                    plan = await this.options.capability.plan(generationInput, {
                      ...revisionContext.plannerContext,
                      scope: this.scope,
                      abortSignal: controller.signal,
                      basePlan: plan,
                      revision: message,
                      trustedImages: await this.readTrustedImages([
                        ...this.planAssetIds(plan, message.target),
                        ...prepared.assetArtifactIds,
                        ...trustedTemplatePageRefs(template),
                      ]),
                      template,
                      jobId,
                    });
                  }
                }
                if (controller.signal.aborted)
                  throw Object.assign(new Error('Presentation cancelled'), {
                    code: 'PRESENTATION_WORKER_CANCELLED',
                  });
                entry.plan = clone(plan);
                message.versionId = versionId;
                // Keep applying until the revised pages and deck are actually persisted.
                await this.save(entry);
              }
              plan = await this.reviewAndRepairVisualPlan(
                plan,
                generationInput,
                template,
                jobId,
                controller.signal,
                progressPublisher,
              );
              entry.plan = clone(plan);
              await this.save(entry);
              return await this.embedOwnedAssets(plan);
            },
            plannerContext: {
              ...context.plannerContext,
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
              onSlideDraft: async (slide: PresentationPlan['slides'][number]) => {
                if (controller.signal.aborted) return;
                const embedded = await this.embedOwnedAssets({
                  planId: 'draft',
                  title: input.title,
                  aspectRatio: input.aspectRatio ?? '16:9',
                  sourceVersionIds: [...input.sourceVersionIds],
                  slides: [slide],
                });
                const artifactId = `${jobId}:${versionId}:draft:${slide.slideId}`;
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
                entry.job.artifactIds = [
                  ...new Set([...(entry.job.artifactIds ?? []), artifactId]),
                ];
                await this.save(entry);
                progressPublisher?.publish({
                  jobId,
                  type: PRESENTATION_JOB_EVENT_TYPES.artifactReady,
                  idempotencyKey: `draft:${slide.slideId}`,
                  data: {
                    artifact,
                    artifactIds: entry.job.artifactIds,
                    activity: `第 ${slide.order} 页草稿已就绪`,
                    currentSlide: slide.order,
                    totalSlides: input.slideCount,
                    phase: 'planner',
                  },
                });
              },
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
          entry.job.versionId = versionId;
          entry.job.revisions = [
            ...(entry.job.revisions ?? []),
            { artifactIds, createdAt: this.now(), versionId },
          ];
          update({ artifactIds });
          await this.save(entry);
          await this.publishSnapshot(entry, PRESENTATION_JOB_EVENT_TYPES.progress);
        } while (entry.job.messages?.some((message) => message.status === 'queued'));
        update({ state: 'completed' });
        await this.save(entry);
        await this.publishSnapshot(entry, PRESENTATION_JOB_EVENT_TYPES.completed);
      } finally {
        publisher?.dispose();
      }
    } catch (error) {
      for (const message of entry.job.messages ?? []) {
        if (message.status === 'applying') {
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
      release?.();
    }
  }
}

export const createPresentationGenerationPort = (
  options: PresentationGenerationPortOptions,
  scope: PresentationGenerationPortScope,
): PresentationGenerationPort => new PresentationGenerationPort(options, scope);
