// @vitest-environment node
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { users } from '@/database/schemas';
import { DatabaseLearningBudget } from '../improvement/budget-store';
import type { LearningBudgetPort } from '../improvement/budget';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import realPage from './__fixtures__/trial-text-overflow.json';
import { FileCapabilityCapsuleStore } from './capability-memory';
import { FilePresentationStorage } from './file-storage';
import { FileTrialLearningStore } from './trial-learning';
import { FileTrialEvidenceStore, PresentationTrialReview } from './trial-review';
import { createProductionTrialWorkspace } from './trial-workspace-production';
import type { UserChatConnection } from './user-chat-provider';

const db = await getTestDB();
const scope = { userId: 'alice', sessionId: 'account' };
const sourceSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="white"/><text x="40" y="80" font-size="28">Source content</text></svg>';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  vi.restoreAllMocks();
});
async function harness(
  supportsVision = true,
  visionModel?: string,
  pages?: { source: string; candidate: string; preferCandidate: boolean },
  serial?: { refinementScore?: number; patch?: Record<string, string | undefined>; fail?: boolean },
  budgets?: LearningBudgetPort,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'trial-production-'));
  const storage = new FilePresentationStorage(root);
  await storage.saveJob(scope, {
    input: { notebookId: 'studio', title: 'Source', sourceVersionIds: [] },
    job: {
      jobId: 'source',
      versionId: 'v1',
      state: 'completed',
      createdAt: '2026-10-21',
      updatedAt: '2026-10-21',
    },
    plan: {
      planId: 'plan',
      title: 'Source',
      sourceVersionIds: [],
      aspectRatio: '16:9',
      slides: [{ slideId: 's1', order: 1, svg: pages?.source ?? sourceSvg }],
    },
  });
  let connection: UserChatConnection = {
    apiKey: 'private-key',
    baseURL: 'https://models.example.test/v1',
    provider: 'selected-provider',
    model: 'selected-model',
    supportsVision,
  };
  const resolve = vi.fn(async () => connection);
  const originalPng = pages
    ? (
        await sharp(Buffer.from(pages.source))
          .resize({ width: 1400 })
          .flatten({ background: '#ffffff' })
          .png()
          .toBuffer()
      ).toString('base64')
    : undefined;
  let proposals = 0;
  let probes = 0;
  let evaluations = 0;
  let incumbentImage: string | undefined;
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    const evaluating = payload.messages[0].content.includes('匿名PPT');
    const proposing = payload.messages[0].content.includes('受限配置提案器');
    const images = evaluating
      ? payload.messages[1].content.filter((item: { type: string }) => item.type === 'image_url')
      : [];
    connection = { ...connection, model: 'changed-model', apiKey: 'changed-key' };
    if (proposing) {
      proposals++;
      if (serial?.fail && proposals === 2) throw new Error('Refinement disconnected');
    }
    if (!proposing && !evaluating) probes++;
    if (evaluating) {
      evaluations++;
      if (evaluations === 1 && serial)
        incumbentImage = images.find(
          (item: { image_url: { url: string } }) => !item.image_url.url.endsWith(originalPng ?? ''),
        )?.image_url.url;
    }
    const reply = evaluating
      ? {
          cases: images.map((image: { image_url: { url: string } }, index: number) => ({
            label: String.fromCharCode(65 + index),
            visual: { status: 'passed', evidence: 'Test pixels' },
            quality: Object.fromEntries(
              ['readability', 'hierarchy', 'composition', 'styleConsistency'].map((key) => [
                key,
                {
                  score:
                    pages?.preferCandidate && images[index].image_url.url.endsWith(originalPng)
                      ? 2
                      : serial && evaluations === 2 && image.image_url.url !== incumbentImage
                        ? (serial.refinementScore ?? 4)
                        : 3,
                  evidence: 'Test pixels',
                },
              ]),
            ),
          })),
        }
      : proposing
        ? {
            patch:
              serial && proposals === 2
                ? (serial.patch ?? { textSpacing: 'compact' })
                : { textSpacing: 'comfortable' },
            rationale: 'proposal-only rationale',
            experienceIds: [],
          }
        : {
            svg:
              serial && probes === 2
                ? (pages?.candidate ?? sourceSvg).replace('#A8C93A', '#77AA33')
                : (pages?.candidate ?? sourceSvg),
          };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: payload.model,
        choices: [{ message: { role: 'assistant', content: JSON.stringify(reply) } }],
        usage: { total_tokens: 10 },
      }),
    };
  });
  const memory = new FileCapabilityCapsuleStore(path.join(root, 'memory'));
  const workspace = createProductionTrialWorkspace({
    dataRoot: root,
    ...(budgets ? { budgets: async () => budgets } : {}),
    storage,
    memory,
    fetcher,
    resolve,
    visionModel,
  });
  cleanup.push(async () => {
    await workspace.drain();
    await rm(root, { recursive: true, force: true });
  });
  const start = () =>
    workspace.start(scope, {
      jobId: 'source',
      expectedVersionId: 'v1',
      slideId: 's1',
      confirmed: true,
      requestId: randomUUID(),
      ...(serial ? { mode: 'serial' as const } : {}),
    });
  return { root, workspace, resolve, fetcher, storage, memory, start };
}
describe('production workspace trial assembly', () => {
  it('keeps both serial rounds under one durable parent while preserving the domain usage report', async () => {
    await db.insert(users).values({ id: scope.userId });
    try {
      const budgets = new DatabaseLearningBudget(db);
      const h = await harness(true, undefined, undefined, { refinementScore: 4 }, budgets);
      await h.start();
      await h.workspace.drain();
      const view = await h.workspace.status(scope, 'source', 's1');
      expect(view.execution?.state, JSON.stringify(view)).toBe('completed');
      const parent = await budgets.read(
        {
          userId: scope.userId,
          subject: { kind: 'presentation', sessionId: scope.sessionId, jobId: 'source' },
        },
        `presentation:${view.execution!.executionId}`,
      );
      expect(Object.keys(parent.children)).toHaveLength(2);
      expect(Object.keys(parent.attempts)).toHaveLength(6);
      expect(Object.values(parent.attempts).every((a) => a.state === 'completed')).toBe(true);
      expect(h.fetcher).toHaveBeenCalledTimes(6);
      expect(parent.limit.costMicros).toBe(4000000);
      expect(JSON.stringify(parent)).not.toContain('private-key');
      expect((await h.storage.getJob(scope, 'source'))?.job.versionId).toBe('v1');
    } finally {
      await db.delete(users).where(eq(users.id, scope.userId));
    }
  });

  it('pins the authenticated model and credentials once and uses actual probe/render/evaluate adapters', async () => {
    const h = await harness();
    await h.start();
    await h.workspace.drain();
    const state = await h.workspace.status(scope, 'source', 's1');
    expect(state.execution, JSON.stringify(state)).toMatchObject({ state: 'completed' });
    expect(h.resolve).toHaveBeenCalledExactlyOnceWith(scope);
    expect(h.fetcher).toHaveBeenCalledTimes(3);
    for (const [, init] of h.fetcher.mock.calls) {
      expect(JSON.parse(String(init.body)).model).toBe('selected-model');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer private-key' });
    }
    const view = await new PresentationTrialReview(
      new FileTrialEvidenceStore(path.join(h.root, 'trial-evidence')),
      h.storage,
    ).read(scope, state.execution!.runId!);
    expect(view.recommendedId).toBe('baseline');
    expect(view.proposal).toMatchObject({
      dimension: 'textSpacing',
      value: 'comfortable',
      rationale: 'proposal-only rationale',
    });
    expect(state.execution?.charged).toEqual({ tokens: 30, costMicros: 2_000_000 });
    const evaluator = JSON.parse(String(h.fetcher.mock.calls[2][1].body));
    expect(JSON.stringify(evaluator)).not.toContain('proposal-only rationale');
    expect(JSON.stringify(evaluator)).not.toContain('pendingExperiences');
    expect(JSON.stringify(view)).not.toContain('private-key');
    const folders = await readdir(path.join(h.root, 'trial-runs', 'runs'));
    const runs = await readdir(path.join(h.root, 'trial-runs', 'runs', folders[0]));
    const config = await readFile(
      path.join(h.root, 'trial-runs', 'runs', folders[0], runs[0], 'configuration-0.json'),
      'utf8',
    );
    expect(config).not.toContain('private-key');
    expect(config).not.toContain('changed-key');
  });
  it('does not hide transport retries outside the trial ledger', async () => {
    const h = await harness();
    h.fetcher.mockRejectedValue(new TypeError('Network disconnected'));
    await h.start();
    await h.workspace.drain();
    expect((await h.workspace.status(scope, 'source', 's1')).execution?.state).toBe('failed');
    expect(h.fetcher).toHaveBeenCalledOnce();
  });
  it('requires a visual observer before paid work', async () => {
    const h = await harness(false);
    await h.start();
    await h.workspace.drain();
    expect((await h.workspace.status(scope, 'source', 's1')).execution?.state).toBe('failed');
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it('supports a separately pinned visual observer with a text-only planner', async () => {
    const h = await harness(false, 'vision-observer');
    await h.start();
    await h.workspace.drain();
    expect((await h.workspace.status(scope, 'source', 's1')).execution?.state).toBe('completed');
    expect(h.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init.body)).model)).toEqual([
      'selected-model',
      'selected-model',
      'vision-observer',
    ]);
  });
});

