import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import { assertPresentationPublishable } from './content-quality';
import { lessonHandout } from './lesson';
import { validatePresentationPlan } from './planner';
import {
  createPresentationArtifactSnapshot,
  createPresentationJobSnapshot,
  PRESENTATION_JOB_EVENT_TYPES,
  type PresentationEventScope,
  PresentationJobEventPublisherError,
  type PresentationJobEventPublisherPort,
} from './publisher';

export interface PresentationWorkerWorkspace {
  cleanup?: () => void | Promise<void>;
  readonly path: string;
  write: (relativePath: string, content: string | Uint8Array) => void | Promise<void>;
}

export interface PresentationWorkerArtifact {
  artifactId?: string;
  bytes: Uint8Array;
  metadata?: Record<string, unknown>;
  mimeType: string;
  name: string;
  type: string;
}

export interface PresentationQualityReport {
  details?: Record<string, unknown>;
  passed: boolean;
  score?: number;
}

export interface PresentationWorkerContext {
  readonly abortSignal?: AbortSignal;
  readonly convert: (
    workspacePath: string,
    signal?: AbortSignal,
  ) => Promise<readonly PresentationWorkerArtifact[]>;
  readonly eventPublisher?: PresentationJobEventPublisherPort;
  readonly eventScope?: PresentationEventScope;
  readonly jobId: string;
  /** Short aliases for callers constructing a worker context by hand. */
  readonly publisher?: PresentationJobEventPublisherPort;
  readonly qualityCheck: (
    workspacePath: string,
    signal?: AbortSignal,
  ) => Promise<PresentationQualityReport>;
  readonly scope?: PresentationEventScope;
  readonly versionId?: string;
  readonly workspace: PresentationWorkerWorkspace;
}

export interface PresentationWorkerResult {
  artifacts: readonly PresentationWorkerArtifact[];
  jobId: string;
  planId: string;
  qualityReport: PresentationQualityReport;
}

export type PresentationWorkerErrorCode =
  | 'PRESENTATION_QUALITY_FAILED'
  | 'PRESENTATION_WORKER_CANCELLED'
  | 'PRESENTATION_WORKER_FAILED';

export class PresentationWorkerError extends Error {
  constructor(
    public readonly code: PresentationWorkerErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'PresentationWorkerError';
  }
}

const cloneValue = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const clone: Record<string, unknown> = Object.create(prototype) as Record<string, unknown>;
      for (const [key, nested] of Object.entries(value as Record<string, unknown>))
        clone[key] = cloneValue(nested);
      return clone as T;
    }
  }
  return value;
};

export const assertPresentationWorkerRelativePath = (relativePath: string): void => {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    /^[A-Z]:[\\/]/i.test(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new PresentationWorkerError(
      'PRESENTATION_WORKER_FAILED',
      `Workspace path is not relative: ${relativePath}`,
    );
  }
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted)
    throw new PresentationWorkerError(
      'PRESENTATION_WORKER_CANCELLED',
      'Presentation worker was cancelled',
    );
};

const publishWorkerEvent = (
  context: PresentationWorkerContext,
  type: string,
  state: 'running' | 'failed' | 'cancelled',
  idempotencyKey: string,
  extra: Record<string, unknown> = {},
  error?: unknown,
): void => {
  const publisher = context.eventPublisher ?? context.publisher;
  if (!publisher) return;
  const scope = context.eventScope ?? context.scope;
  publisher.assertScope(scope);
  const { artifactIds: _artifactIds, ...eventExtra } = extra;
  publisher.publish({
    data: {
      job: createPresentationJobSnapshot(context.jobId, state, {
        artifactIds: extra.artifactIds as readonly string[] | undefined,
        error,
      }),
      ...eventExtra,
    },
    idempotencyKey,
    jobId: context.jobId,
    type,
    ...(scope ? { scope } : {}),
  });
};

const publishWorkerProgress = (
  context: PresentationWorkerContext,
  type: string,
  idempotencyKey: string,
  extra: Record<string, unknown>,
): void => {
  try {
    publishWorkerEvent(context, type, 'running', idempotencyKey, extra);
  } catch {
    // Progress and preview publication are observational. A transient journal
    // failure must not destroy a presentation whose worker can still finish.
  }
};

