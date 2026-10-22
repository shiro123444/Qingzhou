import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AtomicRuntime } from '../atomic-runtime';
import page from './__fixtures__/trial-text-overflow.json';
import { FilePresentationStorage, type StoredPresentationJob } from './file-storage';
import { trialDigest } from './trial-configuration';
import type { AnonymousTrialScores } from './trial-evaluation';
import { FileTrialLearningStore } from './trial-learning';
import { FileTrialEvidenceStore, PresentationTrialReview } from './trial-review';
import { createTrialExecutionPlugin, RepresentativeTrialRunner } from './trial-runner';
import { fitTrialPageText } from './trial-text-layout';
import { captureLearningEpisode } from '../improvement/episode';

const scope = { userId: 'alice', sessionId: 'account' };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  vi.restoreAllMocks();
});
async function fixture(
  failedGate = false,
  withLearning = false,
  layoutPatch = false,
  policyPatch = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'trial-review-'));
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
      designSpec: { templateVisualReview: { final: { passed: true } } },
      slides: [
        { slideId: 's1', order: 1, svg: page.source.svg, notes: page.source.notes },
        {
          slideId: 's2',
          order: 2,
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="30" y="50">Untouched</text></svg>',
        },
      ],
    },
  };
  await storage.saveJob(scope, source);
  const layoutCapsule = {
    id: `capsule-${'a'.repeat(40)}`,
    schemaVersion: 1 as const,
    kind: 'layout' as const,
    name: 'Fixture grouping',
    triggers: ['paragraph grouping'],
    source: { evidencePages: [1] },
    rules: ['Group paragraphs'],
    palette: [],
    createdAt: '2026-10-21',
  };
  const runtime = new AtomicRuntime([
    {
      id: 'presentation',
      version: '1',
      operations: [
        {
          name: 'presentation.memory.compose',
          description: 'Owned test compose',
          input: z.any(),
          execute: (input: { ids: string[] }) => ({ capsules: input.ids.map(() => layoutCapsule) }),
        },
      ],
    },
    createTrialExecutionPlugin({
      version: 'test-v1',
      probe: async ({ signal }) => ({
        page: { svg: fitTrialPageText(page.overflowSvg, signal), notes: page.source.notes },
        usage: { tokens: 0, costMicros: 0 },
      }),
      render: async ({ plan }) => ({
        bytes: new Uint8Array(await sharp(Buffer.from(plan.slides[0].svg)).png().toBuffer()),
        usage: { tokens: 0, costMicros: 0 },
      }),
      evaluate: async (ctx) => ({
        usage: { tokens: 1, costMicros: 0 },
        cases: ctx.cases.map(({ label, svg }) => ({
          label,
          gates: Object.fromEntries(
            ['facts', 'editability', 'assets', 'render', 'visual'].map((key) => [
              key,
              {
                status:
                  failedGate && key === 'visual' && svg !== page.source.svg ? 'failed' : 'passed',
                evidence: 'Fixture pixel evidence',
              },
            ]),
          ) as AnonymousTrialScores['cases'][number]['gates'],
          quality: Object.fromEntries(
            ['readability', 'hierarchy', 'composition', 'styleConsistency'].map((key) => [
              key,
              { score: svg === page.source.svg ? 2 : 3, evidence: 'Fixture quality' },
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
    maxOutputTokens: 1,
    temperature: 0,
  };
  const runner = new RepresentativeTrialRunner({
    runtime,
    repository: storage,
    artifacts: storage,
    root: path.join(root, 'runs'),
    budget: {
      maxProbes: 1,
      maxRenders: 2,
      maxEvaluations: 1,
      maxTokens: 50,
      maxCostMicros: 10,
      maxDurationMs: 30000,
      maxSnapshotBytes: 1024 * 1024,
      maxArtifactBytes: 1024 * 1024,
    },
    settings: async () => ({
      schemaVersion: 1,
      imageGeneration: false,
      executorVersion: 'test-v1',
      rendererVersion: 'test-sharp',
      recipe: { id: 'r', instructions: 'test' },
      models: { planner: model, observer: model },
      frozenInputs: {},
      baselineCapsuleIds: [],
      probeAllowance: { tokens: 5, costMicros: 0 },
      evaluation: { version: 'test-review', allowance: { tokens: 5, costMicros: 0 } },
    }),
    publishEvidence: (scope, report) => evidence.publish(scope, report),
  });
  const report = await runner.run(
    {
      jobId: 'source',
      expectedVersionId: 'v1',
      slideId: 's1',
      candidates: [
        {
          id: 'candidate',
          patch: layoutPatch
            ? { layoutCapsuleIds: [layoutCapsule.id] }
            : policyPatch
              ? { textSpacing: 'comfortable' }
              : {},
        },
      ],
    },
    { scope },
  );
  cleanups.push(async () => {
    await runner.drain();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const learning = new FileTrialLearningStore({
    root: path.join(root, 'learning'),
    evidence,
    storage,
  });
  const review = new PresentationTrialReview(
    evidence,
    storage,
    storage,
    withLearning ? learning : undefined,
  );
  const view = await review.read(scope, report.runId);
  const choice = {
    jobId: 'source',
    runId: report.runId,
    evidenceDigest: view.evidenceDigest,
    expectedVersionId: 'v1',
    variantId: 'candidate',
    requestId: randomUUID(),
    confirmed: true as const,
  };
  return { root, storage, evidence, learning, review, view, choice, source, report };
}

describe('owned trial review and immutable version CAS', () => {
  it('keeps legacy sidecars byte-for-byte while recording new commands with a real presentation subject', async () => {
    const h = await fixture(false, true);
    const result = await h.review.choose(scope, { ...h.choice, variantId: 'baseline' });
    const id = result.learningEpisodeId!;
    const legacy = await captureLearningEpisode({
      id,
      domain: 'presentation',
      scope: { userId: scope.userId, agentId: `presentation:${scope.sessionId}` },
      evidenceRef: id,
      configurations: [{ original: 'legacy material' }],
      outcome: 'baseline',
      applicability: 'source-page-only',
    });
    const directory = path.join(
      h.root,
      'learning',
      trialDigest([scope.userId, scope.sessionId]),
      'protocol',
    );
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${id}.json`),
      bytes = JSON.stringify(legacy);
    await writeFile(file, bytes);
    expect(await h.learning.readLegacyProtocol(scope, id)).toEqual(legacy);
    const current = await h.learning.readProtocol(scope, id);
    expect(current?.episode).toMatchObject({
      schemaVersion: 2,
      scope: {
        userId: scope.userId,
        subject: { kind: 'presentation', jobId: 'source', sessionId: scope.sessionId },
      },
      selection: { type: 'artifact-fork', action: 'keep' },
      validation: 'pending',
    });
    expect(await readFile(file, 'utf8')).toBe(bytes);
    expect(JSON.stringify(current)).not.toContain('agentId');
  });
  it('archives complete evidence and exposes only owned previews and evaluation', async () => {
    const h = await fixture();
    expect(await h.review.list(scope, 'source', 's1')).toEqual({
      trials: [{ runId: h.report.runId }],
    });
    expect(h.view.variants).toHaveLength(2);
    expect(h.view.variants[1].selectable).toBe(true);
    expect(JSON.stringify(h.view)).not.toContain(h.root);
    expect(JSON.stringify(h.view)).not.toContain('<svg');
    await h.evidence.publish(scope, h.report);
    const raw = await h.evidence.read(scope, h.report.runId);
    expect(raw.body.configurations).toHaveLength(2);
    expect(raw.body.plans[0].slides[0].svg).toBe(page.source.svg);
  });
  it('creates a separate version, replacing only the selected page and retaining source bytes and evidence', async () => {
    const h = await fixture();
    const before = await h.storage.getJob(scope, 'source');
    const result = await h.review.choose(scope, h.choice);
    expect(result.status).toBe('created');
    expect(result.jobId).not.toBe('source');
    expect(result.versionId).not.toBe('v1');
    const next = await h.storage.getJob(scope, result.jobId);
    expect(next?.plan?.slides[0].svg).toBe(
      fitTrialPageText(page.overflowSvg, new AbortController().signal),
    );
    expect(next?.plan?.slides[1]).toEqual(h.source.plan!.slides[1]);
    expect(next?.plan?.designSpec).not.toHaveProperty('templateVisualReview');
    expect(next?.plan?.designSpec?.trialLineage).toMatchObject({
      runId: h.report.runId,
      source: { versionId: 'v1' },
    });
    expect(next?.job.artifactIds).toHaveLength(2);
    expect(await h.storage.getJob(scope, 'source')).toEqual(before);
    expect((await h.evidence.read(scope, h.report.runId)).digest).toBe(h.view.evidenceDigest);
  });
  it('records keeping baseline without creating a new job', async () => {
    const h = await fixture();
    const result = await h.review.choose(scope, { ...h.choice, variantId: 'baseline' });
    expect(result).toEqual({ status: 'kept', jobId: 'source', versionId: 'v1' });
    expect(await h.storage.listJobs(scope)).toHaveLength(1);
  });
  it('requires explicit confirmation and refuses caller-supplied SVG', async () => {
    const h = await fixture();
    await expect(h.review.choose(scope, { ...h.choice, confirmed: false })).rejects.toMatchObject({
      code: 'PRESENTATION_INVALID',
    });
    await expect(h.review.choose(scope, { ...h.choice, svg: '<svg/>' })).rejects.toMatchObject({
      code: 'PRESENTATION_INVALID',
    });
    expect(await h.storage.listJobs(scope)).toHaveLength(1);
  });
  it.each(['version', 'content', 'active'])(
    'rejects a stale %s before creating a new version',
    async (kind) => {
      const h = await fixture();
      const newer = structuredClone(h.source);
      if (kind === 'version') newer.job.versionId = 'v2';
      if (kind === 'content')
        newer.plan!.slides = [
          { ...newer.plan!.slides[0], notes: 'Concurrent change' },
          newer.plan!.slides[1],
        ];
      if (kind === 'active') newer.job.state = 'queued';
      const other = new FilePresentationStorage(path.join(h.root, 'data'));
      const lease = await other.acquireLease(scope, 'source');
      expect(lease).not.toBeNull();
      await other.saveJob(scope, newer);
      await lease!.release();
      await expect(h.review.choose(scope, h.choice)).rejects.toMatchObject({
        code: 'PRESENTATION_CONFLICT',
      });
      expect(await h.storage.getJob(scope, 'source')).toEqual(newer);
      expect(await h.storage.listJobs(scope)).toHaveLength(1);
    },
  );
  it('uses the same cross-process source lease as concurrent live editing', async () => {
    const h = await fixture();
    const other = new FilePresentationStorage(path.join(h.root, 'data'));
    const lease = await other.acquireLease(scope, 'source');
    try {
      await expect(h.review.choose(scope, h.choice)).rejects.toMatchObject({
        code: 'PRESENTATION_CONFLICT',
      });
    } finally {
      await lease!.release();
    }
    expect((await h.review.choose(scope, h.choice)).status).toBe('created');
  });
  it('retries a confirmation idempotently, including after a later source edit', async () => {
    const h = await fixture();
    const first = await h.review.choose(scope, h.choice);
    await h.storage.saveJob(scope, { ...h.source, job: { ...h.source.job, versionId: 'v2' } });
    expect(await h.review.choose(scope, h.choice)).toEqual(first);
    expect(await h.storage.listJobs(scope)).toHaveLength(2);
    await expect(
      h.review.choose(scope, { ...h.choice, variantId: 'baseline' }),
    ).rejects.toMatchObject({ code: 'PRESENTATION_CONFLICT' });
  });
  it('does not permit failed gates or cross-account evidence to be selected', async () => {
    const h = await fixture(true);
    expect(h.view.variants[1].selectable).toBe(false);
    await expect(h.review.choose(scope, h.choice)).rejects.toMatchObject({
      code: 'PRESENTATION_INVALID',
    });
    await expect(
      h.review.read({ userId: 'bob', sessionId: 'account' }, h.report.runId),
    ).rejects.toMatchObject({ code: 'PRESENTATION_NOT_FOUND' });
  });
  it('detects evidence modification and preserves the original run files', async () => {
    const h = await fixture();
    const dir = path.join(h.root, 'evidence', trialDigest([scope.userId, scope.sessionId]), 'runs');
    const file = path.join(dir, (await readdir(dir))[0]);
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.body.plans[1].slides[0].svg = 'tampered';
    await writeFile(file, JSON.stringify(record));
    await expect(h.review.read(scope, h.report.runId)).rejects.toMatchObject({
      code: 'PRESENTATION_INVALID',
    });
    expect(
      JSON.parse(await readFile(path.join(h.report.directory!, 'plan-1.json'), 'utf8')).slides[0]
        .svg,
    ).not.toBe('tampered');
  });
  it('cancels before publication, with an unchanged source and no accepted version', async () => {
    const h = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(h.review.choose(scope, h.choice, controller.signal)).rejects.toThrow();
    expect(await h.storage.listJobs(scope)).toHaveLength(1);
  });
  it('does not record a keep decision if cancelled during the source CAS read', async () => {
    const h = await fixture();
    const controller = new AbortController();
    const get = h.storage.getJob.bind(h.storage);
    vi.spyOn(h.storage, 'getJob').mockImplementation(async (...args) => {
      const result = await get(...args);
      if (args[1] === 'source') controller.abort();
      return result;
    });
    await expect(
      h.review.choose(scope, { ...h.choice, variantId: 'baseline' }, controller.signal),
    ).rejects.toThrow();
    await expect(
      readFile(h.evidence.decisionFile(scope, 'source', h.choice.requestId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await h.storage.listJobs(scope)).toHaveLength(1);
  });
  it('cancels during artifact preparation while keeping the source lease until cleanup', async () => {
    const h = await fixture();
    const controller = new AbortController();
    const put = h.storage.put.bind(h.storage);
    vi.spyOn(h.storage, 'put').mockImplementationOnce(async (...args) => {
      controller.abort();
      const other = new FilePresentationStorage(path.join(h.root, 'data'));
      expect(await other.acquireLease(scope, 'source')).toBeNull();
      return put(...args);
    });
    await expect(h.review.choose(scope, h.choice, controller.signal)).rejects.toThrow();
    expect(await h.storage.listJobs(scope)).toHaveLength(1);
    expect(await h.storage.getJob(scope, 'source')).toEqual(h.source);
    const lease = await h.storage.acquireLease(scope, 'source');
    expect(lease).not.toBeNull();
    await lease!.release();
  });
  it('keeps the durable version and replays its identity if disconnected after commit', async () => {
    const h = await fixture();
    const controller = new AbortController();
    const create = h.storage.createJobImmutable.bind(h.storage);
    vi.spyOn(h.storage, 'createJobImmutable').mockImplementationOnce(async (...args) => {
      await create(...args);
      controller.abort();
    });
    const first = await h.review.choose(scope, h.choice, controller.signal);
    expect(first.status).toBe('created');
    expect(await h.review.choose(scope, h.choice)).toEqual(first);
    expect(await h.storage.listJobs(scope)).toHaveLength(2);
  });
  it('recovers a published version if the choice receipt was interrupted, without overwriting it', async () => {
    const h = await fixture();
    const first = await h.review.choose(scope, h.choice);
    await rm(h.evidence.decisionFile(scope, 'source', h.choice.requestId));
    await h.storage.saveJob(scope, { ...h.source, job: { ...h.source.job, versionId: 'v2' } });
    expect(await h.review.choose(scope, h.choice)).toEqual(first);
    const next = (await h.storage.getJob(scope, first.jobId))!;
    await expect(
      h.storage.createJobImmutable(scope, { ...next, plan: h.source.plan }),
    ).rejects.toMatchObject({ code: 'PRESENTATION_CONFLICT' });
    expect(await h.storage.getJob(scope, first.jobId)).toEqual(next);
    expect(await h.storage.listJobs(scope)).toHaveLength(2);
  });
  it('retains adopted full configurations, page deltas, evaluation and the new version as pending experience', async () => {
    const h = await fixture(false, true);
    const choice = { ...h.choice, reason: '  正文分组更清楚，便于讲解。  ' };
    const result = await h.review.choose(scope, choice);
    expect(result).toMatchObject({
      status: 'created',
      learningStatus: 'recorded',
      learningEpisodeId: expect.any(String),
    });
    const episode = await h.learning.read(scope, result.learningEpisodeId!);
    expect(episode).toMatchObject({
      kind: 'decision',
      status: 'pending-validation',
      outcome: 'candidate-adopted',
      selectedVariantId: 'candidate',
      reasonProvided: true,
      reason: '正文分组更清楚，便于讲解。',
      lesson: { applicability: 'source-page-only', transfer: 'unverified' },
      result: { jobId: result.jobId, versionId: result.versionId },
    });
    expect(episode.variants[1]).toMatchObject({
      changedPaths: [],
      pageChanged: true,
      available: { configuration: true, preview: true, evaluation: true, plan: true },
    });
    const privateRecord = await h.learning.readStored(scope, episode.episodeId);
    expect(privateRecord?.evidence.variants[0].configuration?.sourcePlan).toEqual(h.source.plan);
    expect(privateRecord?.evidence.variants[1].configuration).toEqual(
      (await h.evidence.read(scope, h.report.runId)).body.configurations[1],
    );
    expect(privateRecord?.evidence.variants[1].preview).toBeTruthy();
    const protocol = await h.learning.readProtocol(scope, episode.episodeId);
    expect(protocol?.episode.selection).toMatchObject({
      action: 'adopt',
      type: 'artifact-fork',
      requestId: choice.requestId,
      sourceVersionId: 'v1',
      resultVersionId: result.versionId,
      selectedRevisionId: protocol?.episode.candidateRevisionId,
      reason: '正文分组更清楚，便于讲解。',
    });
    expect(protocol?.episode.validation).toBe('pending');
    expect(JSON.stringify(episode)).not.toContain(h.root);
    expect(JSON.stringify(episode)).not.toContain('<svg');
    expect((await h.learning.list(scope, 'source', 's1')).episodes).toHaveLength(1);
    expect((await h.learning.list(scope, result.jobId, 's1')).episodes).toHaveLength(1);
    expect((await h.review.choose(scope, choice)).learningEpisodeId).toBe(result.learningEpisodeId);
    expect(await h.storage.listJobs(scope)).toHaveLength(2);
  });
  it('records keeping the original without inventing a user reason or promoting a capability', async () => {
    const h = await fixture(false, true);
    const result = await h.review.choose(scope, { ...h.choice, variantId: 'baseline' });
    const episode = await h.learning.read(scope, result.learningEpisodeId!);
    expect(episode).toMatchObject({
      status: 'pending-validation',
      outcome: 'baseline-kept',
      reasonProvided: false,
      selectedVariantId: 'baseline',
      result: { status: 'kept', jobId: 'source', versionId: 'v1' },
    });
    expect(episode.reason).toBeUndefined();
    const protocol = await h.learning.readProtocol(scope, episode.episodeId);
    expect(protocol?.episode.selection).toMatchObject({
      action: 'keep',
      type: 'artifact-fork',
      selectedRevisionId: protocol?.episode.baselineRevisionId,
    });
    expect(protocol?.episode.selection?.reason).toBeUndefined();
    expect(await h.storage.listJobs(scope)).toHaveLength(1);
    expect(h.learning.operations().map((op) => op.name)).toEqual([
      'presentation.learning.list',
      'presentation.learning.read',
    ]);
    expect(h.learning.operations().every((op) => !op.agent)).toBe(true);
    expect(
      h.learning
        .operations()[0]
        .input.safeParse({ jobId: 'source', slideId: 's1', status: 'active' }).success,
    ).toBe(false);
  });
  it('recovers learning after an interrupted receipt or archive, without creating another version', async () => {
    const h = await fixture(false, true);
    const record = vi
      .spyOn(h.learning, 'recordDecision')
      .mockRejectedValueOnce(new Error('Disk temporarily unavailable'));
    const result = await h.review.choose(scope, h.choice);
    expect(result).toMatchObject({ status: 'created', learningStatus: 'pending' });
    await rm(h.evidence.decisionFile(scope, 'source', h.choice.requestId));
    record.mockRestore();
    const list = await h.learning.list(scope, 'source', 's1');
    expect(list.episodes).toHaveLength(1);
    expect(await h.learning.read(scope, list.episodes[0].episodeId)).toMatchObject({
      outcome: 'candidate-adopted',
      result: { jobId: result.jobId },
    });
    expect((await h.review.choose(scope, h.choice)).learningEpisodeId).toBe(
      list.episodes[0].episodeId,
    );
    expect(await h.storage.listJobs(scope)).toHaveLength(2);
  });
  it('does not turn an uncommitted candidate intent into an adoption', async () => {
    const h = await fixture(false, true),
      controller = new AbortController();
    const create = h.storage.createJobImmutable.bind(h.storage);
    vi.spyOn(h.storage, 'createJobImmutable').mockImplementationOnce(async (...args) => {
      controller.abort();
      return create(...args);
    });
    await expect(h.review.choose(scope, h.choice, controller.signal)).rejects.toThrow();
    expect((await h.learning.list(scope, 'source', 's1')).episodes).toHaveLength(0);
    expect(await h.storage.listJobs(scope)).toHaveLength(1);
  });
  it('does not record a recommendation or failed-gate candidate as user adoption', async () => {
    const h = await fixture(true, true);
    expect((await h.learning.list(scope, 'source', 's1')).episodes).toHaveLength(0);
    await expect(h.review.choose(scope, h.choice)).rejects.toMatchObject({
      code: 'PRESENTATION_INVALID',
    });
    expect((await h.learning.list(scope, 'source', 's1')).episodes).toHaveLength(0);
  });
  it('preserves the experience bundle after removal of original trial files and evidence archives', async () => {
    const h = await fixture(false, true);
    const result = await h.review.choose(scope, h.choice);
    await rm(h.report.directory!, { recursive: true });
    await rm(path.join(h.root, 'evidence'), { recursive: true });
    const view = await h.learning.read(scope, result.learningEpisodeId!);
    expect(view.variants[1].available).toEqual({
      configuration: true,
      plan: true,
      preview: true,
      evaluation: true,
    });
    expect(
      (await h.learning.readStored(scope, view.episodeId))?.evidence.variants[1].configuration
        ?.settings.recipe.instructions,
    ).toBe('test');
  });
  it('enforces experience ownership, digest integrity and immutable pending state', async () => {
    const h = await fixture(false, true);
    const result = await h.review.choose(scope, h.choice);
    await expect(
      h.learning.read({ userId: 'bob', sessionId: 'account' }, result.learningEpisodeId!),
    ).rejects.toMatchObject({ code: 'PRESENTATION_NOT_FOUND' });
    const file = path.join(
      h.root,
      'learning',
      trialDigest([scope.userId, scope.sessionId]),
      'episodes',
      `${result.learningEpisodeId}.json`,
    );
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.record.status = 'active';
    stored.digest = trialDigest(stored.record);
    await writeFile(file, JSON.stringify(stored));
    await expect(h.learning.read(scope, result.learningEpisodeId!)).rejects.toThrow();
  });
  it('bounds user reasons and refuses changed intent under the same confirmation identity', async () => {
    const h = await fixture(false, true);
    await expect(
      h.review.choose(scope, { ...h.choice, reason: 'x'.repeat(1001) }),
    ).rejects.toMatchObject({ code: 'PRESENTATION_INVALID' });
    await expect(h.review.choose(scope, { ...h.choice, reason: '   ' })).rejects.toMatchObject({
      code: 'PRESENTATION_INVALID',
    });
    await h.review.choose(scope, { ...h.choice, reason: 'Adopt this page only' });
    await expect(
      h.review.choose(scope, { ...h.choice, reason: 'Changed reason' }),
    ).rejects.toMatchObject({ code: 'PRESENTATION_CONFLICT' });
    expect((await h.learning.list(scope, 'source', 's1')).episodes).toHaveLength(1);
  });
  it('keeps the actual resolved configuration difference and the full candidate capsule', async () => {
    const h = await fixture(false, true, true);
    const result = await h.review.choose(scope, h.choice);
    const episode = await h.learning.read(scope, result.learningEpisodeId!);
    expect(episode.variants[1].changedPaths).toEqual(['capsules']);
    const raw = await h.learning.readStored(scope, episode.episodeId);
    expect(raw?.evidence.variants[1].configuration?.capsules[0]).toMatchObject({
      name: 'Fixture grouping',
      rules: ['Group paragraphs'],
    });
    expect(raw?.evidence.variants[0].configuration?.capsules).toEqual([]);
    expect(episode.status).toBe('pending-validation');
  });

  it('retains rejected candidate gates when the user explicitly keeps the original', async () => {
    const h = await fixture(true, true);
    const result = await h.review.choose(scope, {
      ...h.choice,
      variantId: 'baseline',
      reason: '保留原稿的正文边界',
    });
    const episode = await h.learning.read(scope, result.learningEpisodeId!);
    expect(episode).toMatchObject({ outcome: 'baseline-kept', reason: '保留原稿的正文边界' });
    expect(episode.variants[1].gates?.visual.status).toBe('failed');
    expect(episode.selectedVariantId).toBe('baseline');
  });
  it('recovers the originally adopted version without relabelling or overwriting a later edit', async () => {
    const h = await fixture(false, true);
    const archive = vi
      .spyOn(h.learning, 'recordDecision')
      .mockRejectedValueOnce(new Error('Archive interrupted'));
    const first = await h.review.choose(scope, h.choice);
    const later = (await h.storage.getJob(scope, first.jobId))!;
    later.job.versionId = 'later-user-edit';
    later.plan!.slides[0].notes = 'User edited this version';
    const lease = await h.storage.acquireLease(scope, first.jobId);
    await h.storage.saveJob(scope, later);
    await lease!.release();
    await rm(h.evidence.decisionFile(scope, 'source', h.choice.requestId));
    archive.mockRestore();
    const records = await h.learning.list(scope, first.jobId, 's1');
    expect(records.episodes).toHaveLength(1);
    expect((await h.learning.read(scope, records.episodes[0].episodeId)).result?.versionId).toBe(
      first.versionId,
    );
    const replay = await h.review.choose(scope, h.choice);
    expect(replay.versionId).toBe(first.versionId);
    expect(await h.storage.getJob(scope, first.jobId)).toEqual(later);
    expect(await h.storage.getJob(scope, 'source')).toEqual(h.source);
  });
});

describe('bounded pending experience retrieval for proposals', () => {
  it('includes the attempted configuration when the user kept the original, without exporting private evidence or scores', async () => {
    const h = await fixture(false, true, false, true);
    await h.review.choose(scope, {
      ...h.choice,
      variantId: 'baseline',
      reason: 'Original has clearer grouping',
    });
    const experiences = await h.learning.proposalExperiences(scope, 'source', 's1');
    expect(experiences).toHaveLength(1);
    expect(experiences[0]).toMatchObject({
      outcome: 'baseline-kept',
      attemptedPolicy: { textSpacing: 'comfortable' },
      reason: 'Original has clearer grouping',
      status: 'pending-validation',
      applicability: 'source-page-only',
    });
    expect(Object.keys(experiences[0]).sort()).toEqual([
      'applicability',
      'attemptedPolicy',
      'episodeId',
      'outcome',
      'reason',
      'status',
    ]);
    const episode = await h.learning.read(scope, experiences[0].episodeId);
    expect(episode.variants[1].changedPaths).toContain('policy');
    expect(
      await h.learning.proposalExperiences({ userId: 'bob', sessionId: 'account' }, 'source', 's1'),
    ).toEqual([]);
    expect(await h.learning.proposalExperiences(scope, 'source', 's2')).toEqual([]);
  });
  it('returns at most three observations and keeps all of them pending', async () => {
    const h = await fixture(false, true, false, true);
    for (let i = 0; i < 4; i++)
      await h.review.choose(scope, {
        ...h.choice,
        variantId: 'baseline',
        requestId: randomUUID(),
        reason: `Reason ${i}`,
      });
    const experiences = await h.learning.proposalExperiences(scope, 'source', 's1');
    expect(experiences).toHaveLength(3);
    expect(experiences.every((item) => item.status === 'pending-validation')).toBe(true);
  });
});