describe('proposal-to-review regression on the real overflow page', () => {
  it.each([true, false])(
    'validates candidate improvement=%s with actual PNGs and retains the immutable source',
    async (preferCandidate) => {
      const h = await harness(true, undefined, {
        source: realPage.source.svg,
        candidate: realPage.overflowSvg,
        preferCandidate,
      });
      const before = await h.storage.getJob(scope, 'source');
      await h.start();
      await h.workspace.drain();
      const execution = (await h.workspace.status(scope, 'source', 's1')).execution!;
      expect(execution.state).toBe('completed');
      const evidence = new FileTrialEvidenceStore(path.join(h.root, 'trial-evidence'));
      const review = new PresentationTrialReview(evidence, h.storage);
      const view = await review.read(scope, execution.runId!);
      expect(view.recommendedId).toBe(preferCandidate ? 'candidate' : 'baseline');
      expect(
        view.variants.every((variant) =>
          Object.values(variant.gates!).every((gate) => gate.status === 'passed'),
        ),
      ).toBe(true);
      const { body } = await evidence.read(scope, view.runId);
      expect(body.configurations[1].policy).toEqual({ textSpacing: 'comfortable' });
      expect(
        body.report.calls
          .filter((call) => call.operation.startsWith('trials.'))
          .map((call) => call.operation),
      ).toEqual([
        'trials.propose',
        'trials.render',
        'trials.probe',
        'trials.render',
        'trials.evaluate',
      ]);
      expect(body.report.proposal?.result?.rationale).toBe('proposal-only rationale');
      const choice = await review.choose(scope, {
        confirmed: true,
        evidenceDigest: view.evidenceDigest,
        expectedVersionId: 'v1',
        jobId: 'source',
        requestId: randomUUID(),
        runId: view.runId,
        variantId: view.recommendedId,
      });
      expect(choice.status).toBe(preferCandidate ? 'created' : 'kept');
      expect(await h.storage.getJob(scope, 'source')).toEqual(before);
      expect(h.fetcher).toHaveBeenCalledTimes(3);
    },
  );
  it('reads same-page pending user observations on the next explicit run, without sharing them with the observer', async () => {
    const h = await harness();
    await h.start();
    await h.workspace.drain();
    const execution = (await h.workspace.status(scope, 'source', 's1')).execution!;
    const evidence = new FileTrialEvidenceStore(path.join(h.root, 'trial-evidence'));
    const { FileTrialLearningStore } = await import('./trial-learning');
    const learning = new FileTrialLearningStore({
      root: path.join(h.root, 'trial-learning'),
      evidence,
      storage: h.storage,
    });
    const review = new PresentationTrialReview(evidence, h.storage, h.storage, learning);
    const view = await review.read(scope, execution.runId!);
    await review.choose(scope, {
      confirmed: true,
      evidenceDigest: view.evidenceDigest,
      expectedVersionId: 'v1',
      jobId: 'source',
      requestId: randomUUID(),
      runId: view.runId,
      variantId: 'baseline',
      reason: 'pending-user-reason-marker',
    });
    await h.start();
    await h.workspace.drain();
    expect(h.fetcher).toHaveBeenCalledTimes(6);
    const proposalPayload = JSON.parse(String(h.fetcher.mock.calls[3][1].body));
    const input = JSON.parse(proposalPayload.messages[1].content);
    expect(input.pendingExperiences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'pending-user-reason-marker',
          attemptedPolicy: { textSpacing: 'comfortable' },
          status: 'pending-validation',
          outcome: 'baseline-kept',
        }),
      ]),
    );
    expect(JSON.stringify(input)).not.toContain('quality');
    expect(JSON.stringify(input)).not.toContain('private-key');
    expect(String(h.fetcher.mock.calls[5][1].body)).not.toContain('pending-user-reason-marker');
  });
});