export class InMemoryPresentationPlanWorker {
  async run(
    plan: PresentationPlan,
    context: PresentationWorkerContext,
  ): Promise<PresentationWorkerResult> {
    let qualityReportForEvent: PresentationQualityReport | undefined;
    if (context.abortSignal?.aborted) {
      const cancelled = new PresentationWorkerError(
        'PRESENTATION_WORKER_CANCELLED',
        'Presentation worker was cancelled',
      );
      try {
        publishWorkerEvent(
          context,
          PRESENTATION_JOB_EVENT_TYPES.cancelled,
          'cancelled',
          'terminal:cancelled',
          {},
          cancelled,
        );
      } catch (error) {
        if (error instanceof PresentationJobEventPublisherError) throw error;
      }
      throw cancelled;
    }
    const publisher = context.eventPublisher ?? context.publisher;
    if (publisher) publisher.assertScope(context.eventScope ?? context.scope);
    let validated: PresentationPlan;
    try {
      validated = validatePresentationPlan(plan);
      assertPresentationPublishable(validated);
    } catch (error) {
      try {
        publishWorkerEvent(
          context,
          PRESENTATION_JOB_EVENT_TYPES.failed,
          'failed',
          'terminal:failed',
          {},
          error,
        );
      } catch {
        // Keep PLAN_INVALID (or another validation error) authoritative.
      }
      throw error;
    }
    const { workspace } = context;
    try {
      publishWorkerEvent(
        context,
        PRESENTATION_JOB_EVENT_TYPES.workerStarted,
        'running',
        'phase:worker',
        { phase: 'worker' },
      );
      const previewArtifactIds: string[] = [];
      for (const [slideIndex, slide] of validated.slides.entries()) {
        const path = `svg_output/${String(slideIndex + 1).padStart(3, '0')}.svg`;
        assertPresentationWorkerRelativePath(path);
        await workspace.write(path, slide.svg);
        if (slide.notes?.trim())
          await workspace.write(`notes/${String(slideIndex + 1).padStart(3, '0')}.md`, slide.notes);
        const previewArtifactId = `${context.jobId}:${context.versionId ?? 'initial'}:preview:${slide.slideId}`;
        previewArtifactIds.push(previewArtifactId);
        publishWorkerProgress(
          context,
          PRESENTATION_JOB_EVENT_TYPES.artifactReady,
          `slide:${slide.slideId}:written`,
          {
            activity: `正在生成第 ${slideIndex + 1} 页`,
            artifact: {
              artifactId: previewArtifactId,
              metadata: {
                ...(typeof slide.metadata?.notes === 'string'
                  ? { notes: slide.metadata.notes }
                  : {}),
                ...(slide.notes !== undefined ? { notes: slide.notes } : {}),
                order: slideIndex + 1,
                slideNumber: slideIndex + 1,
                aspectRatio: validated.aspectRatio,
                slideId: slide.slideId,
                title:
                  typeof slide.metadata?.title === 'string'
                    ? slide.metadata.title
                    : `第 ${slideIndex + 1} 页`,
              },
              mimeType: 'image/svg+xml',
              name: `${slide.slideId}.svg`,
              sizeBytes: new TextEncoder().encode(slide.svg).byteLength,
              status: 'ready',
              type: 'svg',
              uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(slide.svg)}`,
            },
            artifactIds: [...previewArtifactIds],
            currentSlide: slideIndex + 1,
            phase: 'worker',
            progress: Math.round(28 + ((slideIndex + 1) / validated.slides.length) * 42),
            slideId: slide.slideId,
            totalSlides: validated.slides.length,
          },
        );
      }
      assertPresentationWorkerRelativePath('design_spec.json');
      await workspace.write(
        'design_spec.json',
        JSON.stringify(cloneValue(validated.designSpec ?? {})),
      );
      throwIfAborted(context.abortSignal);
      let qualityReport: PresentationQualityReport;
      try {
        publishWorkerProgress(context, PRESENTATION_JOB_EVENT_TYPES.progress, 'phase:quality', {
          activity: '正在检查版式与内容',
          phase: 'quality',
          progress: 76,
          totalSlides: validated.slides.length,
        });
        qualityReport = await context.qualityCheck(workspace.path, context.abortSignal);
        qualityReportForEvent = qualityReport;
      } catch (error) {
        throw new PresentationWorkerError(
          'PRESENTATION_QUALITY_FAILED',
          'Presentation quality check failed',
          error,
        );
      }
      if (!qualityReport.passed)
        throw new PresentationWorkerError(
          'PRESENTATION_QUALITY_FAILED',
          'Presentation quality check did not pass',
        );
      throwIfAborted(context.abortSignal);
      let artifacts: readonly PresentationWorkerArtifact[];
      try {
        publishWorkerProgress(context, PRESENTATION_JOB_EVENT_TYPES.progress, 'phase:export', {
          activity: '正在生成可编辑文件',
          phase: 'export',
          progress: 88,
          totalSlides: validated.slides.length,
        });
        artifacts = await context.convert(workspace.path, context.abortSignal);
        throwIfAborted(context.abortSignal);
      } catch (error) {
        throw new PresentationWorkerError(
          'PRESENTATION_WORKER_FAILED',
          'Presentation conversion failed',
          error,
        );
      }
      if (!Array.isArray(artifacts) || artifacts.length === 0)
        throw new PresentationWorkerError(
          'PRESENTATION_WORKER_FAILED',
          'Presentation conversion returned no artifacts',
        );
      const cloned = artifacts.map((artifact, index) => {
        if (
          !(artifact.bytes instanceof Uint8Array) ||
          artifact.bytes.byteLength === 0 ||
          !artifact.mimeType ||
          !artifact.type ||
          !artifact.name
        ) {
          throw new PresentationWorkerError(
            'PRESENTATION_WORKER_FAILED',
            'Converter returned an invalid artifact',
          );
        }
        return {
          ...artifact,
          artifactId: artifact.artifactId ?? `${context.jobId}:artifact:${index}`,
          bytes: new Uint8Array(artifact.bytes),
          metadata: artifact.metadata ? cloneValue(artifact.metadata) : undefined,
        };
      });
      const artifactPrefix = context.versionId
        ? `${context.jobId}:${context.versionId}`
        : context.jobId;
      const allArtifacts: PresentationWorkerArtifact[] = [
        ...(lessonHandout(validated)
          ? [
              {
                artifactId: `${artifactPrefix}:lesson-handout`,
                bytes: new TextEncoder().encode(lessonHandout(validated)!),
                mimeType: 'text/markdown',
                name: 'student-handout.md',
                type: 'document',
                metadata: {
                  artifactRole: 'student-handout',
                  versionId: context.versionId,
                  excludesTeacherNotes: true,
                },
              },
            ]
          : []),
        ...cloned
          .filter((artifact) => artifact.type !== 'svg')
          .map((artifact, index) => ({
            ...artifact,
            artifactId: `${artifactPrefix}:artifact:${index}`,
            metadata: { ...artifact.metadata, artifactRole: 'deck', versionId: context.versionId },
          })),
        ...validated.slides.map((slide, index) => ({
          artifactId: `${artifactPrefix}:slide:${slide.slideId ?? index + 1}`,
          bytes: new TextEncoder().encode(slide.svg),
          metadata: {
            ...slide.metadata,
            ...(slide.notes !== undefined ? { notes: slide.notes } : {}),
            artifactRole: 'slide',
            aspectRatio: validated.aspectRatio,
            jobId: context.jobId,
            order: slide.order,
            slideNumber: index + 1,
            slideId: slide.slideId,
            versionId: context.versionId,
            type: 'svg',
          },
          mimeType: 'image/svg+xml',
          name: `${slide.slideId ?? `slide-${index + 1}`}.svg`,
          type: 'svg',
        })),
      ];

      const snapshots = allArtifacts.map((artifact, index) =>
        createPresentationArtifactSnapshot(context.jobId, {
          ...artifact,
          artifactId: artifact.artifactId ?? `${context.jobId}:artifact:${index}`,
        }),
      );
      for (const [index, artifact] of snapshots.entries()) {
        publishWorkerEvent(
          context,
          PRESENTATION_JOB_EVENT_TYPES.artifactReady,
          'running',
          `artifact-ready:${artifact.artifactId}`,
          {
            artifact,
            artifactIds: snapshots.slice(0, index + 1).map(({ artifactId }) => artifactId),
          },
        );
      }
      return {
        artifacts: allArtifacts,
        jobId: context.jobId,
        planId: validated.planId,
        qualityReport: cloneValue(qualityReport),
      };
    } catch (error) {
      if (error instanceof PresentationJobEventPublisherError) throw error;
      const normalized =
        error instanceof PresentationWorkerError
          ? error
          : context.abortSignal?.aborted
            ? new PresentationWorkerError(
                'PRESENTATION_WORKER_CANCELLED',
                'Presentation worker was cancelled',
                error,
              )
            : new PresentationWorkerError(
                'PRESENTATION_WORKER_FAILED',
                'Presentation worker failed',
                error,
              );
      const cancelled = normalized.code === 'PRESENTATION_WORKER_CANCELLED';
      const qualityFailed = normalized.code === 'PRESENTATION_QUALITY_FAILED';
      try {
        publishWorkerEvent(
          context,
          cancelled
            ? PRESENTATION_JOB_EVENT_TYPES.cancelled
            : qualityFailed
              ? PRESENTATION_JOB_EVENT_TYPES.qualityFailed
              : PRESENTATION_JOB_EVENT_TYPES.failed,
          cancelled ? 'cancelled' : 'failed',
          cancelled
            ? 'terminal:cancelled'
            : qualityFailed
              ? 'terminal:quality-failed'
              : 'terminal:failed',
          qualityReportForEvent ? { qualityReport: qualityReportForEvent } : {},
          normalized,
        );
      } catch {
        // The original worker error remains authoritative if publication fails.
      }
      throw normalized;
    } finally {
      if (context.workspace.cleanup) await context.workspace.cleanup();
    }
  }
}
