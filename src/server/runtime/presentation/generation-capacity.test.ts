import { describe, expect, it, vi } from 'vitest';

import { ExecutionLimiter } from '../execution-limiter';
import { InMemoryPresentationArtifactStore } from './artifact-store';
import { createPresentationRuntimeComposition } from './composition';
import type { PresentationGenerationCapability } from './generation-capability';
import { PresentationGenerationPort } from './generation-port';
import { PresentationJobEventJournal } from './job-event-journal';

const input = { notebookId: 'studio', sourceVersionIds: [], title: 'Capacity test' };

function makePort(
  userId: string,
  capability: PresentationGenerationCapability,
  gate: ExecutionLimiter,
) {
  return new PresentationGenerationPort(
    {
      artifactStore: new InMemoryPresentationArtifactStore(),
      capability,
      executionLimiter: gate,
      contextFactory: (jobId) => ({
        plannerContext: {},
        workerContext: {
          jobId,
          convert: vi.fn(),
          qualityCheck: vi.fn(),
          workspace: { path: '/tmp', write: vi.fn() },
        },
      }),
    },
    { userId, sessionId: `account:${userId}`, request: new Request('https://example.test') },
  );
}

describe('shared presentation admission', () => {
  it('shares production capacity with the direct generation route and cancels queued HTTP work', async () => {
    let finish!: () => void;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const execute = vi.fn(async () => {
      await hold;
      return { artifacts: [] };
    });
    const composition = createPresentationRuntimeComposition({
      journalLoader: (scope) => new PresentationJobEventJournal({ scope }),
      generationArtifactStore: new InMemoryPresentationArtifactStore(),
      capability: { execute } as unknown as PresentationGenerationCapability,
      contextFactory: (jobId) => ({
        plannerContext: {},
        workerContext: {
          jobId,
          convert: vi.fn(),
          qualityCheck: vi.fn(),
          workspace: { path: '/tmp', write: vi.fn() },
        },
      }),
    });
    const scope = {
      userId: 'alice',
      sessionId: 'account:alice',
      request: new Request('https://example.test'),
    };
    const port = composition.generationPortFactory!(scope);
    const cancellation = new AbortController();
    try {
      const job = await port.createJob(input);
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      const response = composition.generationHandler(
        new Request('https://example.test/generation', {
          method: 'POST',
          body: JSON.stringify(input),
          signal: cancellation.signal,
        }),
        scope,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(execute).toHaveBeenCalledTimes(1);
      cancellation.abort();
      await expect(response).resolves.toMatchObject({ status: 499 });
      finish();
      await vi.waitFor(async () =>
        expect(await port.getJob(job.jobId)).toMatchObject({ state: 'completed' }),
      );
    } finally {
      cancellation.abort();
      finish();
      await composition.dispose();
    }
  });

  it('keeps another account queued and cancels it without starting its worker', async () => {
    const gate = new ExecutionLimiter(1, 1);
    let finish!: () => void;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const execute = vi.fn(async () => {
      await hold;
      return { artifacts: [] };
    });
    const first = makePort(
      'alice',
      { execute } as unknown as PresentationGenerationCapability,
      gate,
    );
    const secondExecute = vi.fn(async () => ({ artifacts: [] }));
    const second = makePort(
      'bob',
      { execute: secondExecute } as unknown as PresentationGenerationCapability,
      gate,
    );
    try {
      const running = await first.createJob(input);
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      const waiting = await second.createJob(input);
      await vi.waitFor(() => expect(gate.snapshot()).toEqual({ active: 1, queued: 1 }));
      await expect(second.getJob(waiting.jobId)).resolves.toMatchObject({ state: 'queued' });
      await expect(second.cancelJob(waiting.jobId)).resolves.toMatchObject({ state: 'cancelled' });
      expect(secondExecute).not.toHaveBeenCalled();
      expect(gate.snapshot()).toEqual({ active: 1, queued: 0 });
      finish();
      await vi.waitFor(async () =>
        expect(await first.getJob(running.jobId)).toMatchObject({ state: 'completed' }),
      );
      expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
    } finally {
      finish();
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });

  it('records queue exhaustion as a recoverable job failure and releases capacity', async () => {
    const gate = new ExecutionLimiter(1, 0);
    const release = await gate.acquire();
    const execute = vi.fn(async () => ({ artifacts: [] }));
    const port = makePort(
      'alice',
      { execute } as unknown as PresentationGenerationCapability,
      gate,
    );
    try {
      const job = await port.createJob(input);
      await vi.waitFor(async () =>
        expect(await port.getJob(job.jobId)).toMatchObject({
          state: 'failed',
          error: { code: 'CAPACITY_BUSY' },
        }),
      );
      expect(execute).not.toHaveBeenCalled();
      release();
      await port.retryJob(job.jobId);
      await vi.waitFor(async () =>
        expect(await port.getJob(job.jobId)).toMatchObject({ state: 'completed' }),
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
    } finally {
      release();
      await port.dispose();
    }
  });
});