describe('bounded serial production improvement', () => {
  it.each([4, 3, 2])(
    'recommends refinement or retains the incumbent with refinement score %s',
    async (refinementScore) => {
      const h = await harness(
        true,
        undefined,
        { source: realPage.source.svg, candidate: realPage.overflowSvg, preferCandidate: true },
        { refinementScore },
      );
      const before = await h.storage.getJob(scope, 'source');
      await h.start();
      await h.workspace.drain();
      const state = await h.workspace.status(scope, 'source', 's1');
      expect(state.execution, JSON.stringify(state)).toMatchObject({
        state: 'completed',
        mode: 'serial',
        round: 2,
        charged: { tokens: 60, costMicros: 4_000_000 },
      });
      expect(h.resolve).toHaveBeenCalledOnce();
      expect(h.fetcher).toHaveBeenCalledTimes(6);
      for (const [, init] of h.fetcher.mock.calls) {
        expect(JSON.parse(String(init.body)).model).toBe('selected-model');
        expect(init.headers).toMatchObject({ Authorization: 'Bearer private-key' });
      }
      const evidence = new FileTrialEvidenceStore(path.join(h.root, 'trial-evidence'));
      const learning = new FileTrialLearningStore({
        root: path.join(h.root, 'trial-learning'),
        evidence,
        storage: h.storage,
      });
      const review = new PresentationTrialReview(evidence, h.storage, h.storage, learning);
      const view = await review.read(scope, state.execution!.runId!);
      expect(view.recommendedId).toBe(refinementScore === 4 ? 'candidate' : 'incumbent');
      expect(view.improvement).toMatchObject({
        rounds: 2,
        selectedRound: 2,
        refinementFailed: false,
      });
      const { body } = await evidence.read(scope, view.runId);
      expect(body.report.selection?.policyVersion).toBe(2);
      expect(body.improvementRounds).toHaveLength(2);
      expect(body.improvementRounds!.map((round) => round.variants.length)).toEqual([2, 3]);
      expect(
        body.improvementRounds!.every((round) =>
          round.variants.every(
            (variant) => variant.configuration && variant.plan && variant.preview,
          ),
        ),
      ).toBe(true);
      expect(
        body
          .improvementRounds!.flatMap((round) => round.report.calls)
          .filter((call) => call.operation === 'trials.render'),
      ).toHaveLength(5);
      expect(body.configurations.slice(1).map((configuration) => configuration.policy)).toEqual([
        { textSpacing: 'comfortable' },
        { textSpacing: 'compact' },
      ]);
      const refinementInput = JSON.parse(
        JSON.parse(String(h.fetcher.mock.calls[3][1].body)).messages[1].content,
      );
      expect(refinementInput.refinement.incumbentPolicy).toEqual({ textSpacing: 'comfortable' });
      expect(refinementInput.priorAttempt.svg).toContain('<svg');
      expect(JSON.stringify(refinementInput)).not.toMatch(
        /"quality"|"score"|"selectedId"|private-key/,
      );
      const observerInput = String(h.fetcher.mock.calls[5][1].body);
      expect(observerInput).not.toMatch(/incumbentPolicy|priorAttempt|proposal-only rationale/);
      // Archive survives removal of the private execution workspaces.
      await rm(path.join(h.root, 'trial-serial'), { recursive: true, force: true });
      await rm(path.join(h.root, 'trial-runs'), { recursive: true, force: true });
      expect((await evidence.read(scope, view.runId)).body.improvementRounds).toEqual(
        body.improvementRounds,
      );
      const choice = await review.choose(scope, {
        confirmed: true,
        evidenceDigest: view.evidenceDigest,
        expectedVersionId: 'v1',
        jobId: 'source',
        requestId: randomUUID(),
        runId: view.runId,
        variantId: view.recommendedId,
      });
      expect(choice.status).toBe('created');
      expect(choice.learningStatus).toBe('recorded');
      expect(await h.storage.getJob(scope, 'source')).toEqual(before);
      const stored = await learning.readStored(scope, choice.learningEpisodeId!);
      expect(stored!.evidence.improvementRounds).toHaveLength(2);
      expect(stored!.status).toBe('pending-validation');
    },
  );
  it.each([{ textSpacing: 'comfortable' }, { layoutStrategy: 'columns' }])(
    'falls back without probing a rejected refinement %j',
    async (patch) => {
      const h = await harness(
        true,
        undefined,
        { source: realPage.source.svg, candidate: realPage.overflowSvg, preferCandidate: true },
        { patch },
      );
      await h.start();
      await h.workspace.drain();
      const state = await h.workspace.status(scope, 'source', 's1');
      expect(state.execution?.state).toBe('completed');
      expect(h.fetcher).toHaveBeenCalledTimes(4);
      const evidence = new FileTrialEvidenceStore(path.join(h.root, 'trial-evidence'));
      const view = await new PresentationTrialReview(evidence, h.storage).read(
        scope,
        state.execution!.runId!,
      );
      expect(view.recommendedId).toBe('candidate');
      expect(view.improvement).toMatchObject({ selectedRound: 1, refinementFailed: true });
      const { body } = await evidence.read(scope, view.runId);
      expect(body.improvementRounds![1].report.errorCode).toBe(
        patch.textSpacing ? 'TRIAL_PROPOSAL_NO_CHANGE' : 'TRIAL_PROPOSAL_DIMENSION',
      );
    },
  );
  it('keeps the first verified result when the second proposal transport fails', async () => {
    const h = await harness(
      true,
      undefined,
      { source: realPage.source.svg, candidate: realPage.overflowSvg, preferCandidate: true },
      { fail: true },
    );
    await h.start();
    await h.workspace.drain();
    const state = await h.workspace.status(scope, 'source', 's1');
    expect(state.execution?.state).toBe('completed');
    expect(h.fetcher).toHaveBeenCalledTimes(4);
    expect(state.execution?.charged?.tokens).toBe(8030);
    const evidence = new FileTrialEvidenceStore(path.join(h.root, 'trial-evidence'));
    expect(
      (await new PresentationTrialReview(evidence, h.storage).read(scope, state.execution!.runId!))
        .improvement?.refinementFailed,
    ).toBe(true);
  });
});

