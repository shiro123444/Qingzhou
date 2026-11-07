import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { TrialExecution, TrialStartInput } from '@/types/presentationTrial';

import { AtomicRuntime } from '../atomic-runtime';
import page from './__fixtures__/trial-text-overflow.json';
import { FilePresentationStorage, type StoredPresentationJob } from './file-storage';
import { trialDigest } from './trial-configuration';
import type { AnonymousTrialScores } from './trial-evaluation';
import { FileTrialLearningStore } from './trial-learning';
import { FileTrialEvidenceStore, PresentationTrialReview } from './trial-review';
import {
  createTrialExecutionPlugin,
  RepresentativeTrialRunner,
  type TrialStageContext,
} from './trial-runner';
import { fitTrialPageText } from './trial-text-layout';
import { PresentationTrialWorkspace, WORKSPACE_TRIAL_BUDGET } from './trial-workspace';

const scope = { userId: 'alice', sessionId: 'account' };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  vi.restoreAllMocks();
});
const request = (): TrialStartInput => ({
  jobId: 'source',
  expectedVersionId: 'v1',
  slideId: 's1',
  requestId: randomUUID(),
  confirmed: true,
});
async function setup(
  options: {
    tie?: boolean;
    tokens?: number;
    probe?: (ctx: TrialStageContext) => Promise<void>;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'trial-workspace-'));
  const storage = new FilePresentationStorage(path.join(root, 'data'));
  const evidence = new FileTrialEvidenceStore(path.join(root, 'evidence'));
  const source: StoredPresentationJob = {
    input: { title: page.source.title, notebookId: 'studio', sourceVersionIds: [] },
    job: {
      jobId: 'source',
      versionId: 'v1',
      state: 'completed',
      createdAt: '2026-10-21',
      updatedAt: '2026-10-21',
    },
    plan: {
      planId: 'original',
      title: page.source.title,
      aspectRatio: '16:9',
      sourceVersionIds: [],
      slides: [{ slideId: 's1', order: 1, svg: page.source.svg, notes: page.source.notes }],
    },
  };
  await storage.saveJob(scope, source);
  const probe = vi.fn(async (ctx: TrialStageContext) => {
    await options.probe?.(ctx);
    return {
      page: { svg: fitTrialPageText(page.overflowSvg, ctx.signal), notes: page.source.notes },
      usage: { tokens: options.tokens ?? 10, costMicros: 0 },
    };
  });
  const createRunner = vi.fn(async (_scope, frozenSource) => {
    const runtime = new AtomicRuntime([
      {
        id: 'presentation',
        version: 'test',
        operations: [
          {
            name: 'presentation.memory.compose',
            description: 'Owned fixture composition',
            input: z.any(),
            execute: () => ({ capsules: [] }),
          },
        ],
      },
      createTrialExecutionPlugin({
        version: 'test-v1',
        probe,
        render: async ({ plan }) => ({
          bytes: new Uint8Array(await sharp(Buffer.from(plan.slides[0].svg)).png().toBuffer()),
          usage: { tokens: 0, costMicros: 0 },
        }),
        evaluate: async (ctx) => ({
          usage: { tokens: 10, costMicros: 0 },
          cases: ctx.cases.map(({ label, svg }) => ({
            label,
            gates: Object.fromEntries(
              ['facts', 'editability', 'assets', 'render', 'visual'].map((key) => [
                key,
                { status: 'passed', evidence: 'Fixture evidence' },
              ]),
            ) as AnonymousTrialScores['cases'][number]['gates'],
            quality: Object.fromEntries(
              ['readability', 'hierarchy', 'composition', 'styleConsistency'].map((key) => [
                key,
                {
                  score: options.tie || svg === page.source.svg ? 2 : 3,
                  evidence: 'Fixture quality',
                },
              ]),
            ) as AnonymousTrialScores['cases'][number]['quality'],
          })),
        }),
      }),
    ]);
    const model = {
      providerId: 'test',
      model: 'test',
      configurationDigest: 'a'.repeat(64),
      maxOutputTokens: 100,
      temperature: 0,
    };
    const runner = new RepresentativeTrialRunner({
      runtime,
      repository: { getJob: async () => structuredClone(frozenSource) },
      artifacts: storage,
      root: path.join(root, 'runs'),
      budget: WORKSPACE_TRIAL_BUDGET,
      settings: () => ({
        schemaVersion: 1,
        imageGeneration: false,
        executorVersion: 'test-v1',
        rendererVersion: 'sharp-test',
        recipe: { id: 'test', instructions: 'Preserve content' },
        models: { planner: model, observer: model },
        frozenInputs: {},
        baselineCapsuleIds: [],
        probeAllowance: { tokens: 24000, costMicros: 1000000 },
        evaluation: { version: 'test', allowance: { tokens: 24000, costMicros: 1000000 } },
      }),
    });
    return { runner, dispose: () => runtime.dispose() };
  });
  const learning = new FileTrialLearningStore({
    root: path.join(root, 'learning'),
    evidence,
    storage,
  });
  const config = { root: path.join(root, 'tasks'), storage, evidence, createRunner, learning };
  const workspace = new PresentationTrialWorkspace(config);
  cleanup.push(async () => {
    await workspace.drain();
    await rm(root, { recursive: true, force: true });
  });
  const terminal = async () => {
    let result: TrialExecution | undefined;
    await vi.waitFor(
      async () => {
        result = (await workspace.status(scope, 'source', 's1')).execution;
        expect(result && !['running', 'cancelling'].includes(result.state)).toBe(true);
      },
      { timeout: 10000, interval: 80 },
    );
    return result!;
  };
  return {
    root,
    storage,
    evidence,
    learning,
    source,
    workspace,
    createRunner,
    probe,
    terminal,
    other: () => new PresentationTrialWorkspace(config),
    review: new PresentationTrialReview(evidence, storage),
  };
}

