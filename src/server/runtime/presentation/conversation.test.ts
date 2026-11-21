import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PresentationMessageInput,
  PresentationPlan,
} from '../../../../packages/runtime-contracts/src';
import { FilePresentationStorage } from './file-storage';
import { PresentationGenerationCapability } from './generation-capability';
import { PresentationGenerationPort } from './generation-port';
import { PresentationGenerationPipelineImpl } from './pipeline';
import { PresentationJobEventPublisher } from './publisher';
import { InMemoryPresentationPlanWorker } from './worker';

const scope = { userId: 'owner', sessionId: 'session', request: new Request('http://localhost') };
const plan: PresentationPlan = {
  planId: 'plan',
  title: 'Deck',
  aspectRatio: '4:3',
  sourceVersionIds: [],
  slides: [
    { slideId: 'first', order: 1, svg: '<svg><text>Keep this exactly</text></svg>' },
    { slideId: 'second', order: 2, svg: '<svg><text>Original</text></svg>' },
  ],
};
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('Durable presentation conversations', () => {
  it('queues during planning and conversion, preserves untouched pages, exports real matching bytes and restores history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'presentation-chat-'));
    directories.push(root);
    const storage = new FilePresentationStorage(root);
    const planning = deferred();
    const converting = deferred();
    const received: PresentationPlan[] = [];
    const planner = {
      plan: vi.fn(async (_input, context) => {
        if (!context.basePlan) {
          await planning.promise;
          return structuredClone(plan);
        }
        const base = context.basePlan as PresentationPlan;
        const message = context.revision as PresentationMessageInput;
        return {
          ...base,
          slides: base.slides.map((slide, index) =>
            message.target.type === 'deck' || index + 1 === message.target.slideNumber
              ? { ...slide, svg: `<svg><text>${message.content}</text></svg>` }
              : {
                  ...slide,
                  notes: 'off-target notes',
                  svg: '<svg><text>off-target change</text></svg>',
                },
          ),
        };
      }),
    };
    const worker = new InMemoryPresentationPlanWorker();
    const pipeline = new PresentationGenerationPipelineImpl(planner, {
      run: async (current, context) => {
        received.push(structuredClone(current));
        return worker.run(current, context);
      },
    });
    const capability = new PresentationGenerationCapability(pipeline, storage);
    let converts = 0;
    const options = {
      artifactStore: storage,
      repository: storage,
      capability,
      idFactory: () => 'job',
      contextFactory: () => ({
        plannerContext: {},
        workerContext: {
          jobId: 'unused',
          workspace: { path: '/tmp', write: async () => {} },
          qualityCheck: async () => ({ passed: true }),
          convert: async (_path, signal) => {
            expect(signal).toBeInstanceOf(AbortSignal);
            if (++converts === 1) await converting.promise;
            return [
              {
                type: 'pptx',
                mimeType:
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                name: 'deck.pptx',
                bytes: new Uint8Array([80, 75, converts]),
              },
              {
                type: 'svg',
                mimeType: 'image/svg+xml',
                name: 'backup.svg',
                bytes: new TextEncoder().encode('<svg/>'),
              },
            ];
          },
        },
      }),
    } satisfies ConstructorParameters<typeof PresentationGenerationPort>[0];
    const port = new PresentationGenerationPort(options, scope);
    await port.createJob({
      title: 'Deck',
      sourceVersionIds: [],
      notebookId: 'studio',
      slideCount: 2,
    });
    await vi.waitFor(() => expect(planner.plan).toHaveBeenCalledTimes(1));
    const first: PresentationMessageInput = {
      requestId: 'one',
      content: 'First revision',
      target: { type: 'slide', slideNumber: 2 },
    };
    await port.sendMessage('job', first);
    await port.sendMessage('job', first);
    planning.resolve();
    await vi.waitFor(() => expect(converts).toBe(1));
    await port.sendMessage('job', { ...first, requestId: 'two', content: 'Second revision' });
    converting.resolve();
    await vi.waitFor(async () => expect((await port.getJob('job'))?.state).toBe('completed'));
    const job = (await port.getJob('job'))!;
    expect(job.messages?.map((message) => message.status)).toEqual(['applied', 'applied']);
    expect(job.revisions).toHaveLength(2);
    expect(job.artifactIds).toHaveLength(3);
    expect(received.map((p) => p.slides[0])).toEqual([plan.slides[0], plan.slides[0]]);
    expect(received[1].slides[1].svg).toContain('Second revision');
    const slideId = job.artifactIds!.find((id) => id.endsWith(':slide:second'))!;
    const exported = await port.exportArtifact(slideId, 'pptx');
    expect(exported.artifactId).not.toBe(slideId);
    expect(exported.uri).toContain('raw=true');
    expect((await storage.get(scope, exported.artifactId))?.bytes).toEqual(
      new Uint8Array([80, 75, 2]),
    );
    await expect(port.exportArtifact(slideId, 'pdf')).rejects.toMatchObject({
      code: 'PRESENTATION_INVALID',
    });
    const reopened = new PresentationGenerationPort(
      {
        ...options,
        artifactStore: new FilePresentationStorage(root),
        repository: new FilePresentationStorage(root),
      },
      scope,
    );
    expect(await reopened.getJob('job')).toEqual(job);
    expect(
      await new FilePresentationStorage(root).get(
        { ...scope, userId: 'someone-else' },
        exported.artifactId,
      ),
    ).toBeNull();
    await Promise.all([
      reopened.sendMessage('job', { ...first, requestId: 'three', content: 'Third' }),
      reopened.sendMessage('job', { ...first, requestId: 'four', content: 'Fourth' }),
    ]);
    await vi.waitFor(async () => expect((await reopened.getJob('job'))?.state).toBe('completed'));
    expect(
      (await reopened.getJob('job'))?.messages?.every((message) => message.status === 'applied'),
    ).toBe(true);
  });

  it('replays durable events with continuing sequence and marks interrupted work recoverable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'presentation-recovery-'));
    directories.push(root);
    const storage = new FilePresentationStorage(root);
    const journal = storage.createJournal(scope);
    new PresentationJobEventPublisher({ journal, scope }).publish({
      jobId: 'job',
      type: 'progress',
      data: { phase: 'planning' },
    });
    const restored = new FilePresentationStorage(root).createJournal(scope);
    expect(restored.replay('job')).toHaveLength(1);
    const next = new PresentationJobEventPublisher({ journal: restored, scope }).publish({
      jobId: 'job',
      type: 'progress',
      data: { phase: 'rendering' },
    });
    expect(next.seq).toBe(2);
    expect(new FilePresentationStorage(root).createJournal(scope).replay('job', 1)).toEqual([next]);
  });
});
