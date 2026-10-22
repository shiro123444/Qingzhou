// @vitest-environment node
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { users } from '@/database/schemas';
import { DatabaseLearningBudget } from '../improvement/budget-store';
import type { LearningBudgetPort } from '../improvement/budget';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TrialValidationView, ValidationTarget } from '@/types/presentationValidation';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import { AtomicRuntime } from '../atomic-runtime';
import { FileCapabilityCapsuleStore } from './capability-memory';
import { acquirePresentationExecutionLease } from './execution-lease';
import { FilePresentationStorage, type StoredPresentationJob } from './file-storage';
import { trialDigest } from './trial-configuration';
import { FileTrialLearningStore } from './trial-learning';
import { FileTrialEvidenceStore, PresentationTrialReview } from './trial-review';
import { createProductionTrialWorkspace } from './trial-workspace-production';

const db = await getTestDB();
const scope = { userId: 'alice', sessionId: 'account' };
const cleanup: (() => Promise<void>)[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  for (const fn of cleanup.splice(0)) await fn();
  vi.restoreAllMocks();
});
const svg = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="white"/><text x="40" y="80" font-size="28">${label}</text></svg>`;
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releases.push(resolve);
  return { promise, resolve };
}
async function harness(adopt = true, budgets?: LearningBudgetPort) {
  const root = await mkdtemp(path.join(tmpdir(), 'heldout-trials-'));
  const storage = new FilePresentationStorage(root);
  const baselineImages = new Set<string>();
  const sources = new Map<string, StoredPresentationJob>();
  const saveSource = async (
    jobId: string,
    label: string,
    overrides: Partial<StoredPresentationJob> = {},
  ) => {
    const source: StoredPresentationJob = {
      input: { notebookId: 'studio', title: label, sourceVersionIds: [] },
      job: {
        jobId,
        versionId: 'v1',
        state: 'completed',
        createdAt: '2026-10-21',
        updatedAt: '2026-10-21',
      },
      plan: {
        planId: `${jobId}-plan`,
        title: label,
        aspectRatio: '16:9',
        sourceVersionIds: [],
        slides: [{ slideId: 's1', order: 1, svg: svg(label), notes: 'Keep notes' }],
      },
      ...overrides,
    };
    await storage.saveJob(scope, source);
    sources.set(jobId, structuredClone(source));
    baselineImages.add(
      (
        await sharp(Buffer.from(source.plan!.slides[0].svg))
          .resize({ width: 1400 })
          .flatten({ background: '#ffffff' })
          .png()
          .toBuffer()
      ).toString('base64'),
    );
    return source;
  };
  await saveSource('train', 'Training facts 100');
  await saveSource('a', 'Unseen task A 200');
  await saveSource('b', 'Unseen task B 300');
  const behavior: {
    outcome: 'improved' | 'tied' | 'regressed' | 'unknown';
    beforeProbe?: () => Promise<void>;
    beforeResolve?: () => Promise<void>;
  } = { outcome: 'improved' };
  let connectionCount = 0;
  const resolve = vi.fn(async () => {
    await behavior.beforeResolve?.();
    return {
      provider: 'selected-provider',
      model: `pinned-${++connectionCount}`,
      apiKey: 'secret-key',
      baseURL: 'https://models.test/v1',
      supportsVision: true,
    };
  });
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    const system = payload.messages[0].content;
    let reply: unknown;
    if (system.includes('受限配置提案器'))
      reply = {
        patch: { textSpacing: 'comfortable' },
        rationale: 'Only a pending hypothesis',
        experienceIds: [],
      };
    else if (system.includes('匿名PPT')) {
      const images = payload.messages[1].content.filter(
        (item: { type: string }) => item.type === 'image_url',
      );
      reply = {
        cases: ['A', 'B'].map((label, index) => {
          const original = baselineImages.has(images[index].image_url.url.split(',')[1]);
          return {
            label,
            visual: {
              status: !original && behavior.outcome === 'unknown' ? 'unknown' : 'passed',
              evidence: 'Deterministic pixel observation',
            },
            quality: Object.fromEntries(
              ['readability', 'hierarchy', 'composition', 'styleConsistency'].map((key) => [
                key,
                {
                  score: original
                    ? 2
                    : behavior.outcome === 'regressed'
                      ? 1
                      : behavior.outcome === 'tied'
                        ? 2
                        : 3,
                  evidence: 'Deterministic pixel observation',
                },
              ]),
            ),
          };
        }),
      };
    } else {
      await behavior.beforeProbe?.();
      const input = JSON.parse(payload.messages[1].content);
      reply = { svg: input.svg.replace('x="40"', 'x="60"') };
    }
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
  const evidence = new FileTrialEvidenceStore(path.join(root, 'trial-evidence'));
  const learning = new FileTrialLearningStore({
    root: path.join(root, 'trial-learning'),
    evidence,
    storage,
  });
  const workspace = createProductionTrialWorkspace({
    dataRoot: root,
    ...(budgets ? { budgets: async () => budgets } : {}),
    storage,
    memory,
    fetcher,
    resolve,
    learning,
  });
  const runtime = new AtomicRuntime([
    { id: 'presentation', version: 'test', operations: workspace.operations() },
  ]);
  const call = <T = TrialValidationView>(
    name: string,
    input: unknown,
    owner: RuntimeScope = scope,
  ) => runtime.invoke<T>(`presentation.validation.${name}`, input, { scope: owner });
  cleanup.push(async () => {
    await workspace.drain();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await workspace.start(scope, {
    jobId: 'train',
    expectedVersionId: 'v1',
    slideId: 's1',
    requestId: randomUUID(),
    confirmed: true,
  });
  await workspace.drain();
  const execution = (await workspace.status(scope, 'train', 's1')).execution!;
  expect(execution.state).toBe('completed');
  const review = new PresentationTrialReview(evidence, storage, storage, learning);
  const comparison = await review.read(scope, execution.runId!);
  const choice = await review.choose(scope, {
    confirmed: true,
    evidenceDigest: comparison.evidenceDigest,
    expectedVersionId: 'v1',
    jobId: 'train',
    runId: comparison.runId,
    variantId: adopt ? 'candidate' : 'baseline',
    requestId: randomUUID(),
    reason: 'Only observed on the source page',
  });
  const episodeId = choice.learningEpisodeId!;
  const targets: ValidationTarget[] = ['a', 'b'].map((jobId) => ({
    jobId,
    slideId: 's1',
    expectedVersionId: 'v1',
  }));
  const createInput = { episodeId, requestId: randomUUID(), targets, confirmed: true };
  const create = () => call('create', createInput);
  const start = (validationId: string) => call('start', { validationId, confirmed: true });
  return {
    root,
    runtime,
    storage,
    sources,
    saveSource,
    fetcher,
    resolve,
    workspace,
    learning,
    evidence,
    call,
    episodeId,
    targets,
    createInput,
    create,
    start,
    behavior,
  };
}

describe('preregistered two-task held-out validation', () => {
  it('allocates both held-out pages under one parent with the original presentation subject', async () => {
    await db.insert(users).values({ id: scope.userId });
    try {
      const budgets = new DatabaseLearningBudget(db);
      const h = await harness(true, budgets);
      const before = h.fetcher.mock.calls.length;
      const plan = await h.create();
      await h.start(plan.validationId);
      await h.workspace.drain();
      const result = await h.call('status', { validationId: plan.validationId });
      expect(result.state, JSON.stringify(result)).toBe('completed');
      const parent = await budgets.read(
        {
          userId: scope.userId,
          subject: { kind: 'presentation', sessionId: scope.sessionId, jobId: 'train' },
        },
        `presentation-validation:${plan.validationId}`,
      );
      expect(Object.keys(parent.children)).toHaveLength(2);
      expect(Object.keys(parent.attempts)).toHaveLength(4);
      expect(parent.limit).toEqual({ calls: 4, tokens: 80000, costMicros: 3500000 });
      expect(h.fetcher.mock.calls.length - before).toBe(4);
      for (const id of ['train', 'a', 'b'])
        expect(await h.storage.getJob(scope, id)).toEqual(h.sources.get(id));
    } finally {
      await db.delete(users).where(eq(users.id, scope.userId));
    }
  });

  it.each(['improved', 'tied', 'regressed', 'unknown'] as const)(
    'runs a frozen policy with real PNGs and reports %s without promotion',
    async (outcome) => {
      const h = await harness();
      h.behavior.outcome = outcome;
      const before = h.fetcher.mock.calls.length;
      const plan = await h.create();
      expect(plan).toMatchObject({
        state: 'prepared',
        automaticPromotion: false,
        budget: { maxTokens: 80000, maxProbes: 2, maxRenders: 4, maxEvaluations: 2 },
      });
      expect(h.fetcher).toHaveBeenCalledTimes(before);
      await h.start(plan.validationId);
      await h.workspace.drain();
      const result = await h.call('status', { validationId: plan.validationId });
      expect(result.state).toBe('completed');
      expect(result.verdict).toBe(
        {
          improved: 'review-ready',
          tied: 'no-improvement',
          regressed: 'regressed',
          unknown: 'insufficient-evidence',
        }[outcome],
      );
      expect(result.charged).toEqual({ tokens: 40, costMicros: 3_500_000 });
      expect(h.resolve).toHaveBeenCalledTimes(2);
      const paid = h.fetcher.mock.calls
        .slice(before)
        .map(([, init]) => JSON.parse(String(init.body)));
      expect(paid).toHaveLength(4);
      expect(paid.every((input) => input.model === 'pinned-2')).toBe(true);
      expect(JSON.stringify(paid)).not.toContain('Only a pending hypothesis');
      expect(JSON.stringify(paid)).not.toContain('Training facts');
      expect(JSON.stringify(paid)).not.toContain('pendingExperiences');
      for (const id of ['train', 'a', 'b'])
        expect(await h.storage.getJob(scope, id)).toEqual(h.sources.get(id));
      expect((await h.learning.readStored(scope, h.episodeId))?.status).toBe('pending-validation');
      const manifest = await readFile(
        path.join(
          h.root,
          'trial-validation',
          trialDigest([scope.userId, scope.sessionId]),
          `${plan.validationId}.json`,
        ),
        'utf8',
      );
      expect(manifest).not.toContain('secret-key');
      expect(JSON.parse(manifest).body.seed.evidence.variants[1].configuration.policy).toEqual({
        textSpacing: 'comfortable',
      });
      expect((await h.start(plan.validationId)).state).toBe('completed');
      expect(h.fetcher).toHaveBeenCalledTimes(before + 4);
    },
  );
  it('requires an adopted single-dimension configuration', async () => {
    const h = await harness(false);
    await expect(h.create()).rejects.toThrow();
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });
  it('refuses two pages from the same task, training tasks and copies with different geometry', async () => {
    const h = await harness();
    await expect(
      h.call('create', { ...h.createInput, targets: [h.targets[0], h.targets[0]] }),
    ).rejects.toThrow();
    await expect(
      h.call('create', {
        ...h.createInput,
        targets: [{ ...h.targets[0], jobId: 'train' }, h.targets[1]],
      }),
    ).rejects.toThrow();
    await h.saveSource('copy', 'Training facts 100', {
      plan: {
        ...h.sources.get('train')!.plan!,
        slides: [
          {
            ...h.sources.get('train')!.plan!.slides[0],
            svg: svg('Training facts 100').replace('x="40"', 'x="150"'),
          },
        ],
      },
    });
    await expect(
      h.call('create', {
        ...h.createInput,
        targets: [{ ...h.targets[0], jobId: 'copy' }, h.targets[1]],
      }),
    ).rejects.toThrow();
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });
  it('reserves held-out tasks and content against later search, clones and another cohort', async () => {
    const h = await harness();
    await h.create();
    await expect(
      h.workspace.start(scope, { ...h.targets[0], requestId: randomUUID(), confirmed: true }),
    ).rejects.toThrow();
    await expect(h.call('create', { ...h.createInput, requestId: randomUUID() })).rejects.toThrow();
    const choices = await h.call<{ targets: unknown[]; validations: unknown[] }>('options', {
      episodeId: h.episodeId,
    });
    expect(choices.targets).toHaveLength(0);
    expect(choices.validations).toHaveLength(1);
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });
  it('replays an identical manifest and rejects changed intent under the same request identity', async () => {
    const h = await harness();
    const first = await h.create();
    expect(await h.create()).toEqual(first);
    await expect(
      h.call('create', { ...h.createInput, targets: [...h.targets].reverse() }),
    ).rejects.toThrow();
    await expect(
      h.call('create', { ...h.createInput, policy: { textSpacing: 'compact' } }),
    ).rejects.toThrow();
    await expect(
      h.call('start', { validationId: first.validationId, confirmed: true, maxTokens: 999999 }),
    ).rejects.toThrow();
  });
  it('rechecks every source before any paid work and rejects same-version edits', async () => {
    const h = await harness();
    const plan = await h.create();
    const updated = structuredClone(h.sources.get('b')!);
    updated.plan!.title = 'A concurrent edit';
    await h.storage.saveJob(scope, updated);
    await expect(h.start(plan.validationId)).rejects.toMatchObject({
      code: 'TRIAL_SOURCE_CHANGED',
    });
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });
  it('stops the cohort when a later source changes during the first run', async () => {
    const h = await harness();
    const plan = await h.create();
    h.behavior.beforeProbe = async () => {
      const updated = structuredClone(h.sources.get('b')!);
      updated.job.versionId = 'v2';
      await h.storage.saveJob(scope, updated);
    };
    await h.start(plan.validationId);
    await h.workspace.drain();
    const result = await h.call('status', { validationId: plan.validationId });
    expect(result).toMatchObject({ state: 'failed', verdict: 'insufficient-evidence' });
    expect(h.fetcher).toHaveBeenCalledTimes(5);
    expect(await h.evidence.list(scope, 'a', 's1')).toHaveLength(0);
  });
  it('seals intermediate scores and holds the shared worker until cancelled calls drain', async () => {
    const h = await harness();
    const plan = await h.create();
    const entered = latch(),
      release = latch();
    let probes = 0;
    h.behavior.beforeProbe = async () => {
      if (++probes === 2) {
        entered.resolve();
        await release.promise;
      }
    };
    await h.start(plan.validationId);
    await entered.promise;
    const during = await h.call('status', { validationId: plan.validationId });
    expect(during.targets.every((target) => !target.runId)).toBe(true);
    expect(during.targets.every((target) => target.outcome === 'running')).toBe(true);
    expect(await h.evidence.list(scope, 'a', 's1')).toEqual([]);
    const peer = createProductionTrialWorkspace({
      dataRoot: h.root,
      storage: h.storage,
      learning: h.learning,
      memory: new FileCapabilityCapsuleStore(path.join(h.root, 'memory')),
      fetcher: h.fetcher,
      resolve: h.resolve,
    });
    const peerRuntime = new AtomicRuntime([
      { id: 'presentation', version: 'peer', operations: peer.operations() },
    ]);
    cleanup.push(async () => {
      await peer.drain();
      await peerRuntime.dispose();
    });
    await peerRuntime.invoke(
      'presentation.validation.cancel',
      { validationId: plan.validationId },
      { scope },
    );
    await vi.waitFor(async () =>
      expect((await h.call('status', { validationId: plan.validationId })).state).toBe('cancelled'),
    );
    const busy = await acquirePresentationExecutionLease(
      path.join(h.root, 'trial-tasks', trialDigest([scope.userId, scope.sessionId]), 'worker.lock'),
    );
    expect(busy).toBeNull();
    release.resolve();
    await h.workspace.drain();
    expect((await h.start(plan.validationId)).state).toBe('cancelled');
    expect(h.fetcher).toHaveBeenCalledTimes(6);
  });
  it('cancels a prepared cohort without resolving a model or running a page', async () => {
    const h = await harness();
    const plan = await h.create();
    expect((await h.call('cancel', { validationId: plan.validationId })).state).toBe('cancelled');
    expect((await h.start(plan.validationId)).state).toBe('cancelled');
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });
  it('does not replay a claimed cohort after losing the state record', async () => {
    const h = await harness();
    const plan = await h.create();
    await h.start(plan.validationId);
    await h.workspace.drain();
    await unlink(
      path.join(
        h.root,
        'trial-validation',
        trialDigest([scope.userId, scope.sessionId]),
        `${plan.validationId}.state.json`,
      ),
    );
    await unlink(
      path.join(
        h.root,
        'trial-validation',
        trialDigest([scope.userId, scope.sessionId]),
        `${plan.validationId}.result.json`,
      ),
    );
    expect((await h.start(plan.validationId)).state).toBe('interrupted');
    expect(h.fetcher).toHaveBeenCalledTimes(7);
  });
  it('rejects shared source-document versions across the two held-out tasks', async () => {
    const h = await harness();
    for (const id of ['a', 'b']) {
      const source = structuredClone(h.sources.get(id)!);
      source.input.sourceVersionIds = ['shared-document-v1'];
      await h.storage.saveJob(scope, source);
    }
    await expect(h.create()).rejects.toThrow();
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });
  it('excludes a page already used by an ordinary proposal trial', async () => {
    const h = await harness();
    await h.workspace.start(scope, { ...h.targets[0], requestId: randomUUID(), confirmed: true });
    await h.workspace.drain();
    await expect(h.create()).rejects.toThrow();
    expect(h.fetcher).toHaveBeenCalledTimes(6);
  });
  it('rechecks the first source under its edit lock after the second page finishes', async () => {
    const h = await harness();
    const plan = await h.create();
    let probes = 0;
    h.behavior.beforeProbe = async () => {
      if (++probes !== 2) return;
      const edit = structuredClone(h.sources.get('a')!);
      edit.plan!.slides[0].notes = 'Concurrent user notes';
      await h.storage.saveJob(scope, edit);
    };
    await h.start(plan.validationId);
    await h.workspace.drain();
    expect(await h.call('status', { validationId: plan.validationId })).toMatchObject({
      state: 'failed',
      verdict: 'insufficient-evidence',
    });
    expect((await h.storage.getJob(scope, 'a'))?.plan?.slides[0].notes).toBe(
      'Concurrent user notes',
    );
    expect(await h.evidence.list(scope, 'a', 's1')).toEqual([]);
    expect(h.fetcher).toHaveBeenCalledTimes(7);
  });
  it('freezes owned asset bytes and rejects drift before resolving a model', async () => {
    const h = await harness();
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    await h.storage.put(scope, {
      artifactId: 'asset',
      name: 'asset.png',
      type: 'image',
      mimeType: 'image/png',
      bytes,
    });
    const source = structuredClone(h.sources.get('a')!);
    source.plan!.slides[0].svg = source.plan!.slides[0].svg.replace(
      '</svg>',
      '<image href="/api/runtime/presentation/artifacts/asset?raw=true" x="50" y="120" width="10" height="10"/></svg>',
    );
    await h.storage.saveJob(scope, source);
    const plan = await h.create();
    const originalGet = h.storage.get.bind(h.storage);
    vi.spyOn(h.storage, 'get').mockImplementation(async (scope, id) => {
      const asset = await originalGet(scope, id);
      return asset && id === 'asset' ? { ...asset, bytes: new Uint8Array([1, 2, 3]) } : asset;
    });
    await expect(h.start(plan.validationId)).rejects.toMatchObject({
      code: 'TRIAL_SOURCE_CHANGED',
    });
    expect(h.resolve).toHaveBeenCalledTimes(1);
  });
  it('stops after an over-budget provider receipt with no evaluation or second page', async () => {
    const h = await harness();
    const plan = await h.create();
    h.fetcher.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'pinned-2',
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({ svg: h.sources.get('a')!.plan!.slides[0].svg }),
            },
          },
        ],
        usage: { total_tokens: 40001 },
      }),
    }));
    await h.start(plan.validationId);
    await h.workspace.drain();
    expect(await h.call('status', { validationId: plan.validationId })).toMatchObject({
      state: 'failed',
      verdict: 'insufficient-evidence',
      charged: { tokens: 40001, costMicros: 750000 },
    });
    expect(h.fetcher).toHaveBeenCalledTimes(4);
  });
  it('bounds connection preparation by the whole-cohort deadline and holds the lock until it drains', async () => {
    const h = await harness();
    const plan = await h.create();
    const entered = latch(),
      release = latch();
    h.behavior.beforeResolve = async () => {
      entered.resolve();
      await release.promise;
    };
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: Parameters<typeof setTimeout>[0],
      ms?: number,
      ...args: unknown[]
    ) => schedule(fn, ms === 360000 ? 30 : ms, ...args)) as typeof setTimeout);
    await h.start(plan.validationId);
    await entered.promise;
    await vi.waitFor(async () =>
      expect((await h.call('status', { validationId: plan.validationId })).state).toBe(
        'deadline-exceeded',
      ),
    );
    const busy = await acquirePresentationExecutionLease(
      path.join(h.root, 'trial-tasks', trialDigest([scope.userId, scope.sessionId]), 'worker.lock'),
    );
    expect(busy).toBeNull();
    release.resolve();
    await h.workspace.drain();
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });
  it('does not misclassify a live worker between the immutable start marker and first state write', async () => {
    const h = await harness();
    const plan = await h.create();
    const directory = path.join(
      h.root,
      'trial-validation',
      trialDigest([scope.userId, scope.sessionId]),
    );
    const lease = await acquirePresentationExecutionLease(
      path.join(directory, `${plan.validationId}.worker.lock`),
    );
    expect(lease).not.toBeNull();
    try {
      await writeFile(
        path.join(directory, `${plan.validationId}.started.json`),
        JSON.stringify({ manifestDigest: plan.manifestDigest }),
      );
      expect((await h.call('status', { validationId: plan.validationId })).state).toBe('running');
    } finally {
      await lease!.release();
    }
    expect(await h.call('status', { validationId: plan.validationId })).toMatchObject({
      state: 'interrupted',
      charged: { tokens: 80000, costMicros: 3500000 },
    });
    expect((await h.start(plan.validationId)).state).toBe('interrupted');
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });
  it('enforces ownership and manifest digest before starting', async () => {
    const h = await harness();
    const plan = await h.create();
    await expect(
      h.call(
        'status',
        { validationId: plan.validationId },
        { userId: 'bob', sessionId: 'account' },
      ),
    ).rejects.toThrow();
    const file = path.join(
      h.root,
      'trial-validation',
      trialDigest([scope.userId, scope.sessionId]),
      `${plan.validationId}.json`,
    );
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    envelope.body.policy = { textSpacing: 'compact' };
    await writeFile(file, JSON.stringify(envelope));
    await expect(h.start(plan.validationId)).rejects.toThrow();
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });
});
