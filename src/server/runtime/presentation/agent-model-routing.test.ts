import { describe, expect, it, vi } from 'vitest';

import { currentPresentationAgentJob, withPresentationAgentJob } from './agent-execution-context';
import {
  createPresentationAgentRouter,
  type PresentationAgentExecution,
  type PresentationAgentRole,
} from './agent-model-routing';
import {
  type MultimodalChatContext,
  type MultimodalChatPort,
  MultimodalChatProviderError,
  type MultimodalChatResult,
} from './multimodal-chat-provider';
import { createTrustedChatImages } from './multimodal-chat-provider-glm';

const scope = { sessionId: 'session-a', userId: 'user-a' };
const request = { messages: [{ content: 'private source facts', role: 'user' as const }] };
const response = (model: string): MultimodalChatResult => ({
  choices: [{ index: 0, message: { content: 'result', role: 'assistant' } }],
  created: 1,
  id: 'response',
  model,
});
const provider = (model: string, supportsVision = true) => {
  const chat = vi.fn<MultimodalChatPort['chat']>(async () => response(`${model}-snapshot`));
  return {
    chat,
    manifest: {
      displayName: model,
      model,
      providerId: `provider-${model}`,
      supportsIdempotency: false,
      supportsVision,
    },
    providerId: `provider-${model}`,
  };
};

