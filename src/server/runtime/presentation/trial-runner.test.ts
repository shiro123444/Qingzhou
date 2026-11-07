import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AtomicRuntime } from '../atomic-runtime';
import { InMemoryPresentationArtifactStore } from './artifact-store';
import { capabilityMemoryOperations, FileCapabilityCapsuleStore } from './capability-memory';
import { FilePresentationStorage, type StoredPresentationJob } from './file-storage';
import { compileTemplateDesignProgram } from './templates/design-program';
import type { TemplateVisualProfile } from './templates/visual-types';
import {
  type TrialBudget,
  trialDigest,
  trialJson,
  type TrialRequest,
  type TrialSettings,
} from './trial-configuration';
import type { AnonymousTrialContext, AnonymousTrialScores } from './trial-evaluation';
import type { TrialProposalContext } from './trial-proposal';
import {
  createTrialExecutionPlugin,
  RepresentativeTrialRunner,
  type TrialStageContext,
} from './trial-runner';

const scope = { userId: 'alice', sessionId: 'studio' };
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  'base64',
);
const svg = (text: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="40" y="70">${text}</text></svg>`;
const cleanups: (() => Promise<void>)[] = [];
const unblocks: (() => void)[] = [];
afterEach(async () => {
  for (const unblock of unblocks.splice(0)) unblock();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  unblocks.push(() => resolve());
  return { promise, resolve };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'qingzhou-trial-runner-'));
  const storage = new FilePresentationStorage(path.join(root, 'originals'));
  const memory = new FileCapabilityCapsuleStore(path.join(root, 'memory'));
  const assets = new InMemoryPresentationArtifactStore();
  const analysis = {
    summary: '蓝色课程',
    families: [
      {
        id: 'academic',
        name: '课程',
        pages: [1],
        palette: ['#2563eb'],
        typography: '简洁',
        composition: '左图右文',
        artwork: '留白',
        preserve: ['蓝色标题'],
      },
    ],
    components: [],
    guidance: '保持留白',
    questions: [],
  };
  const visual: TemplateVisualProfile = {
    ...analysis,
    schemaVersion: 3,
    designProgram: compileTemplateDesignProgram(analysis),
    templateId: 'first',
    versionId: 'v1',
    analyzedAt: '2026-10-20',
    model: 'test',
    learning: { guidanceHistory: [], iteration: 1, questions: [], status: 'ready' },
    media: [],
    pages: [],
  };
  const baseline = await memory.learn(scope, visual);
  const alternatives = await memory.learn(scope, { ...visual, templateId: 'second' });
  const source: StoredPresentationJob = {
    job: {
      jobId: 'source',
      state: 'completed',
      versionId: 'v1',
      createdAt: '2026-10-20',
      updatedAt: '2026-10-20',
    },
    input: {
      title: 'Original',
      notebookId: 'studio',
      sourceVersionIds: ['doc-v1'],
      options: { outline: ['Facts', 'Comparison'] },
    },
    plan: {
      planId: 'original-plan',
      title: 'Original',
      aspectRatio: '16:9',
      sourceVersionIds: ['doc-v1'],
      designSpec: {
        learnedCapabilityIds: baseline.map(({ id }) => id),
        templateVisualReview: { final: { passed: true } },
      },
      slides: [
        { slideId: 'slide-1', order: 1, svg: svg('Original'), notes: 'Preserve factual notes' },
        { slideId: 'slide-2', order: 2, svg: svg('Untouched') },
      ],
    },
  };
  await storage.saveJob(scope, source);
  const writes = vi.spyOn(storage, 'saveJob');
  const backend = {
    version: 'executor-v1',
    propose: vi.fn(async (_context: TrialProposalContext) => ({
      proposal: {
        patch: { layoutStrategy: 'grouped' },
        rationale: 'Group existing paragraphs; preserve all facts',
        experienceIds: [] as string[],
      },
      usage: { tokens: 3, costMicros: 2 },
    })),
    async probe(ctx: TrialStageContext) {
      await writeFile(path.join(ctx.workspace, 'probe.txt'), ctx.configurationFingerprint);
      return { page: { svg: svg('Alternative') }, usage: { tokens: 4, costMicros: 1 } };
    },
    async render(ctx: TrialStageContext) {
      await writeFile(path.join(ctx.workspace, 'render.txt'), ctx.plan.slides[0].svg);
      return { bytes: new Uint8Array(png), usage: { tokens: 0, costMicros: 0 } };
    },
  };
  const runtime = new AtomicRuntime([
    { id: 'presentation', version: 'memory-v1', operations: capabilityMemoryOperations(memory) },
    createTrialExecutionPlugin(backend),
  ]);
  const settings: TrialSettings = {
    schemaVersion: 1,
    imageGeneration: false,
    executorVersion: backend.version,
    rendererVersion: 'test-png-v1',
    recipe: { id: 'layout-only', instructions: 'Preserve all source facts and images' },
    models: {
      planner: {
        providerId: 'owned-provider',
        model: 'planner-v1',
        configurationDigest: 'a'.repeat(64),
        maxOutputTokens: 8,
        temperature: 0,
      },
    },
    frozenInputs: { master: { palette: ['#2563eb'] }, material: 'Frozen source facts' },
    baselineCapsuleIds: baseline.map(({ id }) => id),
    probeAllowance: { tokens: 10, costMicros: 5 },
  };
  const budget: TrialBudget = {
    maxProbes: 2,
    maxRenders: 3,
    maxTokens: 100,
    maxCostMicros: 100,
    maxDurationMs: 10_000,
    maxSnapshotBytes: 1024 * 1024,
    maxArtifactBytes: 1024 * 1024,
  };
  const options = {
    runtime,
    repository: storage,
    artifacts: assets,
    root: path.join(root, 'experiments'),
    budget,
    settings: async () => settings,
  };
  const runner = new RepresentativeTrialRunner(options);
  const request: TrialRequest = {
    jobId: 'source',
    expectedVersionId: 'v1',
    slideId: 'slide-1',
    candidates: [
      {
        id: 'layout-a',
        patch: { layoutCapsuleIds: [alternatives.find(({ kind }) => kind === 'layout')!.id] },
      },
    ],
  };
  cleanups.push(async () => {
    await runner.drain();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return {
    assets,
    backend,
    baseline,
    alternatives,
    budget,
    memory,
    options,
    request,
    root,
    runner,
    runtime,
    settings,
    source,
    storage,
    writes,
  };
}

describe('Cordis representative trial execution', () => {
  it('persists complete reproducible configurations and real scratch outputs without writing the original', async () => {
    const h = await fixture();
    const result = await h.runner.run(h.request, { scope });
    expect(result).toMatchObject({
      status: 'completed',
      originalRetained: true,
      selectedId: 'baseline',
      charged: { tokens: 4, costMicros: 1 },
    });
    expect(result.calls.map(({ operation }) => operation)).toEqual([
      'presentation.memory.compose',
      'presentation.memory.compose',
      'trials.render',
      'trials.probe',
      'trials.render',
    ]);
    const read = async (name: string) =>
      JSON.parse(await readFile(path.join(result.directory!, name), 'utf8'));
    const baseline = await read('configuration-0.json');
    const candidate = await read('configuration-1.json');
    expect(baseline).toMatchObject({
      settings: h.settings,
      sourceInput: h.source.input,
      sourcePlan: h.source.plan,
      plugins: expect.arrayContaining([
        {
          id: 'trials',
          version: 'executor-v1',
          tools: ['trials.probe', 'trials.propose', 'trials.render'],
        },
      ]),
    });
    expect(trialDigest(baseline)).toBe(result.variants[0].configurationFingerprint);
    expect(trialDigest(candidate)).toBe(result.variants[1].configurationFingerprint);
    expect(candidate.capsules.filter((item: { kind: string }) => item.kind !== 'layout')).toEqual(
      baseline.capsules.filter((item: { kind: string }) => item.kind !== 'layout'),
    );
    expect(candidate.capsules).not.toEqual(baseline.capsules);
    expect(await read('report.json')).toEqual(result);
    expect((await read('plan-1.json')).designSpec.templateVisualReview).toBeUndefined();
    expect((await read('plan-1.json')).slides[0].notes).toBe('Preserve factual notes');
    expect(await readFile(result.variants[1].preview!.file)).toEqual(png);
    expect(await h.storage.getJob(scope, 'source')).toEqual(h.source);
    expect(h.writes).not.toHaveBeenCalled();
    expect(await h.memory.search(scope, '课程')).toEqual([]);
  });

  it('inherits omitted patch fields and isolates repeated and concurrent runs', async () => {
    const h = await fixture();
    h.request.candidates[0].patch = {};
    const [a, b] = await Promise.all([
      h.runner.run(h.request, { scope }),
      h.runner.run(h.request, { scope }),
    ]);
    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
    expect(a.directory).not.toBe(b.directory);
    expect(a.variants[0].configurationFingerprint).toBe(a.variants[1].configurationFingerprint);
    expect(a.conditionFingerprint).toBe(b.conditionFingerprint);
    expect(h.writes).not.toHaveBeenCalled();
  });

  it('fingerprints changed execution settings while preserving earlier configuration bytes', async () => {
    const h = await fixture();
    const first = await h.runner.run(h.request, { scope });
    const original = await readFile(path.join(first.directory!, 'configuration-0.json'), 'utf8');
    h.settings.models.planner.seed = 17;
    h.settings.rendererVersion = 'test-png-v2';
    const second = await h.runner.run(h.request, { scope });
    expect(second.conditionFingerprint).not.toBe(first.conditionFingerprint);
    expect(second.variants[0].configurationFingerprint).not.toBe(
      first.variants[0].configurationFingerprint,
    );
    expect(await readFile(path.join(first.directory!, 'configuration-0.json'), 'utf8')).toBe(
      original,
    );
  });

  it('owns preview bytes before a renderer can reuse its mutable result buffer', async () => {
    const h = await fixture();
    vi.spyOn(h.backend, 'render').mockImplementation(async () => {
      const bytes = new Uint8Array(png);
      setTimeout(() => bytes.fill(0), 0);
      return { bytes, usage: { tokens: 0, costMicros: 0 } };
    });
    const result = await h.runner.run(h.request, { scope });
    expect(result.status).toBe('completed');
    for (const variant of result.variants)
      expect(await readFile(variant.preview!.file)).toEqual(png);
  });

  it.each(['instructions', 'models', 'plugin', 'workspace'])(
    'rejects an out-of-surface %s patch before any Cordis effects',
    async (key) => {
      const h = await fixture();
      const invoke = vi.spyOn(h.runtime, 'invoke');
      const bad = structuredClone(h.request);
      Object.assign(bad.candidates[0].patch, { [key]: 'override' });
      await expect(h.runner.run(bad, { scope })).rejects.toThrow();
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it('validates all candidates before rendering, and refuses non-layout or unowned capabilities', async () => {
    const h = await fixture();
    const render = vi.spyOn(h.backend, 'render');
    h.request.candidates.push({
      id: 'bad-style',
      patch: { layoutCapsuleIds: [h.alternatives.find(({ kind }) => kind === 'style')!.id] },
    });
    const result = await h.runner.run(h.request, { scope });
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'TRIAL_LAYOUT_PATCH_REQUIRED',
    });
    expect(result).not.toHaveProperty('directory');
    expect(render).not.toHaveBeenCalled();
    h.request.candidates = [
      { id: 'foreign', patch: { layoutCapsuleIds: [`capsule-${'f'.repeat(40)}`] } },
    ];
    expect((await h.runner.run(h.request, { scope })).status).toBe('failed');
    expect(render).not.toHaveBeenCalled();
  });

  it('does not let rejected observed capabilities re-enter through a trial patch', async () => {
    const h = await fixture();
    await h.memory.recordOutcome(scope, {
      jobId: 'old',
      plan: h.source.plan!,
      capsuleIds:
        'layoutCapsuleIds' in h.request.candidates[0].patch
          ? h.request.candidates[0].patch.layoutCapsuleIds!
          : [],
      result: 'rejected',
    });
    const probe = vi.spyOn(h.backend, 'probe');
    expect((await h.runner.run(h.request, { scope })).status).toBe('failed');
    expect(probe).not.toHaveBeenCalled();
  });

  it('requires an owned completed source at the expected version', async () => {
    const h = await fixture();
    expect(await h.runner.run(h.request, { scope: { ...scope, userId: 'bob' } })).toMatchObject({
      status: 'failed',
      errorCode: 'TRIAL_SOURCE_UNAVAILABLE',
    });
    expect(
      await h.runner.run({ ...h.request, expectedVersionId: 'stale' }, { scope }),
    ).toMatchObject({ status: 'failed', errorCode: 'TRIAL_SOURCE_UNAVAILABLE' });
    expect(h.writes).not.toHaveBeenCalled();
  });

  it('copies and verifies account assets and rejects remote or unavailable images', async () => {
    const h = await fixture();
    await h.assets.put(scope, {
      artifactId: 'figure',
      name: 'figure',
      mimeType: 'image/png',
      type: 'image',
      bytes: png,
    });
    h.source.plan!.slides[0].svg += '<image href="/api/runtime/presentation/artifacts/figure"/>';
    await h.storage.saveJob(scope, h.source);
    const result = await h.runner.run(h.request, { scope });
    const snapshot = JSON.parse(
      await readFile(path.join(result.directory!, 'configuration-0.json'), 'utf8'),
    );
    expect(snapshot.sourceAssets[0]).toMatchObject({
      ref: '/api/runtime/presentation/artifacts/figure',
      base64: png.toString('base64'),
    });
    h.source.plan!.slides[0].svg = '<svg><image href="https://example.com/not-owned.png"/></svg>';
    await h.storage.saveJob(scope, h.source);
    expect(await h.runner.run(h.request, { scope })).toMatchObject({
      errorCode: 'TRIAL_ASSET_UNAVAILABLE',
    });
  });

  it.each(['maxProbes', 'maxRenders', 'maxTokens', 'maxCostMicros'] as const)(
    'enforces the %s allowance',
    async (key) => {
      const h = await fixture();
      h.budget[key] = key === 'maxRenders' ? 1 : 0;
      const probe = vi.spyOn(h.backend, 'probe');
      expect((await h.runner.run(h.request, { scope })).status).toBe('budget-exceeded');
      expect(probe).not.toHaveBeenCalled();
      expect(h.writes).not.toHaveBeenCalled();
    },
  );

  it('records actual overspend, stops further work, and never retries automatically', async () => {
    const h = await fixture();
    h.request.candidates.push({ id: 'layout-b', patch: {} });
    const probe = vi.spyOn(h.backend, 'probe').mockResolvedValue({
      page: { svg: svg('Over allowance') },
      usage: { tokens: 11, costMicros: 6 },
    });
    const result = await h.runner.run(h.request, { scope });
    expect(result).toMatchObject({
      status: 'budget-exceeded',
      charged: { tokens: 11, costMicros: 6 },
      errorCode: 'TRIAL_USAGE_EXCEEDED',
    });
    expect(result.calls.find(({ operation }) => operation === 'trials.probe')).toMatchObject({
      status: 'failed',
      actual: { tokens: 11 },
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.variants[2].status).toBe('not-started');
  });

  it('accounts for cumulative usage before admitting a second candidate', async () => {
    const h = await fixture();
    h.request.candidates.push({ id: 'layout-b', patch: {} });
    h.budget.maxTokens = 13;
    const probe = vi.spyOn(h.backend, 'probe');
    const result = await h.runner.run(h.request, { scope });
    expect(result.status).toBe('budget-exceeded');
    expect(result.charged.tokens).toBe(4);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.variants[0].status).toBe('completed');
    expect(result.variants[1].status).toBe('completed');
    expect(result.variants[2].status).toBe('not-started');
    expect(result.calls.at(-1)?.status).toBe('completed');
  });

  it('preserves a newer user edit made while the detached candidate is running', async () => {
    const h = await fixture();
    const originalProbe = h.backend.probe;
    vi.spyOn(h.backend, 'probe').mockImplementation(async (context) => {
      const newer = structuredClone(h.source);
      newer.job.versionId = 'v2-user-edit';
      newer.plan!.slides[0].svg = svg('New user edit');
      await h.storage.saveJob(scope, newer);
      return originalProbe(context);
    });
    const result = await h.runner.run(h.request, { scope });
    expect(result.status).toBe('completed');
    expect((await h.storage.getJob(scope, 'source'))?.job.versionId).toBe('v2-user-edit');
    expect((await h.storage.getJob(scope, 'source'))?.plan?.slides[0].svg).toBe(
      svg('New user edit'),
    );
    expect(h.writes).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(
      await readFile(path.join(result.directory!, 'configuration-0.json'), 'utf8'),
    );
    expect(saved.source.versionId).toBe('v1');
    expect(saved.sourcePlan.slides[0].svg).toBe(svg('Original'));
  });

  it('cancels a slow configuration provider before any output or probe is admitted', async () => {
    const h = await fixture();
    const blocked = latch();
    const entered = latch();
    h.options.settings = async () => {
      entered.resolve();
      await blocked.promise;
      return h.settings;
    };
    const controller = new AbortController();
    const running = h.runner.run(h.request, { scope, signal: controller.signal });
    await entered.promise;
    controller.abort();
    const result = await running;
    expect(result.status).toBe('cancelled');
    expect(result.calls).toEqual([]);
    expect(result).not.toHaveProperty('directory');
    blocked.resolve();
    await h.runner.drain();
    await h.runtime.replace(createTrialExecutionPlugin(h.backend));
  });

  it('refuses changed executor identities and malformed previews without certifying the baseline', async () => {
    const h = await fixture();
    h.settings.executorVersion = 'different-backend';
    expect(await h.runner.run(h.request, { scope })).toMatchObject({
      errorCode: 'TRIAL_EXECUTOR_MISMATCH',
    });
    h.settings.executorVersion = h.backend.version;
    vi.spyOn(h.backend, 'render').mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      usage: { tokens: 0, costMicros: 0 },
    });
    expect(await h.runner.run(h.request, { scope })).toMatchObject({
      status: 'failed',
      errorCode: 'TRIAL_BASELINE_FAILED',
      selectedId: 'baseline',
    });
  });

  it('charges failed calls conservatively and keeps the completed original preview', async () => {
    const h = await fixture();
    const probe = vi
      .spyOn(h.backend, 'probe')
      .mockRejectedValue(new Error('private upstream body'));
    const result = await h.runner.run(h.request, { scope });
    expect(result).toMatchObject({
      status: 'partial',
      charged: { tokens: 10, costMicros: 5 },
      variants: [{ status: 'completed' }, { status: 'failed' }],
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(trialJson(result)).not.toContain('private upstream body');
  });

  it('rejects oversized snapshots before probes and never exposes service credentials to snapshots', async () => {
    const h = await fixture();
    h.budget.maxSnapshotBytes = 10;
    const result = await h.runner.run(h.request, { scope });
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'TRIAL_SNAPSHOT_TOO_LARGE',
    });
    expect(result).not.toHaveProperty('directory');
    h.budget.maxSnapshotBytes = 1024 * 1024;
    Object.assign(h.settings.models.planner, { apiKey: 'private-key' });
    expect((await h.runner.run(h.request, { scope })).status).toBe('failed');
  });

  it('passes frozen detached plans and configurations to the trusted backend', async () => {
    const h = await fixture();
    const originalProbe = h.backend.probe;
    vi.spyOn(h.backend, 'probe').mockImplementation(async (context) => {
      expect(Object.isFrozen(context.configuration.settings.frozenInputs)).toBe(true);
      expect(() => {
        context.plan.slides[0].svg = 'corrupt';
      }).toThrow();
      expect(() => {
        Object.assign(context.scope, { userId: 'bob' });
      }).toThrow();
      expect(context.plan.planId).not.toBe(h.source.plan!.planId);
      expect(context).not.toHaveProperty('repository');
      expect(context).not.toHaveProperty('port');
      return originalProbe(context);
    });
    expect((await h.runner.run(h.request, { scope })).status).toBe('completed');
    expect(await h.storage.getJob(scope, 'source')).toEqual(h.source);
  });

  it('honors cancellation before any work', async () => {
    const h = await fixture();
    const controller = new AbortController();
    controller.abort();
    const invoke = vi.spyOn(h.runtime, 'invoke');
    expect(await h.runner.run(h.request, { scope, signal: controller.signal })).toMatchObject({
      status: 'cancelled',
      calls: [],
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'deadline'] as const)(
    'returns on %s, suppresses late results and holds leases until calls really finish',
    async (mode) => {
      const h = await fixture();
      const blocked = latch();
      const entered = latch();
      const originalProbe = h.backend.probe;
      vi.spyOn(h.backend, 'probe').mockImplementation(async (context) => {
        entered.resolve();
        await blocked.promise;
        // Simulate an external SDK that ignored cancellation.
        return originalProbe(context);
      });
      const controller = new AbortController();
      if (mode === 'deadline') h.budget.maxDurationMs = 200;
      const running = h.runner.run(h.request, { scope, signal: controller.signal });
      await entered.promise;
      if (mode === 'cancel') controller.abort();
      const result = await running;
      expect(result.status).toBe(mode === 'cancel' ? 'cancelled' : 'deadline-exceeded');
      expect(result.variants[1].status).toBe('cancelled');
      expect(result.variants[1]).not.toHaveProperty('preview');
      await expect(h.runtime.replace(createTrialExecutionPlugin(h.backend))).rejects.toMatchObject({
        code: 'PLUGIN_BUSY',
      });
      const terminalReport = await readFile(path.join(result.directory!, 'report.json'), 'utf8');
      blocked.resolve();
      await h.runner.drain();
      expect(await readFile(path.join(result.directory!, 'report.json'), 'utf8')).toBe(
        terminalReport,
      );
      await h.runtime.replace(createTrialExecutionPlugin(h.backend));
      expect(await h.storage.getJob(scope, 'source')).toEqual(h.source);
      expect(h.writes).not.toHaveBeenCalled();
    },
  );

  it('accepts no untrusted stage parameters or implicit execution context', async () => {
    const h = await fixture();
    for (const operation of ['trials.probe', 'trials.propose']) {
      await expect(
        h.runtime.invoke(operation, { workspace: '/original' }, { scope }),
      ).rejects.toThrow();
      await expect(h.runtime.invoke(operation, {}, { scope })).rejects.toMatchObject({
        code: 'TRIAL_CONTEXT_REQUIRED',
      });
    }
    const catalog = await h.runtime.catalog();
    expect(
      catalog
        .filter(({ name }) => name.startsWith('trials.'))
        .every(({ agent }) => agent === undefined),
    ).toBe(true);
  });
});

async function evaluatedFixture(
  options: { tie?: boolean; invalidLabels?: boolean; wait?: Promise<void> } = {},
) {
  const h = await fixture();
  h.settings.models.observer = { ...h.settings.models.planner };
  h.settings.evaluation = { version: 'blind-v1', allowance: { tokens: 10, costMicros: 5 } };
  h.budget.maxEvaluations = 1;
  const evaluate = vi.fn(async (ctx: AnonymousTrialContext) => {
    if (options.wait) await options.wait;
    return {
      usage: { tokens: 3, costMicros: 1 },
      cases: ctx.cases.map((page) => ({
        label: options.invalidLabels ? ('A' as const) : page.label,
        gates: Object.fromEntries(
          ['facts', 'editability', 'assets', 'render', 'visual'].map((key) => [
            key,
            { status: 'passed', evidence: 'fixture evidence' },
          ]),
        ) as AnonymousTrialScores['cases'][number]['gates'],
        quality: Object.fromEntries(
          ['readability', 'hierarchy', 'composition', 'styleConsistency'].map((key) => [
            key,
            {
              score: options.tie || page.svg.includes('Original') ? 2 : 3,
              evidence: 'fixture evidence',
            },
          ]),
        ) as AnonymousTrialScores['cases'][number]['quality'],
      })),
    };
  });
  await h.runtime.replace(createTrialExecutionPlugin({ ...h.backend, evaluate }));
  return { ...h, evaluate };
}

describe('anonymous evaluation through Cordis', () => {
  it('selects strict improvement, maps shuffled labels privately and charges evaluation', async () => {
    const h = await evaluatedFixture();
    const report = await h.runner.run(h.request, { scope });
    expect(report).toMatchObject({
      status: 'completed',
      selectedId: 'layout-a',
      selection: { reason: 'strict-improvement' },
      charged: { tokens: 7, costMicros: 2 },
    });
    expect(h.evaluate).toHaveBeenCalledOnce();
    const ctx = h.evaluate.mock.calls[0][0];
    expect(ctx.cases.map(({ label }) => label).sort()).toEqual(['A', 'B']);
    expect(ctx).not.toHaveProperty('configuration');
    expect(ctx.cases[0]).not.toHaveProperty('id');
    expect(JSON.stringify(ctx)).not.toContain(h.alternatives[0].id);
    expect(report.calls.at(-1)?.operation).toBe('trials.evaluate');
    expect(h.writes).not.toHaveBeenCalled();
  });
  it('keeps baseline when every quality dimension ties', async () => {
    const h = await evaluatedFixture({ tie: true });
    expect(await h.runner.run(h.request, { scope })).toMatchObject({
      status: 'completed',
      selectedId: 'baseline',
      selection: { reason: 'no-improvement' },
    });
  });
  it('rejects an incomplete anonymous label set', async () => {
    const h = await evaluatedFixture({ invalidLabels: true });
    expect(await h.runner.run(h.request, { scope })).toMatchObject({
      status: 'failed',
      selectedId: 'baseline',
      errorCode: 'TRIAL_EVALUATION_IDENTITY',
    });
  });
  it('refuses evaluation before any paid work if no evaluation budget is enabled', async () => {
    const h = await evaluatedFixture();
    h.budget.maxEvaluations = 0;
    const report = await h.runner.run(h.request, { scope });
    expect(report.status).toBe('failed');
    expect(report.calls).toHaveLength(0);
    expect(h.evaluate).not.toHaveBeenCalled();
  });
  it('does not call observer when its reservation cannot fit the remaining budget', async () => {
    const h = await evaluatedFixture();
    h.budget.maxTokens = 10;
    const report = await h.runner.run(h.request, { scope });
    expect(report).toMatchObject({ status: 'budget-exceeded', selectedId: 'baseline' });
    expect(h.evaluate).not.toHaveBeenCalled();
  });
  it('retains baseline and the full reservation after cancellation of an uncooperative observer', async () => {
    const wait = latch();
    const h = await evaluatedFixture({ wait: wait.promise });
    const controller = new AbortController();
    const run = h.runner.run(h.request, { scope, signal: controller.signal });
    await vi.waitFor(() => expect(h.evaluate).toHaveBeenCalledOnce());
    controller.abort();
    const report = await run;
    expect(report).toMatchObject({
      status: 'cancelled',
      selectedId: 'baseline',
      charged: { tokens: 14, costMicros: 6 },
    });
    expect(report.selection).toBeUndefined();
    wait.resolve();
    await h.runner.drain();
    expect(
      JSON.parse(await readFile(path.join(report.directory!, 'report.json'), 'utf8')).selectedId,
    ).toBe('baseline');
  });
});

describe('bounded configuration proposals in the trial ledger', () => {
  async function proposalFixture() {
    const h = await fixture();
    h.settings.proposal = {
      version: 'single-dimension-v1',
      allowance: { tokens: 10, costMicros: 5 },
    };
    h.budget.maxProposals = 1;
    h.request.candidates = [{ id: 'candidate', patch: {} }];
    return h;
  }
  it('snapshots the source before proposing and changes exactly one configuration dimension', async () => {
    const h = await proposalFixture();
    const result = await h.runner.run(h.request, { scope });
    expect(result.status).toBe('completed');
    expect(h.backend.propose).toHaveBeenCalledOnce();
    expect(result.proposal).toMatchObject({
      status: 'accepted',
      result: { patch: { layoutStrategy: 'grouped' } },
    });
    const before = JSON.parse(
      await readFile(path.join(result.directory!, 'configuration-0.json'), 'utf8'),
    );
    const after = JSON.parse(
      await readFile(path.join(result.directory!, 'configuration-1.json'), 'utf8'),
    );
    expect(before).not.toHaveProperty('policy');
    expect(after.policy).toEqual({ layoutStrategy: 'grouped' });
    delete after.policy;
    expect(after).toEqual(before);
    expect(result.calls.filter((call) => call.operation === 'trials.propose')).toMatchObject([
      {
        reserved: { tokens: 10, costMicros: 5 },
        actual: { tokens: 3, costMicros: 2 },
        status: 'completed',
      },
    ]);
    expect(h.writes).not.toHaveBeenCalled();
    expect(await h.storage.getJob(scope, 'source')).toEqual(h.source);
  });
  it.each([
    {
      patch: { layoutStrategy: 'grouped', textSpacing: 'compact' },
      rationale: 'two',
      experienceIds: [],
    },
    { patch: {}, rationale: 'empty', experienceIds: [] },
    { patch: { layoutStrategy: 'unknown' }, rationale: 'unknown', experienceIds: [] },
    {
      patch: { layoutStrategy: 'grouped' },
      model: 'override',
      rationale: 'extra',
      experienceIds: [],
    },
    { patch: { recipe: 'execute this script' }, rationale: 'free text', experienceIds: [] },
    {
      patch: { layoutStrategy: 'grouped' },
      rationale: 'made-up evidence',
      experienceIds: ['foreign'],
    },
  ])(
    'rejects invalid/overreaching proposals with no probe, render or retries: %j',
    async (proposal) => {
      const h = await proposalFixture();
      h.backend.propose.mockResolvedValue({
        proposal: proposal as never,
        usage: { tokens: 3, costMicros: 2 },
      });
      const report = await h.runner.run(h.request, { scope });
      expect(report).toMatchObject({
        status: 'failed',
        errorCode: 'TRIAL_PROPOSAL_INVALID_OUTPUT',
        selectedId: 'baseline',
        charged: { tokens: 3, costMicros: 2 },
        proposal: { status: 'rejected' },
      });
      expect(report.calls.filter((item) => item.operation.startsWith('trials.'))).toHaveLength(1);
      expect(h.backend.propose).toHaveBeenCalledOnce();
      expect(report.calls.at(-1)?.status).toBe('failed');
      expect(report.proposal?.output).toEqual(proposal);
      expect(h.writes).not.toHaveBeenCalled();
    },
  );
  it('binds valid experience references to an immutable input snapshot', async () => {
    const h = await proposalFixture();
    const experience = {
      episodeId: 'episode',
      outcome: 'baseline-kept',
      status: 'pending-validation' as const,
      applicability: 'source-page-only' as const,
      reason: 'Original grouping was clearer',
    };
    const runner = new RepresentativeTrialRunner({
      ...h.options,
      proposalExperiences: async () => [experience],
    });
    h.backend.propose.mockResolvedValue({
      proposal: {
        patch: { layoutStrategy: 'grouped' },
        rationale: 'Try grouping while retaining all facts',
        experienceIds: ['episode'],
      },
      usage: { tokens: 3, costMicros: 2 },
    });
    const report = await runner.run(h.request, { scope });
    expect(report.proposal).toMatchObject({
      status: 'accepted',
      experiences: [experience],
      result: { experienceIds: ['episode'] },
    });
    expect(Object.isFrozen(h.backend.propose.mock.calls[0][0].experiences[0])).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(report.directory!, 'proposal-input.json'), 'utf8'))
        .experiences,
    ).toEqual([experience]);
    await runner.drain();
  });
  it('stops at the deadline during an uncooperative proposal without launching a candidate', async () => {
    const h = await proposalFixture(),
      started = latch(),
      finish = latch();
    h.budget.maxDurationMs = 200;
    h.backend.propose.mockImplementation(async () => {
      started.resolve();
      await finish.promise;
      return {
        proposal: { patch: { layoutStrategy: 'grouped' }, rationale: 'test', experienceIds: [] },
        usage: { tokens: 3, costMicros: 2 },
      };
    });
    const running = h.runner.run(h.request, { scope });
    await started.promise;
    const report = await running;
    expect(report).toMatchObject({
      status: 'deadline-exceeded',
      selectedId: 'baseline',
      charged: { tokens: 10, costMicros: 5 },
    });
    expect(report.calls.filter((item) => item.operation.startsWith('trials.'))).toHaveLength(1);
    finish.resolve();
    await h.runner.drain();
  });
  it('rejects an explicit patch override before any proposer call', async () => {
    const h = await proposalFixture();
    h.request.candidates[0].patch = { textSpacing: 'compact' };
    const report = await h.runner.run(h.request, { scope });
    expect(report.errorCode).toBe('TRIAL_PROPOSAL_CONFIGURATION');
    expect(h.backend.propose).not.toHaveBeenCalled();
  });
  it('preflights the combined stage allowances before spending', async () => {
    const h = await proposalFixture();
    h.budget.maxTokens = 19;
    const report = await h.runner.run(h.request, { scope });
    expect(report.status).toBe('budget-exceeded');
    expect(report.charged.tokens).toBe(0);
    expect(h.backend.propose).not.toHaveBeenCalled();
  });
  it('stops after excessive proposer usage and retains the measured charge', async () => {
    const h = await proposalFixture();
    h.backend.propose.mockResolvedValue({
      proposal: { patch: { layoutStrategy: 'grouped' }, rationale: 'test', experienceIds: [] },
      usage: { tokens: 11, costMicros: 2 },
    });
    const report = await h.runner.run(h.request, { scope });
    expect(report).toMatchObject({
      status: 'budget-exceeded',
      selectedId: 'baseline',
      charged: { tokens: 11, costMicros: 2 },
    });
    expect(report.calls.filter((item) => item.operation.startsWith('trials.'))).toHaveLength(1);
  });
  it('cancels the proposer without launching downstream work and retains unknown usage reservation', async () => {
    const h = await proposalFixture(),
      started = latch(),
      finish = latch(),
      controller = new AbortController();
    h.backend.propose.mockImplementation(async () => {
      started.resolve();
      await finish.promise;
      return {
        proposal: { patch: { layoutStrategy: 'grouped' }, rationale: 'test', experienceIds: [] },
        usage: { tokens: 3, costMicros: 2 },
      };
    });
    const running = h.runner.run(h.request, { scope, signal: controller.signal });
    await started.promise;
    controller.abort();
    const report = await running;
    expect(report).toMatchObject({
      status: 'cancelled',
      selectedId: 'baseline',
      charged: { tokens: 10, costMicros: 5 },
    });
    expect(report.calls.at(-1)?.status).toBe('cancelled');
    expect(report.calls.filter((item) => item.operation.startsWith('trials.'))).toHaveLength(1);
    finish.resolve();
    await h.runner.drain();
  });
});
