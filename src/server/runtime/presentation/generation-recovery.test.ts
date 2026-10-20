import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { FilePresentationStorage } from './file-storage';
import { PresentationGenerationPort } from './generation-port';

const scope = { userId: 'owner', sessionId: 'session', request: new Request('http://localhost') };
const input = {
  title: 'Long report',
  notebookId: 'n1',
  sourceVersionIds: ['source-1'],
  slideCount: 2,
};
const slides = [1, 2].map((order) => ({
  slideId: `slide-${order}`,
  order,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="48" y="100" font-size="30">Source page ${order}</text></svg>`,
}));

describe('durable generation takeover', () => {
  it('does not replay an edit saved before an interrupted export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qingzhou-export-resume-'));
    const repository = new FilePresentationStorage(root);
    const plan = {
      planId: 'saved-edit',
      title: input.title,
      aspectRatio: '16:9' as const,
      sourceVersionIds: input.sourceVersionIds,
      slides,
    };
    await repository.saveJob(scope, {
      input,
      plan,
      initialAssetsComplete: true,
      job: {
        jobId: 'composed-job',
        state: 'running',
        title: input.title,
        slideCount: 2,
        artifactIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            requestId: 'saved-edit',
            content: 'Improve page one',
            target: { type: 'slide', slideNumber: 1 },
            status: 'applying',
            versionId: 'saved-edit',
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    const planner = vi.fn();
    const execute = vi.fn(async (_scope, _input, context) => ({
      artifacts: [],
      plan: await context.preparePlan(context.initialPlan),
    }));
    const port = new PresentationGenerationPort(
      {
        artifactStore: repository,
        repository,
        capability: { execute, plan: planner } as never,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            jobId: 'unused',
            workspace: { path: '/tmp', write: vi.fn() },
            convert: vi.fn(),
            qualityCheck: vi.fn(),
          },
        }),
      },
      scope,
    );
    try {
      await port.getJob('composed-job');
      await vi.waitFor(
        async () => expect((await port.getJob('composed-job'))?.state).toBe('completed'),
        { timeout: 10_000 },
      );
      expect(planner).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
      expect((await port.readPlan('composed-job')).plan.slides).toEqual(slides);
      expect((await port.getJob('composed-job'))?.messages?.[0].status).toBe('applied');
    } finally {
      await port.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('reads a living worker without taking over and resumes saved pages after shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qingzhou-resume-'));
    const repository = new FilePresentationStorage(root);
    let checkpointed = false;
    const firstExecute = vi.fn(async (_scope, _input, context) => {
      await context.plannerContext.onSlideDraft(slides[0]);
      checkpointed = true;
      return new Promise((_resolve, reject) =>
        context.plannerContext.abortSignal.addEventListener(
          'abort',
          () => reject(context.plannerContext.abortSignal.reason),
          { once: true },
        ),
      );
    });
    const resumeExecute = vi.fn(async (_scope, _input, context) => {
      expect(context.plannerContext.resumeSlides).toEqual([slides[0]]);
      return {
        artifacts: [],
        plan: {
          planId: 'p',
          title: input.title,
          aspectRatio: '16:9',
          sourceVersionIds: input.sourceVersionIds,
          slides,
        },
      };
    });
    const options = {
      artifactStore: repository,
      repository,
      idFactory: () => 'long-job',
      contextFactory: () => ({
        plannerContext: {},
        workerContext: {
          jobId: 'unused',
          workspace: { path: '/tmp', write: vi.fn() },
          convert: vi.fn(),
          qualityCheck: vi.fn(),
        },
      }),
    };
    const first = new PresentationGenerationPort(
      { ...options, capability: { execute: firstExecute, plan: vi.fn() } as never },
      scope,
    );
    const next = new PresentationGenerationPort(
      { ...options, capability: { execute: resumeExecute, plan: vi.fn() } as never },
      scope,
    );
    try {
      await first.createJob(input);
      await vi.waitFor(() => expect(checkpointed).toBe(true), { timeout: 10_000 });
      expect((await next.getJob('long-job'))?.state).toBe('running');
      expect(resumeExecute).not.toHaveBeenCalled();
      await expect(next.cancelJob('long-job')).rejects.toMatchObject({
        code: 'PRESENTATION_CONFLICT',
      });
      expect((await repository.getJob(scope, 'long-job'))?.job.state).toBe('running');
      await first.dispose();
      expect((await repository.getJob(scope, 'long-job'))?.job.state).toBe('queued');
      const candidates = await repository.listRecoveryCandidates();
      expect(candidates).toEqual([
        { scope: { userId: scope.userId, sessionId: scope.sessionId }, jobId: 'long-job' },
      ]);
      await next.getJob('long-job');
      await vi.waitFor(
        async () => expect((await next.getJob('long-job'))?.state).toBe('completed'),
        { timeout: 10_000 },
      );
      expect(resumeExecute).toHaveBeenCalledOnce();
      expect((await next.getJob('long-job'))?.recovery?.completedSlides).toBe(1);
    } finally {
      await first.dispose();
      await next.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);
});