describe('serial boundary regressions', () => {
  it('can retain the original through both rounds without creating a replacement', async () => {
    const h = await harness(
      true,
      undefined,
      { source: realPage.source.svg, candidate: realPage.overflowSvg, preferCandidate: false },
      { refinementScore: 3 },
    );
    const before = await h.storage.getJob(scope, 'source');
    await h.start();
    await h.workspace.drain();
    const state = await h.workspace.status(scope, 'source', 's1');
    expect(state.execution?.state).toBe('completed');
    const evidence = new FileTrialEvidenceStore(path.join(h.root, 'trial-evidence'));
    const review = new PresentationTrialReview(evidence, h.storage);
    const view = await review.read(scope, state.execution!.runId!);
    expect(view.recommendedId).toBe('baseline');
    const { body } = await evidence.read(scope, view.runId);
    expect(body.improvementRounds!.map((round) => round.variants.length)).toEqual([2, 2]);
    expect(body.report.selection?.policyVersion).toBe(1);
    expect(
      await review.choose(scope, {
        confirmed: true,
        evidenceDigest: view.evidenceDigest,
        expectedVersionId: 'v1',
        jobId: 'source',
        requestId: randomUUID(),
        runId: view.runId,
        variantId: 'baseline',
      }),
    ).toMatchObject({ status: 'kept' });
    expect(await h.storage.getJob(scope, 'source')).toEqual(before);
  });
  it('rejects a concurrent source edit before publishing either serial result', async () => {
    const h = await harness(
      true,
      undefined,
      { source: realPage.source.svg, candidate: realPage.overflowSvg, preferCandidate: true },
      {},
    );
    const original = h.fetcher.getMockImplementation()!;
    let count = 0;
    h.fetcher.mockImplementation(async (...args) => {
      if (++count === 6) {
        const current = (await h.storage.getJob(scope, 'source'))!;
        current.plan!.slides[0].notes = 'Concurrent user edit';
        await h.storage.saveJob(scope, current);
      }
      return original(...args);
    });
    await h.start();
    await h.workspace.drain();
    const state = await h.workspace.status(scope, 'source', 's1');
    expect(state.execution).toMatchObject({
      state: 'failed',
      errorCode: 'TRIAL_SOURCE_CHANGED',
      charged: { tokens: 60 },
    });
    expect((await h.storage.getJob(scope, 'source'))?.plan?.slides[0].notes).toBe(
      'Concurrent user edit',
    );
    expect(
      await new FileTrialEvidenceStore(path.join(h.root, 'trial-evidence')).list(
        scope,
        'source',
        's1',
      ),
    ).toEqual([]);
  });
  it('cancels during round two, retains unknown reservations and holds the worker until transport drains', async () => {
    const h = await harness(
      true,
      undefined,
      { source: realPage.source.svg, candidate: realPage.overflowSvg, preferCandidate: true },
      {},
    );
    const original = h.fetcher.getMockImplementation()!;
    let count = 0;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.fetcher.mockImplementation(async (...args) => {
      if (++count === 5) {
        entered();
        await blocked;
      }
      return original(...args);
    });
    const started = await h.start();
    await ready;
    try {
      expect(
        (await h.workspace.cancel(scope, started.execution!.executionId)).execution?.state,
      ).toBe('cancelling');
      await vi.waitFor(async () =>
        expect((await h.workspace.status(scope, 'source', 's1')).execution?.state).toBe(
          'cancelled',
        ),
      );
      await expect(h.start()).rejects.toMatchObject({ code: 'PRESENTATION_CONFLICT' });
      expect(h.fetcher).toHaveBeenCalledTimes(5);
    } finally {
      release();
    }
    await h.workspace.drain();
    const state = await h.workspace.status(scope, 'source', 's1');
    expect(state.execution).toMatchObject({
      state: 'cancelled',
      charged: { tokens: 48030, costMicros: 4_000_000 },
    });
    expect(h.fetcher).toHaveBeenCalledTimes(5);
    const evidence = new FileTrialEvidenceStore(path.join(h.root, 'trial-evidence'));
    expect(await evidence.list(scope, 'source', 's1')).toEqual([]);
    const learning = new FileTrialLearningStore({
      root: path.join(h.root, 'trial-learning'),
      evidence,
      storage: h.storage,
    });
    const episode = await learning.readStored(scope, state.execution!.learningEpisodeId!);
    expect(episode?.evidence.improvementRounds).toHaveLength(2);
    expect(episode?.evidence.improvementRounds?.[1].report.status).toBe('cancelled');
    expect(episode?.status).toBe('pending-validation');
  });
  it('rejects browser overrides of serial budgets and recursion depth', async () => {
    const h = await harness();
    for (const override of [
      { maxRounds: 3 },
      { budget: { maxTokens: 999999 } },
      { domain: 'sites' },
    ]) {
      await expect(
        h.workspace.start(scope, {
          jobId: 'source',
          expectedVersionId: 'v1',
          slideId: 's1',
          confirmed: true,
          requestId: randomUUID(),
          mode: 'serial',
          ...override,
        }),
      ).rejects.toBeDefined();
    }
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});

describe('serial frozen configuration', () => {
  it('reuses the first capability composition rather than rereading mutable memory in round two', async () => {
    const h = await harness(
      true,
      undefined,
      { source: realPage.source.svg, candidate: realPage.overflowSvg, preferCandidate: true },
      {},
    );
    const compose = vi.spyOn(h.memory, 'compose');
    const original = h.fetcher.getMockImplementation()!;
    let count = 0;
    h.fetcher.mockImplementation(async (...args) => {
      const reply = await original(...args);
      if (++count === 3) compose.mockRejectedValue(new Error('Memory changed after round one'));
      return reply;
    });
    await h.start();
    await h.workspace.drain();
    const state = await h.workspace.status(scope, 'source', 's1');
    expect(state.execution?.state).toBe('completed');
    expect(h.fetcher).toHaveBeenCalledTimes(6);
    expect(compose).toHaveBeenCalledOnce();
    const { body } = await new FileTrialEvidenceStore(path.join(h.root, 'trial-evidence')).read(
      scope,
      state.execution!.runId!,
    );
    const configurations = body.improvementRounds!.map((round) => round.variants[0].configuration!);
    expect(configurations[1].capsules).toEqual(configurations[0].capsules);
    expect(configurations[1].sourceAssets).toEqual(configurations[0].sourceAssets);
    expect(configurations[1].sourcePlan).toEqual(configurations[0].sourcePlan);
  });
});

describe('serial frozen asset bytes', () => {
  it('uses the first asset snapshot when the backing store becomes unavailable between rounds', async () => {
    const h = await harness(true, undefined, undefined, {});
    const bytes = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#A8C93A' },
    })
      .png()
      .toBuffer();
    await h.storage.put(scope, {
      artifactId: 'frozen-image',
      type: 'image',
      name: 'frozen.png',
      mimeType: 'image/png',
      bytes,
    });
    const source = (await h.storage.getJob(scope, 'source'))!;
    source.plan!.slides[0].svg = sourceSvg.replace(
      '</svg>',
      '<image href="/api/runtime/presentation/artifacts/frozen-image" x="700" y="100" width="100" height="100"/></svg>',
    );
    await h.storage.saveJob(scope, source);
    const get = vi.spyOn(h.storage, 'get');
    const original = h.fetcher.getMockImplementation()!;
    let count = 0;
    h.fetcher.mockImplementation(async (...args) => {
      const reply = await original(...args);
      if (++count === 3) get.mockRejectedValue(new Error('Backing store unavailable'));
      return reply;
    });
    await h.start();
    await h.workspace.drain();
    const state = await h.workspace.status(scope, 'source', 's1');
    expect(state.execution?.state).toBe('completed');
    expect(h.fetcher).toHaveBeenCalledTimes(6);
    expect(get).toHaveBeenCalledOnce();
    const { body } = await new FileTrialEvidenceStore(path.join(h.root, 'trial-evidence')).read(
      scope,
      state.execution!.runId!,
    );
    const configurations = body.improvementRounds!.map((round) => round.variants[0].configuration!);
    expect(configurations[0].sourceAssets[0].base64).toBe(bytes.toString('base64'));
    expect(configurations[1].sourceAssets).toEqual(configurations[0].sourceAssets);
  });
});