describe('presentation agent model routing', () => {
  it('keeps interleaved job audit correlation isolated through real async-local contexts', async () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const designEntered = deferred();
    const reviewEntered = deferred();
    const finishDesign = deferred();
    const finishReview = deferred();
    const design = provider('design');
    const review = provider('review');
    const fallback = provider('inbox');
    const inside: { jobId: string | undefined; role: PresentationAgentRole }[] = [];
    design.chat.mockImplementationOnce(async () => {
      designEntered.resolve();
      await finishDesign.promise;
      inside.push({ jobId: currentPresentationAgentJob(), role: 'design' });
      return response('design');
    });
    review.chat.mockImplementationOnce(async () => {
      reviewEntered.resolve();
      await finishReview.promise;
      inside.push({ jobId: currentPresentationAgentJob(), role: 'review' });
      return response('review');
    });
    const audited: typeof inside = [];
    const router = createPresentationAgentRouter({
      defaultPort: fallback,
      onExecution: async ({ role }) => {
        await Promise.resolve();
        audited.push({ jobId: currentPresentationAgentJob(), role });
      },
      ports: { design, review },
    });
    const first = withPresentationAgentJob('job-a', () =>
      router.port('design').chat(request, { scope }),
    );
    const second = withPresentationAgentJob('job-b', () =>
      router.port('review').chat(request, { scope }),
    );
    await Promise.all([designEntered.promise, reviewEntered.promise]);
    expect(currentPresentationAgentJob()).toBeUndefined();
    finishReview.resolve();
    await second;
    expect(audited).toEqual([{ jobId: 'job-b', role: 'review' }]);
    expect(currentPresentationAgentJob()).toBeUndefined();
    finishDesign.resolve();
    await first;
    const expected = [
      { jobId: 'job-b', role: 'review' },
      { jobId: 'job-a', role: 'design' },
    ];
    expect(inside).toEqual(expected);
    expect(audited).toEqual(expected);
    await router.port('content').chat(request, { scope });
    expect(audited.at(-1)).toEqual({ jobId: undefined, role: 'content' });
    expect(currentPresentationAgentJob()).toBeUndefined();
  });

  it('audits input fingerprints and bounded response usage without retaining source text', async () => {
    const port = provider('content-model');
    const usage = {
      completion_tokens: 15,
      prompt_tokens: 25,
      total_tokens: 40,
      upstreamDebug: 'private source facts',
    };
    port.chat.mockResolvedValue({ ...response('content-model-snapshot'), usage });
    const receipts: PresentationAgentExecution[] = [];
    const router = createPresentationAgentRouter({
      defaultPort: port,
      onExecution: (receipt) => {
        receipts.push(receipt);
      },
    });
    await router.port('content').chat(request, { scope });
    await router.port('content').chat({ ...request, model: 'ignored-model' }, { scope });
    await router
      .port('content')
      .chat({ messages: [{ content: 'another private source', role: 'user' }] }, { scope });
    expect(receipts[0].inputFingerprint).toMatch(/^[a-f\d]{64}$/u);
    expect(receipts[0].inputFingerprint).toBe(receipts[1].inputFingerprint);
    expect(receipts[2].inputFingerprint).not.toBe(receipts[0].inputFingerprint);
    expect(receipts[0]).toMatchObject({
      resultId: 'response',
      usage: { completion_tokens: 15, prompt_tokens: 25, total_tokens: 40 },
    });
    expect(Object.keys(receipts[0].usage!)).toHaveLength(3);
    expect(Object.isFrozen(receipts[0].usage)).toBe(true);
    expect(JSON.stringify(receipts)).not.toContain('private source');
    expect(receipts[0].usage).not.toBe(usage);
  });

  it('uses distinct role ports, keeps the explicit default, and audits the actual response model', async () => {
    const fallback = provider('inbox');
    const design = provider('design-model');
    const review = provider('review-model');
    const receipts: PresentationAgentExecution[] = [];
    const router = createPresentationAgentRouter({
      defaultPort: fallback,
      onExecution: (receipt) => {
        receipts.push(receipt);
      },
      ports: { design, review },
    });
    await router.port('design').chat({ ...request, model: 'legacy-override' }, { scope });
    await router.port('review').chat(request, { scope });
    await router.port('content').chat(request, { scope });
    expect(design.chat.mock.calls[0][0]).toEqual(request);
    expect(review.chat).toHaveBeenCalledOnce();
    expect(fallback.chat).toHaveBeenCalledOnce();
    expect(router.port('design')).toBe(router.port('design'));
    expect(router.routes.assets).toEqual({
      model: 'inbox',
      providerId: 'provider-inbox',
      route: 'default',
    });
    expect(
      receipts.map(({ role, route, configuredModel, model, status }) => ({
        role,
        route,
        configuredModel,
        model,
        status,
      })),
    ).toEqual([
      {
        role: 'design',
        route: 'explicit',
        configuredModel: 'design-model',
        model: 'design-model-snapshot',
        status: 'completed',
      },
      {
        role: 'review',
        route: 'explicit',
        configuredModel: 'review-model',
        model: 'review-model-snapshot',
        status: 'completed',
      },
      {
        role: 'content',
        route: 'default',
        configuredModel: 'inbox',
        model: 'inbox-snapshot',
        status: 'completed',
      },
    ]);
    expect(JSON.stringify(receipts)).not.toContain('private source facts');
  });

  it('freezes selected roles instead of accepting mutable routing changes during a job', async () => {
    const design = provider('first');
    const replacement = provider('replacement');
    const ports: Partial<Record<PresentationAgentRole, MultimodalChatPort>> = { design };
    const router = createPresentationAgentRouter({ defaultPort: replacement, ports });
    ports.design = replacement;
    await router.port('design').chat(request, { scope });
    expect(design.chat).toHaveBeenCalledOnce();
    expect(replacement.chat).not.toHaveBeenCalled();
    expect(Object.isFrozen(router.routes)).toBe(true);
    expect(Object.isFrozen(router.routes.design)).toBe(true);
    expect(router.port('design').manifest).toBe(design.manifest);
  });

  it('does not replace a failed specialist with another provider and never audits raw errors', async () => {
    const fallback = provider('fallback');
    const review = provider('review');
    const error = new MultimodalChatProviderError('CHAT_UNAVAILABLE', 'private upstream payload');
    review.chat.mockRejectedValueOnce(error);
    const onExecution = vi.fn();
    const router = createPresentationAgentRouter({
      defaultPort: fallback,
      onExecution,
      ports: { review },
    });
    await expect(router.port('review').chat(request, { scope })).rejects.toBe(error);
    expect(fallback.chat).not.toHaveBeenCalled();
    expect(onExecution).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'review', status: 'failed', errorCode: 'CHAT_UNAVAILABLE' }),
      { scope },
    );
    expect(JSON.stringify(onExecution.mock.calls)).not.toContain('private upstream payload');
  });

  it('passes cancellation and authenticated image permissions unchanged across concurrent roles', async () => {
    const design = provider('design');
    const review = provider('review');
    const controller = new AbortController();
    const context: MultimodalChatContext = {
      scope,
      signal: controller.signal,
      idempotencyKey: 'job:page',
      traceId: 'job',
      trustedImages: createTrustedChatImages(
        [
          {
            base64:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dCEAAAAASUVORK5CYII=',
            mimeType: 'image/png',
          },
        ],
        scope,
      ),
    };
    const other = { scope: { sessionId: 'session-b', userId: 'user-b' } };
    const onExecution = vi.fn();
    const router = createPresentationAgentRouter({
      defaultPort: design,
      onExecution,
      ports: { review },
    });
    await Promise.all([
      router.port('design').chat(request, context),
      router.port('review').chat(request, other),
    ]);
    expect(design.chat.mock.calls[0][1]).toBe(context);
    expect(review.chat.mock.calls[0][1]).toBe(other);
    expect(onExecution.mock.calls.find(([r]) => r.role === 'design')![0]).toMatchObject({
      idempotencyKey: 'job:page',
      traceId: 'job',
    });
    controller.abort();
    await expect(router.port('design').chat(request, context)).rejects.toMatchObject({
      code: 'CHAT_CANCELLED',
    });
    expect(design.chat).toHaveBeenCalledOnce();
    expect(onExecution.mock.calls.at(-1)![0]).toMatchObject({
      status: 'cancelled',
      errorCode: 'CHAT_CANCELLED',
    });
  });

  it('preserves abort failures during inference without invoking another role', async () => {
    const fallback = provider('fallback');
    const review = provider('review');
    const controller = new AbortController();
    const cancelled = new DOMException('Cancelled', 'AbortError');
    review.chat.mockImplementationOnce(async () => {
      controller.abort();
      throw cancelled;
    });
    const onExecution = vi.fn();
    const router = createPresentationAgentRouter({
      defaultPort: fallback,
      onExecution,
      ports: { review },
    });
    await expect(
      router.port('review').chat(request, { scope, signal: controller.signal }),
    ).rejects.toBe(cancelled);
    expect(onExecution.mock.calls[0][0]).toMatchObject({
      status: 'cancelled',
      errorCode: 'UNKNOWN',
    });
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it('does not discard a successful inference when its audit observer is unavailable', async () => {
    const port = provider('model', false);
    const observer = vi.fn(async () => {
      throw new Error('journal offline');
    });
    const router = createPresentationAgentRouter({ defaultPort: port, onExecution: observer });
    await expect(router.port('planning').chat(request, { scope })).resolves.toMatchObject({
      model: 'model-snapshot',
    });
    expect(port.chat).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledOnce();
    expect(router.port('planning').manifest.supportsVision).toBe(false);
  });
});
