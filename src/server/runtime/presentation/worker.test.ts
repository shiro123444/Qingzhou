import { describe, expect, it, vi } from 'vitest';

import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import { PresentationJobEventJournal } from './job-event-journal';
import { PRESENTATION_JOB_EVENT_TYPES, PresentationJobEventPublisher } from './publisher';
import {
  assertPresentationWorkerRelativePath,
  InMemoryPresentationPlanWorker,
  PresentationWorkerError,
} from './worker';

const plan: PresentationPlan = {
  planId: 'plan-1',
  title: 'Deck',
  aspectRatio: '16:9',
  sourceVersionIds: ['v-1'],
  designSpec: { theme: { name: 'light' } },
  slides: [
    { slideId: 's-1', order: 0, svg: '<svg><rect /></svg>', metadata: { nested: { ok: true } } },
    { slideId: 's-2', order: 1, svg: '<svg><circle /></svg>' },
  ],
};

const context = (overrides: Partial<Parameters<InMemoryPresentationPlanWorker['run']>[1]> = {}) => {
  const writes = new Map<string, string | Uint8Array>();
  const sourceBytes = new Uint8Array([1, 2]);
  const sourceMetadata = { nested: { ok: true } };
  return {
    writes,
    sourceBytes,
    sourceMetadata,
    context: {
      jobId: 'job-1',
      workspace: {
        path: '/workspace',
        write: vi.fn(async (path, content) => {
          writes.set(path, content);
        }),
        cleanup: vi.fn(),
      },
      qualityCheck: vi.fn(async () => ({ passed: true, details: { score: 1 } })),
      convert: vi.fn(async () => [
        {
          bytes: sourceBytes,
          mimeType: 'application/vnd.test',
          name: 'deck.pptx',
          type: 'pptx',
          metadata: sourceMetadata,
        },
      ]),
      ...overrides,
    },
  };
};

const expectCode = async (operation: Promise<unknown>, code: string) =>
  expect(operation).rejects.toMatchObject({ code });

