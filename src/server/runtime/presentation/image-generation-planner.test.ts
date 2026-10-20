import { describe, expect, it, vi } from 'vitest';

import type {
  ImageGenerationPort,
  ImageGenerationRequest,
  ImageGenerationResult,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import {
  IMAGE_GENERATION_EVENT_TYPES,
  ImageGenerationEventPublisher,
  InMemoryImageGenerationEventJournal,
} from './asset-events';
import { InMemoryPresentationAssetStore } from './asset-store';
import {
  type ImageGenerationPlanInput,
  ImageGenerationPlanner,
  ImageGenerationPlannerError,
} from './image-generation-planner';

const scope: RuntimeScope = { sessionId: 'session-1', userId: 'user-1' };

const slot = (slideId: string, slotId: string, prompt = `${slideId}-${slotId}`) => ({
  prompt,
  slideId,
  slotId,
});

const resultFor = (request: ImageGenerationRequest): ImageGenerationResult[] => [
  {
    asset: { ref: `asset://${request.prompt}` },
    index: 0,
    metadata: {
      assetId: `asset-${request.prompt}`,
      createdAt: '2026-08-31T00:00:00.000Z',
      mimeType: 'image/png',
      sizeBytes: 3,
    },
  },
];

const makeHarness = (
  generate: ImageGenerationPort['generate'] = async (request) => resultFor(request),
  options: Partial<ConstructorParameters<typeof ImageGenerationPlanner>[0]> = {},
) => {
  const journal = new InMemoryImageGenerationEventJournal({ scope });
  const publisher = new ImageGenerationEventPublisher({ journal, scope });
  const assetStore = new InMemoryPresentationAssetStore({
    now: () => '2026-08-31T00:00:00.000Z',
  });
  const imagePort: ImageGenerationPort = {
    generate,
    manifest: {
      displayName: 'Test image provider',
      providerId: 'test.image',
      supportedMimeTypes: ['image/png'],
      supportsIdempotency: true,
    },
    providerId: 'test.image',
    resolveAsset: async () => null,
  };
  const planner = new ImageGenerationPlanner({
    assetStore,
    eventPublisher: publisher,
    imagePort,
    ...options,
  });
  return { imagePort, journal, planner, publisher };
};

const expectPlannerError = async (operation: Promise<unknown>, code: string) => {
  await expect(operation).rejects.toMatchObject({
    code,
    name: 'ImageGenerationPlannerError',
  });
};

const planInput = (slots: ImageGenerationPlanInput['slots']): ImageGenerationPlanInput => ({
  jobId: 'image-job-1',
  scope,
  slots,
});

describe('C-84 image-generation planner', () => {
  it('sorts output by slide/slot and forwards the scoped request', async () => {
    const generate = vi.fn(async (request, context) => {
      expect(context.scope).toEqual(scope);
      return resultFor(request);
    });
    const { journal, planner } = makeHarness(generate);

    const output = await planner.plan(
      planInput([slot('slide-2', 'slot-b'), slot('slide-1', 'slot-a')]),
    );

    expect(output.slots.map(({ slideId, slotId }) => `${slideId}/${slotId}`)).toEqual([
      'slide-1/slot-a',
      'slide-2/slot-b',
    ]);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'slide-1-slot-a' }),
      expect.objectContaining({ scope }),
    );
    expect(generate).toHaveBeenCalledTimes(2);
    const events = journal.replay('image-job-1');
    expect(events).toHaveLength(8);
    for (const slotId of ['slot-a', 'slot-b']) {
      expect(
        events.filter((event) => event.data.slotId === slotId).map((event) => event.type),
      ).toEqual([
        IMAGE_GENERATION_EVENT_TYPES.accepted,
        IMAGE_GENERATION_EVENT_TYPES.started,
        IMAGE_GENERATION_EVENT_TYPES.progress,
        IMAGE_GENERATION_EVENT_TYPES.assetReady,
      ]);
    }
  });

  it('forwards owned style references and background mode to the image port', async () => {
    const generate = vi.fn(async (request) => resultFor(request));
    const { planner } = makeHarness(generate);
    await planner.plan({
      ...planInput([
        {
          background: 'opaque',
          prompt: 'watercolor robot',
          referenceAssetRefs: ['template-page-1'],
          slideId: 'slide-1',
          slotId: 'hero',
        },
      ]),
    });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        background: 'opaque',
        prompt: 'watercolor robot',
        referenceAssetRefs: ['template-page-1'],
      }),
      expect.anything(),
    );
  });

  it('caches successful slots idempotently without repeating provider or events', async () => {
    const generate = vi.fn(async (request) => resultFor(request));
    const { journal, planner } = makeHarness(generate);
    const input = planInput([slot('slide-1', 'slot-a')]);

    const first = await planner.plan(input);
    const eventCount = journal.replay('image-job-1').length;
    const second = await planner.plan(input);

    expect(second).toEqual(first);
    expect(generate).toHaveBeenCalledOnce();
    expect(journal.replay('image-job-1')).toHaveLength(eventCount);
  });

  it('retries only a failed slot and retains the successful slot cache', async () => {
    const attempts = new Map<string, number>();
    const generate = vi.fn(async (request) => {
      const count = (attempts.get(request.prompt) ?? 0) + 1;
      attempts.set(request.prompt, count);
      if (request.prompt === 'slide-2-slot-b' && count === 1) {
        throw Object.assign(new Error('provider rejected'), { code: 'IMAGE_PROVIDER_REJECTED' });
      }
      return resultFor(request);
    });
    const { planner } = makeHarness(generate, { maxRetries: 0, concurrency: 1 });
    const input = planInput([slot('slide-1', 'slot-a'), slot('slide-2', 'slot-b')]);

    const first = await planner.plan(input);
    const second = await planner.retry(input);

    expect(first.slots.map((item) => item.state)).toEqual(['ready', 'failed']);
    expect(second.slots.map((item) => item.state)).toEqual(['ready', 'ready']);
    expect(attempts.get('slide-1-slot-a')).toBe(1);
    expect(attempts.get('slide-2-slot-b')).toBe(2);
  });

  it('publishes failed with a stable provider code and never fabricates an asset', async () => {
    const generate = vi.fn(async () => {
      throw Object.assign(new Error('provider unavailable'), { code: 'IMAGE_UNAVAILABLE' });
    });
    const { journal, planner } = makeHarness(generate, { maxRetries: 0 });

    const output = await planner.plan(planInput([slot('slide-1', 'slot-a')]));

    expect(output.slots[0]).toMatchObject({
      assetRefs: [],
      error: { code: 'IMAGE_UNAVAILABLE' },
      state: 'failed',
    });
    expect(journal.replay('image-job-1').at(-1)).toMatchObject({
      data: { code: 'IMAGE_UNAVAILABLE' },
      type: IMAGE_GENERATION_EVENT_TYPES.failed,
    });
  });

  it('retries a transient slot failure locally when maxRetries permits it', async () => {
    let calls = 0;
    const generate = vi.fn(async (request) => {
      calls += 1;
      if (calls === 1) throw new Error('temporary failure');
      return resultFor(request);
    });
    const { journal, planner } = makeHarness(generate, { maxRetries: 1 });

    const output = await planner.plan(planInput([slot('slide-1', 'slot-a')]));

    expect(output.slots[0].state).toBe('ready');
    expect(calls).toBe(2);
    expect(
      journal
        .replay('image-job-1')
        .filter((event) => event.type === IMAGE_GENERATION_EVENT_TYPES.started),
    ).toHaveLength(2);
  });

  it('enforces the total image-count budget before provider calls', async () => {
    const generate = vi.fn(async (request) => resultFor(request));
    const { planner } = makeHarness(generate, { maxImages: 2 });

    await expectPlannerError(
      planner.plan(planInput([{ ...slot('slide-1', 'slot-a'), count: 3 }])),
      'IMAGE_BUDGET_EXCEEDED',
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it('limits active provider calls to the injected concurrency', async () => {
    let active = 0;
    let highest = 0;
    const releases: Array<() => void> = [];
    const generate = vi.fn(
      (request: ImageGenerationRequest) =>
        new Promise<ImageGenerationResult[]>((resolve) => {
          active += 1;
          highest = Math.max(highest, active);
          releases.push(() => {
            active -= 1;
            resolve(resultFor(request));
          });
        }),
    );
    const { planner } = makeHarness(generate, { concurrency: 2 });
    const pending = planner.plan(
      planInput([slot('slide-1', 'a'), slot('slide-2', 'b'), slot('slide-3', 'c')]),
    );

    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(highest).toBe(2);
    releases.splice(0, 2).forEach((release) => release());
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    const output = await pending;
    expect(output.slots.every((item) => item.state === 'ready')).toBe(true);
    expect(highest).toBe(2);
  });

  it('propagates AbortSignal and marks an interrupted slot cancelled', async () => {
    const generate = vi.fn(
      (_request: ImageGenerationRequest, context: Parameters<ImageGenerationPort['generate']>[1]) =>
        new Promise<ImageGenerationResult[]>((_resolve, reject) => {
          context.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const { journal, planner } = makeHarness(generate);
    const controller = new AbortController();
    const pending = planner.plan({
      ...planInput([slot('slide-1', 'slot-a')]),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    controller.abort();

    const output = await pending;
    expect(output.slots[0]).toMatchObject({
      assetRefs: [],
      error: { code: 'IMAGE_CANCELLED' },
      state: 'cancelled',
    });
    expect(journal.replay('image-job-1').at(-1)?.type).toBe(IMAGE_GENERATION_EVENT_TYPES.cancelled);
  });

  it('enforces a total duration budget and reports a stable budget error', async () => {
    let current = 0;
    const now = vi.fn(() => current);
    const generate = vi.fn(async (request) => {
      current = 10;
      return resultFor(request);
    });
    const { planner } = makeHarness(generate, { maxDurationMs: 5, now });

    const output = await planner.plan(planInput([slot('slide-1', 'slot-a')]));

    expect(output.slots[0]).toMatchObject({
      assetRefs: [],
      error: { code: 'IMAGE_BUDGET_EXCEEDED' },
      state: 'failed',
    });
    expect(generate).toHaveBeenCalledOnce();
  });

  it('rejects invalid slots, duplicate slot identities and scope mismatches safely', async () => {
    const { planner } = makeHarness();

    await expectPlannerError(
      planner.plan(planInput([{ ...slot('slide-1', 'slot-a'), prompt: '' }])),
      'IMAGE_PLAN_INVALID',
    );
    await expectPlannerError(
      planner.plan(planInput([slot('slide-1', 'slot-a'), slot('slide-1', 'slot-a')])),
      'IMAGE_PLAN_INVALID',
    );
    await expect(
      planner.plan({
        ...planInput([slot('slide-1', 'slot-a')]),
        scope: { sessionId: 'other-session', userId: 'other-user' },
      }),
    ).rejects.toMatchObject({ code: 'ASSET_SCOPE_MISMATCH' });
  });

  it('rejects invalid provider payloads with IMAGE_PAYLOAD_INVALID', async () => {
    const generate = vi.fn(async () => [{ index: 0, asset: { ref: '' } }] as never);
    const { planner } = makeHarness(generate, { maxRetries: 0 });

    const output = await planner.plan(planInput([slot('slide-1', 'slot-a')]));

    expect(output.slots[0].error?.code).toBe('IMAGE_PAYLOAD_INVALID');
    expect(ImageGenerationPlannerError).toBeDefined();
  });
});
