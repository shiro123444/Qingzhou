import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  presentationLearningClient,
  presentationTrialClient,
  presentationValidationClient,
  TrialRequestError,
} from './trialClient';

afterEach(() => vi.restoreAllMocks());
describe('owned trial HTTP client', () => {
  it('uses authenticated same-origin validation endpoints with explicit confirmations and cancellation', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{}'));
    const controller = new AbortController();
    await presentationValidationClient.options('episode', controller.signal);
    const input = {
      episodeId: 'episode',
      requestId: crypto.randomUUID(),
      targets: ['a', 'b'].map((jobId) => ({ jobId, slideId: 's1', expectedVersionId: 'v1' })),
      confirmed: true as const,
    };
    await presentationValidationClient.create(input, controller.signal);
    await presentationValidationClient.start('validation', controller.signal);
    await presentationValidationClient.status('validation', controller.signal);
    await presentationValidationClient.cancel('validation', controller.signal);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
      ['options', 'create', 'start', 'status', 'cancel'].map(
        (operation) => `/api/runtime/presentation/tools/presentation.validation.${operation}`,
      ),
    );
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { episodeId: 'episode' },
      input,
      { validationId: 'validation', confirmed: true },
      { validationId: 'validation' },
      { validationId: 'validation' },
    ]);
    expect(
      fetcher.mock.calls.every(
        ([, init]) => init?.credentials === 'same-origin' && init.signal === controller.signal,
      ),
    ).toBe(true);
  });
  it('reads only via same-origin authenticated operations and forwards cancellation', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ trials: [] })));
    const controller = new AbortController();
    expect(await presentationTrialClient.list('source', 's1', controller.signal)).toEqual({
      trials: [],
    });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/runtime/presentation/tools/presentation.trial.list',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ jobId: 'source', slideId: 's1' }),
        signal: controller.signal,
      }),
    );
  });
  it('sends explicit choice and source CAS fields without changing them', async () => {
    const result = { status: 'kept', jobId: 'source', versionId: 'v1' };
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(result)));
    const choice = {
      jobId: 'source',
      runId: 'run',
      evidenceDigest: 'a'.repeat(64),
      expectedVersionId: 'v1',
      variantId: 'baseline',
      requestId: crypto.randomUUID(),
      confirmed: true as const,
    };
    expect(await presentationTrialClient.choose(choice)).toEqual(result);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('.choose'),
      expect.objectContaining({ body: JSON.stringify(choice) }),
    );
  });
  it('preserves the server conflict code for the stale-source UI', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'PRESENTATION_CONFLICT' } }), { status: 409 }),
    );
    await expect(presentationTrialClient.read('run')).rejects.toMatchObject(
      new TrialRequestError('PRESENTATION_CONFLICT', 409),
    );
  });
  it('routes explicit start, status and cancellation through owned operation endpoints', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ budget: {} })));
    const controller = new AbortController();
    const input = {
      jobId: 'source',
      expectedVersionId: 'v1',
      slideId: 's1',
      requestId: crypto.randomUUID(),
      confirmed: true as const,
    };
    await presentationTrialClient.start(input, controller.signal);
    await presentationTrialClient.status('source', 's1', controller.signal);
    await presentationTrialClient.cancel('execution', controller.signal);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
      ['start', 'status', 'cancel'].map(
        (operation) => `/api/runtime/presentation/tools/presentation.trial.${operation}`,
      ),
    );
    for (const [, init] of fetcher.mock.calls)
      expect(init).toMatchObject({
        credentials: 'same-origin',
        method: 'POST',
        signal: controller.signal,
      });
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      input,
      { jobId: 'source', slideId: 's1' },
      { executionId: 'execution' },
    ]);
  });
  it('reads learning projections through the same authenticated path without publishing capabilities', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ episodes: [] })));
    const controller = new AbortController();
    await presentationLearningClient.list('source', 's1', controller.signal);
    await presentationLearningClient.read('episode', controller.signal);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/runtime/presentation/tools/presentation.learning.list',
      '/api/runtime/presentation/tools/presentation.learning.read',
    ]);
    for (const [, init] of fetcher.mock.calls)
      expect(init).toMatchObject({ credentials: 'same-origin', signal: controller.signal });
  });
});