describe('C-52 presentation plan worker', () => {
  it('never exports or publishes artifacts for a plan with unresolved major review issues', async () => {
    const { context: ctx } = context();
    await expect(
      new InMemoryPresentationPlanWorker().run(
        {
          ...plan,
          designSpec: {
            templateVisualReview: { final: { passed: false, issues: [{ severity: 'major' }] } },
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'PRESENTATION_QUALITY_FAILED' });
    expect(ctx.convert).not.toHaveBeenCalled();
    expect(ctx.workspace.write).not.toHaveBeenCalled();
  });
  it('projects speaker notes into live previews and saved slide artifacts without losing legacy metadata notes', async () => {
    const journal = new PresentationJobEventJournal();
    const publisher = new PresentationJobEventPublisher(journal);
    const withNotes: PresentationPlan = {
      ...plan,
      slides: [
        {
          ...plan.slides[0]!,
          metadata: { notes: 'Outdated metadata notes' },
          notes: '介绍产品愿景。\n停顿后进入演示。',
        },
        { ...plan.slides[1]!, metadata: { notes: 'Legacy notes to preserve' } },
        {
          ...plan.slides[1]!,
          metadata: { notes: 'Explicitly cleared notes' },
          notes: '',
          order: 2,
          slideId: 's-3',
        },
      ],
    };
    const { context: ctx, writes } = context({
      eventPublisher: publisher,
      versionId: 'notes-version',
    });
    const result = await new InMemoryPresentationPlanWorker().run(withNotes, ctx);
    const expected = [withNotes.slides[0]!.notes, 'Legacy notes to preserve', ''];
    expect(writes.get('notes/001.md')).toBe(expected[0]);
    expect(
      result.artifacts
        .filter((artifact) => artifact.type === 'svg')
        .map((artifact) => artifact.metadata?.notes),
    ).toEqual(expected);
    const previews = journal.replay('job-1').flatMap((event) => {
      const artifact = (
        event.data as { artifact?: { artifactId?: string; metadata?: { notes?: string } } }
      ).artifact;
      return artifact?.artifactId?.includes(':preview:') ? [artifact.metadata?.notes] : [];
    });
    expect(previews).toEqual(expected);
    expect(withNotes.slides[0]!.metadata?.notes).toBe('Outdated metadata notes');
  });

  it('materializes stable UTF-8 layout and returns defensive artifact copies', async () => {
    const { context: ctx, writes, sourceBytes, sourceMetadata } = context();
    const result = await new InMemoryPresentationPlanWorker().run(plan, ctx);
    expect([...writes.keys()]).toEqual([
      'svg_output/001.svg',
      'svg_output/002.svg',
      'design_spec.json',
      'spec_lock.md',
    ]);
    expect(writes.get('design_spec.json')).toContain('light');
    result.artifacts[0]!.bytes[0] = 9;
    (result.artifacts[0]!.metadata!.nested as { ok: boolean }).ok = false;
    expect(result.artifacts[0]!.bytes).toEqual(new Uint8Array([9, 2]));
    expect(sourceBytes).toEqual(new Uint8Array([1, 2]));
    expect(sourceMetadata).toEqual({ nested: { ok: true } });
    expect(result.qualityReport.passed).toBe(true);
  });

  it('gates conversion on quality and maps conversion failures', async () => {
    const quality = context({ qualityCheck: vi.fn(async () => ({ passed: false })) });
    await expect(
      new InMemoryPresentationPlanWorker().run(plan, quality.context),
    ).rejects.toMatchObject({
      code: 'PRESENTATION_QUALITY_FAILED',
      message: 'Presentation quality check did not pass',
    });
    expect(quality.context.convert).not.toHaveBeenCalled();
    const failed = context({
      convert: vi.fn(async () => {
        throw new Error('convert');
      }),
    });
    await expectCode(
      new InMemoryPresentationPlanWorker().run(plan, failed.context),
      'PRESENTATION_WORKER_FAILED',
    );
  });

  it('rejects cancellation and invalid plans before work', async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = context({ abortSignal: controller.signal });
    await expectCode(
      new InMemoryPresentationPlanWorker().run(plan, cancelled.context),
      'PRESENTATION_WORKER_CANCELLED',
    );
    const traversal = context();
    traversal.context.workspace.write = vi.fn(async (path) => {
      if (path.startsWith('/')) throw new Error('absolute');
    });
    await expectCode(
      new InMemoryPresentationPlanWorker().run(
        { ...plan, slides: [{ ...plan.slides[0]!, order: 2 }] },
        traversal.context,
      ),
      'PLAN_INVALID',
    );
    expect(PresentationWorkerError).toBeDefined();
  });

  it('rejects workspace path traversal and accepts stable relative paths', () => {
    for (const path of ['/tmp/x', 'C:\\x', '../x', 'a//b']) {
      expect(() => assertPresentationWorkerRelativePath(path)).toThrowError(
        expect.objectContaining({ code: 'PRESENTATION_WORKER_FAILED' }),
      );
    }
    expect(() => assertPresentationWorkerRelativePath('svg_output/001.svg')).not.toThrow();
  });

  it('publishes worker-started and artifact-ready snapshots without binary payloads', async () => {
    const journal = new PresentationJobEventJournal();
    const publisher = new PresentationJobEventPublisher(journal);
    const result = await new InMemoryPresentationPlanWorker().run(
      plan,
      context({ eventPublisher: publisher }).context,
    );

    expect(result.artifacts).toHaveLength(3);
    const events = journal.replay('job-1');
    expect(events[0]?.type).toBe(PRESENTATION_JOB_EVENT_TYPES.workerStarted);
    expect(events.map(({ type }) => type)).toContain(PRESENTATION_JOB_EVENT_TYPES.progress);
    expect(events.map(({ seq }) => seq)).toEqual(events.map((_, index) => index + 1));
    const finalArtifactEvent = events.find(
      (event) =>
        (event.data as { artifact?: { artifactId?: string } }).artifact?.artifactId ===
        'job-1:artifact:0',
    );
    expect(finalArtifactEvent?.data).toMatchObject({
      artifact: { artifactId: 'job-1:artifact:0', status: 'ready', sizeBytes: 2 },
      job: { state: 'running' },
    });
    expect(JSON.stringify(events)).not.toContain('bytes');
  });

  it('publishes quality failure and cancellation terminal events', async () => {
    const qualityJournal = new PresentationJobEventJournal();
    const qualityPublisher = new PresentationJobEventPublisher(qualityJournal);
    const quality = context({
      eventPublisher: qualityPublisher,
      qualityCheck: vi.fn(async () => ({ passed: false, details: { path: '/private/report' } })),
    });
    await expectCode(
      new InMemoryPresentationPlanWorker().run(plan, quality.context),
      'PRESENTATION_QUALITY_FAILED',
    );
    expect(qualityJournal.replay('job-1').at(-1)).toMatchObject({
      type: PRESENTATION_JOB_EVENT_TYPES.qualityFailed,
      data: { job: { state: 'failed' } },
    });
    expect(JSON.stringify(qualityJournal.replay('job-1'))).not.toContain('/private/report');

    const controller = new AbortController();
    const cancelJournal = new PresentationJobEventJournal();
    const cancelPublisher = new PresentationJobEventPublisher(cancelJournal);
    const cancelled = context({
      abortSignal: controller.signal,
      eventPublisher: cancelPublisher,
      workspace: {
        path: '/workspace',
        write: vi.fn(async () => controller.abort()),
      },
    });
    await expectCode(
      new InMemoryPresentationPlanWorker().run(plan, cancelled.context),
      'PRESENTATION_WORKER_CANCELLED',
    );
    expect(cancelJournal.replay('job-1').at(-1)).toMatchObject({
      type: PRESENTATION_JOB_EVENT_TYPES.cancelled,
      data: { job: { state: 'cancelled' } },
    });
  });

  it('publishes validation exceptions without replacing the original error', async () => {
    const journal = new PresentationJobEventJournal();
    const publisher = new PresentationJobEventPublisher(journal);
    const invalidPlan = { ...plan, slides: [] };

    await expect(
      new InMemoryPresentationPlanWorker().run(
        invalidPlan,
        context({ eventPublisher: publisher }).context,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_INVALID' });
    expect(journal.replay('job-1').at(-1)).toMatchObject({
      type: PRESENTATION_JOB_EVENT_TYPES.failed,
      data: { job: { state: 'failed', error: { code: 'PLAN_INVALID' } } },
    });
  });

  it('keeps the original worker error when terminal event publication fails', async () => {
    const publicationFailure = new Error('journal unavailable');
    let appendCount = 0;
    const journal = {
      append: vi.fn((jobId, value) => {
        appendCount += 1;
        if (appendCount === 2) throw publicationFailure;
        return value;
      }),
      dispose: vi.fn(),
      has: vi.fn(() => false),
      replay: vi.fn(() => []),
      subscribe: vi.fn(),
    };
    const publisher = new PresentationJobEventPublisher(journal);
    const quality = context({
      eventPublisher: publisher,
      qualityCheck: vi.fn(async () => ({ passed: false })),
    });

    await expect(
      new InMemoryPresentationPlanWorker().run(plan, quality.context),
    ).rejects.toMatchObject({
      code: 'PRESENTATION_QUALITY_FAILED',
      message: 'Presentation quality check did not pass',
    });
    expect(publicationFailure).not.toBeInstanceOf(PresentationWorkerError);
  });
});