describe('owned bounded workspace trial jobs', () => {
  it.each([false, true])(
    'runs a real representative-page render through review and explicit choice (keep=%s)',
    async (tie) => {
      const h = await setup({ tie });
      const input = request();
      const started = await h.workspace.start(scope, input);
      expect(started).toMatchObject({
        budget: WORKSPACE_TRIAL_BUDGET,
        execution: { state: 'running' },
      });
      const done = await h.terminal();
      expect(done, JSON.stringify(done)).toMatchObject({ state: 'completed' });
      expect(done.charged).toMatchObject({ tokens: 20 });
      const view = await h.review.read(scope, done.runId!);
      expect(view.recommendedId).toBe(tie ? 'baseline' : 'candidate');
      const result = await h.review.choose(scope, {
        jobId: input.jobId,
        expectedVersionId: input.expectedVersionId,
        requestId: input.requestId,
        confirmed: true,
        runId: done.runId,
        evidenceDigest: view.evidenceDigest,
        variantId: tie ? 'baseline' : 'candidate',
      });
      expect(result.status).toBe(tie ? 'kept' : 'created');
      expect(await h.storage.getJob(scope, 'source')).toEqual(h.source);
      expect(JSON.stringify(started)).not.toContain(h.root);
      expect(h.probe).toHaveBeenCalledOnce();
    },
  );
  it('replays the same start identity without another inference, including from a second instance', async () => {
    const h = await setup();
    const input = request();
    const first = await h.workspace.start(scope, input);
    await h.terminal();
    await h.workspace.drain();
    const replay = await h.other().start(scope, input);
    expect(replay.execution?.executionId).toBe(first.execution?.executionId);
    expect(h.createRunner).toHaveBeenCalledOnce();
    expect(h.probe).toHaveBeenCalledOnce();
    await expect(h.workspace.start(scope, { ...input, slideId: 'another' })).rejects.toMatchObject({
      code: 'PRESENTATION_CONFLICT',
    });
  });
  it('rejects caller budgets, multiple candidates and missing confirmation without paid work', async () => {
    const h = await setup();
    for (const extra of [
      { budget: { maxTokens: 999999 } },
      { candidates: [] },
      { confirmed: false },
    ])
      await expect(h.workspace.start(scope, { ...request(), ...extra })).rejects.toMatchObject({
        code: 'PRESENTATION_INVALID',
      });
    await expect(
      h.workspace.start(scope, { ...request(), expectedVersionId: 'old' }),
    ).rejects.toMatchObject({ code: 'PRESENTATION_CONFLICT' });
    await expect(
      h.workspace.start({ userId: 'bob', sessionId: 'account' }, request()),
    ).rejects.toMatchObject({ code: 'PRESENTATION_CONFLICT' });
    expect(h.createRunner).not.toHaveBeenCalled();
  });
  it('persists cross-instance cancellation and excludes another live start', async () => {
    const h = await setup({
      probe: async (ctx) =>
        new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    const started = await h.workspace.start(scope, request());
    await vi.waitFor(() => expect(h.probe).toHaveBeenCalledOnce());
    const other = h.other();
    await expect(other.start(scope, request())).rejects.toMatchObject({
      code: 'PRESENTATION_CONFLICT',
    });
    expect((await other.cancel(scope, started.execution!.executionId)).execution?.state).toBe(
      'cancelling',
    );
    expect((await h.terminal()).state).toBe('cancelled');
    expect(await h.review.list(scope, 'source', 's1')).toEqual({ trials: [] });
    expect(await h.storage.getJob(scope, 'source')).toEqual(h.source);
    await expect(
      other.cancel({ userId: 'bob', sessionId: 'account' }, started.execution!.executionId),
    ).rejects.toMatchObject({ code: 'PRESENTATION_NOT_FOUND' });
  });
  it('stops excessive reported usage without evaluation or publication', async () => {
    const h = await setup({ tokens: 24001 });
    await h.workspace.start(scope, request());
    expect((await h.terminal()).state).toBe('budget-exceeded');
    expect(h.probe).toHaveBeenCalledOnce();
    expect(await h.review.list(scope, 'source', 's1')).toEqual({ trials: [] });
  });
  it.each(['version', 'content'])(
    'refuses to publish if the source %s changes during the trial',
    async (kind) => {
      const h: Awaited<ReturnType<typeof setup>> = await setup({
        probe: async () => {
          const modified = structuredClone(h.source);
          if (kind === 'version') modified.job.versionId = 'v2';
          else modified.plan!.slides[0].notes = 'Concurrent edit';
          const lease = await h.storage.acquireLease(scope, 'source');
          await h.storage.saveJob(scope, modified);
          await lease!.release();
        },
      });
      await h.workspace.start(scope, request());
      expect(await h.terminal()).toMatchObject({
        state: 'failed',
        errorCode: 'TRIAL_SOURCE_CHANGED',
      });
      expect(await h.review.list(scope, 'source', 's1')).toEqual({ trials: [] });
      expect(await h.storage.listJobs(scope)).toHaveLength(1);
    },
  );
  it('marks a lost worker interrupted and never automatically reruns it', async () => {
    const h = await setup();
    const input = request();
    const initial = await h.workspace.start(scope, input);
    await h.terminal();
    await h.workspace.drain();
    const file = path.join(
      h.root,
      'tasks',
      trialDigest([scope.userId, scope.sessionId]),
      `${initial.execution!.executionId}.json`,
    );
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.execution.state = 'running';
    delete record.execution.runId;
    await writeFile(file, JSON.stringify(record));
    const recovered = await h.other().start(scope, input);
    expect(recovered.execution?.state).toBe('interrupted');
    expect(h.createRunner).toHaveBeenCalledOnce();
  });
  it('sanitizes provider failures instead of leaking credentials into public status', async () => {
    const h = await setup();
    h.createRunner.mockRejectedValueOnce(new Error('secret-api-key endpoint detail'));
    await h.workspace.start(scope, request());
    const done = await h.terminal();
    expect(done).toMatchObject({ state: 'failed', errorCode: 'TRIAL_EXECUTION_FAILED' });
    expect(JSON.stringify(done)).not.toContain('secret');
  });
  it('enforces the workspace deadline while a probe is pending', async () => {
    const originalTimeout = globalThis.setTimeout;
    const deadlines: (() => void)[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms === WORKSPACE_TRIAL_BUDGET.maxDurationMs) deadlines.push(callback);
      return originalTimeout(callback, ms, ...args);
    }) as typeof setTimeout);
    const h = await setup({
      probe: (ctx) =>
        new Promise<void>((resolve) =>
          ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
    });
    await h.workspace.start(scope, request());
    await vi.waitFor(() => expect(h.probe).toHaveBeenCalledOnce());
    deadlines[0]();
    expect(await h.terminal()).toMatchObject({ state: 'deadline-exceeded' });
    expect(await h.review.list(scope, 'source', 's1')).toEqual({ trials: [] });
  });
  it('keeps the worker slot while an uncooperative cancelled call drains', async () => {
    let unblock!: () => void;
    const h = await setup({
      probe: () =>
        new Promise<void>((resolve) => {
          unblock = resolve;
        }),
    });
    const started = await h.workspace.start(scope, request());
    await vi.waitFor(() => expect(h.probe).toHaveBeenCalledOnce());
    await h.workspace.cancel(scope, started.execution!.executionId);
    expect((await h.terminal()).state).toBe('cancelled');
    await expect(h.other().start(scope, request())).rejects.toMatchObject({
      code: 'PRESENTATION_CONFLICT',
    });
    unblock();
    await h.workspace.drain();
    expect(h.createRunner).toHaveBeenCalledOnce();
  });
  it('archives completed observations as pending before any user adoption', async () => {
    const h = await setup();
    await h.workspace.start(scope, request());
    const terminal = await h.terminal();
    await h.workspace.drain();
    const list = await h.learning.list(scope, 'source', 's1');
    expect(list.episodes).toHaveLength(1);
    const episode = await h.learning.read(scope, list.episodes[0].episodeId);
    expect(episode).toMatchObject({
      kind: 'attempt',
      status: 'pending-validation',
      outcome: 'comparison-ready',
      runId: terminal.runId,
      reasonProvided: false,
    });
    expect(episode.selectedVariantId).toBeUndefined();
    expect(episode.result).toBeUndefined();
    expect(episode.variants[1].available).toEqual({
      configuration: true,
      plan: true,
      preview: true,
      evaluation: true,
    });
  });
  it('archives failed usage with available snapshots, no candidate preview and no invented evaluation', async () => {
    const h = await setup({ tokens: 24001 });
    await h.workspace.start(scope, request());
    await h.terminal();
    await h.workspace.drain();
    const list = await h.learning.list(scope, 'source', 's1');
    const episode = await h.learning.read(scope, list.episodes[0].episodeId);
    expect(episode).toMatchObject({
      kind: 'attempt',
      outcome: 'budget-exceeded',
      failureCode: 'TRIAL_USAGE_EXCEEDED',
    });
    expect(episode.variants[1].available).toEqual({
      configuration: true,
      plan: false,
      preview: false,
      evaluation: false,
    });
    expect(episode.variants[1].quality).toBeUndefined();
  });
  it('retains preparation failures with their source context and explicit missing stage evidence', async () => {
    const h = await setup();
    h.createRunner.mockRejectedValueOnce(new Error('private-provider-error'));
    await h.workspace.start(scope, request());
    const terminal = await h.terminal();
    await h.workspace.drain();
    const episode = await h.learning.read(scope, terminal.learningEpisodeId!);
    expect(episode).toMatchObject({
      outcome: 'failed',
      status: 'pending-validation',
      failureCode: 'TRIAL_EXECUTION_FAILED',
      variants: [],
    });
    expect(episode.cue.title).toBe(h.source.plan!.title);
    expect(JSON.stringify(episode)).not.toContain('private-provider-error');
    expect((await h.learning.readStored(scope, episode.episodeId))?.evidence.source?.plan).toEqual(
      h.source.plan,
    );
  });
  it('retries a pending attempt archive through status without another model invocation', async () => {
    const h = await setup();
    const archive = vi
      .spyOn(h.learning, 'recordAttempt')
      .mockRejectedValue(new Error('Disk unavailable'));
    await h.workspace.start(scope, request());
    await h.terminal();
    await h.workspace.drain();
    expect((await h.workspace.status(scope, 'source', 's1')).execution).toMatchObject({
      state: 'completed',
      learningStatus: 'pending',
    });
    archive.mockRestore();
    const recovered = await h.workspace.status(scope, 'source', 's1');
    expect(recovered.execution).toMatchObject({
      state: 'completed',
      learningStatus: 'recorded',
      learningEpisodeId: expect.any(String),
    });
    expect(h.probe).toHaveBeenCalledOnce();
    expect(h.createRunner).toHaveBeenCalledOnce();
    expect((await h.learning.list(scope, 'source', 's1')).episodes).toHaveLength(1);
  });
  it('retains interrupted attempts with explicit missing configurations and their frozen source', async () => {
    const h = await setup();
    const execution: TrialExecution = {
      executionId: 'interrupted-worker',
      requestId: randomUUID(),
      source: { jobId: 'source', versionId: 'v1', slideId: 's1' },
      state: 'interrupted',
      phase: 'preparing',
      startedAt: '2026-10-21',
      updatedAt: '2026-10-21',
      errorCode: 'TRIAL_WORKER_INTERRUPTED',
    };
    await h.learning.prepareAttempt(scope, execution, h.source);
    const episodeId = await h.learning.recordAttempt(scope, execution);
    expect(await h.learning.read(scope, episodeId)).toMatchObject({
      kind: 'attempt',
      outcome: 'interrupted',
      failureCode: 'TRIAL_WORKER_INTERRUPTED',
      variants: [],
      lesson: { transfer: 'unverified' },
    });
    expect((await h.learning.readStored(scope, episodeId))?.evidence.source?.plan).toEqual(
      h.source.plan,
    );
    expect(h.createRunner).not.toHaveBeenCalled();
  });
});
