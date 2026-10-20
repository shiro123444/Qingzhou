/**
 * Real Cordis core microbenchmark. Build before measuring so no TS loader stays resident:
 * bun build scripts/performance/benchmark-runtime.mts --target=node --format=esm --outfile=/tmp/qingzhou-runtime-benchmark.mjs
 * /usr/bin/time -v node --expose-gc /tmp/qingzhou-runtime-benchmark.mjs --build-bun-version <bun-version> --source-revision <git-head>
 * JSON is emitted only after result, retention, replacement and cleanup assertions pass.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { availableParallelism, cpus, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type { AtomicInvocation, AtomicRuntime } from '../../src/server/runtime/atomic-runtime';
import type { CompiledLesson } from '../../src/server/runtime/teaching/lesson';
import type { LessonPlan } from '../../src/types/presentationLesson';

const { values } = parseArgs({
  options: {
    'build-bun-version': { type: 'string' },
    'composition-iterations': { type: 'string', default: '250' },
    'iterations': { type: 'string', default: '1500' },
    'replacements': { type: 'string', default: '75' },
    'source-revision': { type: 'string' },
    'working-tree': { type: 'string' },
  },
});
const bounded = (value: string | undefined, minimum: number, maximum: number) => {
  const count = Number(value);
  assert(Number.isSafeInteger(count) && count >= minimum && count <= maximum);
  return count;
};
const iterations = bounded(values.iterations, 1000, 3500);
const compositionIterations = bounded(values['composition-iterations'], 100, 400);
const replacements = bounded(values.replacements, 50, 100);
const warmupDirect = 100;
const warmupCompositions = 20;
const scopeCount = 384;
const unloadCycles = 25;
const expectedSuccessfulInvocations =
  2 *
    (iterations + 3 * compositionIterations + warmupDirect + 3 * warmupCompositions + scopeCount) +
  replacements +
  2 * unloadCycles;
assert(expectedSuccessfulInvocations + unloadCycles + 3 <= 10_000, 'Invocation budget exceeded');

const startedAt = new Date().toISOString();
const processStart = performance.now();
const gc = (globalThis as { gc?: () => void }).gc;
const memory = () => {
  gc?.();
  return process.memoryUsage();
};
const round = (value: number) => Number(value.toFixed(6));
const latency = (samples: number[]) => {
  const ordered = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) => ordered[Math.ceil(ordered.length * fraction) - 1];
  return {
    count: samples.length,
    totalMs: round(samples.reduce((sum, value) => sum + value, 0)),
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    p99Ms: round(percentile(0.99)),
    maximumMs: round(ordered.at(-1)!),
  };
};
async function measure<T>(
  count: number,
  execute: (index: number) => Promise<T>,
  verify: (value: T) => void,
) {
  const samples: number[] = [];
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let index = 0; index < count; index++) {
    const callStart = performance.now();
    const result = await execute(index);
    samples.push(performance.now() - callStart);
    verify(result);
  }
  const elapsed = performance.now() - start;
  const used = process.cpuUsage(cpu);
  return {
    callLatency: latency(samples),
    wallIncludingAssertionsMs: round(elapsed),
    cpuIncludingAssertionsMs: { user: used.user / 1000, system: used.system / 1000 },
  };
}

// No server, browser, database, storage adapter or model is constructed by these imports.
const memoryBeforeImports = memory();
const importStart = performance.now();
const { AtomicRuntime: Runtime } = await import('../../src/server/runtime/atomic-runtime');
const coreImported = performance.now();
const { createSkillsPlugin } = await import('../../src/server/runtime/skills-plugin');
const skillsImported = performance.now();
const { createTeachingPlugin } = await import('../../src/server/runtime/teaching/atomic-plugin');
const teachingImported = performance.now();
const memoryAfterImports = memory();

const plan: LessonPlan = {
  schemaVersion: 1,
  brief: {
    intention: '先预测再解释',
    audience: '学习导数的学生',
    priorKnowledge: '导数',
    learningGoal: '解释下降方向',
    durationMinutes: 10,
  },
  beats: [
    {
      id: 'prediction',
      title: '预测方向',
      objective: '迁移导数知识',
      teacherCue: '教师私有提示',
      studentAction: '画出预测',
      checkForUnderstanding: '说明方向依据',
      durationMinutes: 4,
      locked: true,
      frames: [
        {
          id: 'question',
          title: '往哪里走？',
          kind: 'question',
          visibleContent: [],
          visualCue: '等高线和起点',
          withheldContent: ['负梯度方向'],
          boardSpace: 'none',
        },
      ],
    },
  ],
};
const fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const verifyCompiled = (value: CompiledLesson) => {
  assert.equal(value.fingerprint, fingerprint);
  assert.equal(value.stages.length, 1);
  assert.equal(value.stages[0].frameId, 'question');
  assert.equal(value.stages[0].advance, 'teacher');
  assert.equal(value.stages[0].title, '往哪里走？');
  assert(!Object.hasOwn(value.stages[0], 'withheldContent'));
  assert(!Object.hasOwn(value.stages[0], 'teacherCue'));
};
const steps = [
  { id: 'checked', operation: 'teaching.lesson.revise', input: { previous: plan, next: plan } },
  { id: 'compiled', operation: 'teaching.lesson.compile', input: { plan: { $ref: 'checked' } } },
];
const scope = { userId: 'benchmark-teacher', sessionId: 'benchmark-session' };
const counters = { started: 0, completed: 0, failed: 0, expectedUnavailableRejections: 0 };
const invocation: AtomicInvocation = {
  scope,
  onEvent: (event) => {
    counters[event.state]++;
  },
};
async function expectUnavailable(execute: () => Promise<unknown>) {
  await assert.rejects(execute, { code: 'PROVIDER_UNAVAILABLE' });
  counters.expectedUnavailableRejections++;
}
async function assemble(maxEventScopes: number) {
  const before = performance.now();
  const runtime: AtomicRuntime = new Runtime(
    [createTeachingPlugin(), createSkillsPlugin(() => runtime)],
    {
      maxEventScopes,
      maxEventsPerScope: 200,
    },
  );
  const catalog = await runtime.catalog();
  const assemblyMs = performance.now() - before;
  assert.equal(catalog.length, 5);
  assert.deepEqual(
    (await runtime.snapshot(scope)).plugins.map(({ id }) => id),
    ['teaching', 'skills'],
  );
  return { runtime, assemblyMs: round(assemblyMs), pluginCount: 2, operationCount: catalog.length };
}
async function disposeAndVerify(runtime: AtomicRuntime) {
  const start = performance.now();
  await runtime.dispose();
  const elapsed = performance.now() - start;
  await runtime.dispose();
  assert.deepEqual((await runtime.snapshot(scope)).plugins, []);
  assert.deepEqual(await runtime.catalog(), []);
  await expectUnavailable(() => runtime.invoke('teaching.lesson.compile', { plan }, invocation));
  return round(elapsed);
}

async function runHistoryMode(maxEventScopes: number) {
  const memoryBeforeAssembly = memory();
  const mounted = await assemble(maxEventScopes);
  const { runtime } = mounted;
  const memoryAfterAssembly = memory();
  let disposed = false;
  try {
    for (let index = 0; index < warmupDirect; index++)
      verifyCompiled(
        await runtime.invoke<CompiledLesson>('teaching.lesson.compile', { plan }, invocation),
      );
    for (let index = 0; index < warmupCompositions; index++) {
      const result = await runtime.invoke<{ last: CompiledLesson }>(
        'skills.run',
        { steps },
        invocation,
      );
      verifyCompiled(result.last);
    }
    const memoryAfterWarmup = memory();
    const direct = await measure(
      iterations,
      () => runtime.invoke<CompiledLesson>('teaching.lesson.compile', { plan }, invocation),
      verifyCompiled,
    );
    const composition = await measure(
      compositionIterations,
      () => runtime.invoke<{ last: CompiledLesson }>('skills.run', { steps }, invocation),
      (result) => verifyCompiled(result.last),
    );
    const sameScopeEvents = (await runtime.snapshot(scope)).operations.length;
    assert.equal(sameScopeEvents, maxEventScopes ? 200 : 0);
    const churn = await measure(
      scopeCount,
      (index) =>
        runtime.invoke<CompiledLesson>(
          'teaching.lesson.compile',
          { plan },
          {
            ...invocation,
            scope: { ...scope, sessionId: `scope-${index}` },
          },
        ),
      verifyCompiled,
    );
    let retainedScopes = 0;
    let retainedEvents = 0;
    for (let index = 0; index < scopeCount; index++) {
      const events = (await runtime.snapshot({ ...scope, sessionId: `scope-${index}` })).operations;
      retainedScopes += Number(events.length > 0);
      retainedEvents += events.length;
    }
    assert.equal(retainedScopes, maxEventScopes);
    assert.equal(retainedEvents, maxEventScopes * 2);
    assert.equal((await runtime.snapshot(scope)).operations.length, 0);
    const memoryAfterWork = memory();
    const disposeMs = await disposeAndVerify(runtime);
    disposed = true;
    return {
      mode: maxEventScopes ? 'bounded-history' : 'history-disabled',
      options: { maxEventScopes, maxEventsPerScope: 200 },
      assemblyMs: mounted.assemblyMs,
      pluginCount: mounted.pluginCount,
      operationCount: mounted.operationCount,
      direct,
      composition: { ...composition, operationsPerIteration: 3 },
      scopeChurn: { ...churn, distinctScopes: scopeCount, retainedScopes, retainedEvents },
      sameScopeEventsBeforeChurn: sameScopeEvents,
      memoryBytes: {
        beforeAssembly: memoryBeforeAssembly,
        afterAssembly: memoryAfterAssembly,
        afterWarmup: memoryAfterWarmup,
        afterWork: memoryAfterWork,
        afterDispose: memory(),
      },
      disposeMs,
    };
  } finally {
    if (!disposed) await runtime.dispose();
  }
}

async function runLifecycle() {
  const { runtime, assemblyMs } = await assemble(0);
  const before = memory();
  const replacementSamples: number[] = [];
  const removalSamples: number[] = [];
  const remountSamples: number[] = [];
  try {
    for (let index = 0; index < replacements; index++) {
      const version = `1.1.${index}`;
      const candidate = { ...createTeachingPlugin(), version };
      const start = performance.now();
      await runtime.replace(candidate);
      replacementSamples.push(performance.now() - start);
      let observedVersion: string | undefined;
      verifyCompiled(
        await runtime.invoke<CompiledLesson>(
          'teaching.lesson.compile',
          { plan },
          {
            ...invocation,
            onEvent: (event) => {
              invocation.onEvent!(event);
              observedVersion = event.pluginVersion;
            },
          },
        ),
      );
      assert.equal(observedVersion, version);
      assert.equal((await runtime.catalog()).length, 5);
    }
    const releaseLease = await runtime.acquire('teaching');
    try {
      await assert.rejects(() => runtime.replace(createTeachingPlugin()), { code: 'PLUGIN_BUSY' });
      await assert.rejects(() => runtime.remove('teaching'), { code: 'PLUGIN_BUSY' });
    } finally {
      releaseLease();
    }
    for (let index = 0; index < unloadCycles; index++) {
      const removeStart = performance.now();
      await runtime.remove('teaching');
      removalSamples.push(performance.now() - removeStart);
      await expectUnavailable(() =>
        runtime.invoke('teaching.lesson.compile', { plan }, invocation),
      );
      const catalog = await runtime.invoke<{ tools: unknown[] }>('skills.catalog', {}, invocation);
      assert.deepEqual(catalog.tools, []);
      const candidate = createTeachingPlugin();
      const addStart = performance.now();
      await runtime.add(candidate);
      remountSamples.push(performance.now() - addStart);
      verifyCompiled(
        await runtime.invoke<CompiledLesson>('teaching.lesson.compile', { plan }, invocation),
      );
    }
    const after = memory();
    const disposeMs = await disposeAndVerify(runtime);
    return {
      assemblyMs,
      replacements: latency(replacementSamples),
      unloads: latency(removalSamples),
      remounts: latency(remountSamples),
      memoryBytes: { before, after, afterDispose: memory() },
      disposeMs,
      checks: {
        leaseBlocksReplacementAndRemoval: true,
        removedToolsDisappearFromSkills: true,
        replacementVersionObservedOnInvocation: true,
        disposalIdempotent: true,
      },
    };
  } finally {
    await runtime.dispose();
  }
}

const historyModes = [await runHistoryMode(256), await runHistoryMode(0)];
const lifecycle = await runLifecycle();
assert.equal(counters.started, expectedSuccessfulInvocations);
assert.equal(counters.completed, expectedSuccessfulInvocations);
assert.equal(counters.failed, 0);
assert.equal(counters.expectedUnavailableRejections, unloadCycles + 3);
const bundlePath = fileURLToPath(import.meta.url);
const bundle = await readFile(bundlePath);
const usage = process.resourceUsage();
const report = {
  schemaVersion: 1,
  kind: 'qingzhou-cordis-core-microbenchmark',
  startedAt,
  completedAt: new Date().toISOString(),
  limits: [
    'Core and composition mechanisms only; not the full Qingzhou/docs/blog/PPT service.',
    'No model, database, HTTP server, renderer, browser or network workload; not a 4 GB capacity proof.',
    'One process and serial operations on a shared developer host; no CPU or memory cgroup limit.',
    'Cold import times measure first module evaluation in a prebuilt bundle, not a cleared OS page cache.',
    'History-on runs before history-off after equal warmups; differences may include JIT and host noise.',
    'Memory snapshots across modes are not isolated; retained scope/event counts validate cache behavior, not RSS subtraction.',
    'RSS includes V8, the bundled libraries and this assertion harness. Per-call timings exclude output assertions.',
  ],
  runtime: {
    node: process.version,
    v8: process.versions.v8,
    buildBun: values['build-bun-version'] ?? null,
    platform: process.platform,
    architecture: process.arch,
    kernel: release(),
    cpuModel: cpus()[0]?.model,
    availableParallelism: availableParallelism(),
    logicalCpus: cpus().length,
    hostMemoryBytes: totalmem(),
    explicitGc: Boolean(gc),
    executable: process.execPath,
  },
  source: {
    revision: values['source-revision'] ?? null,
    workingTree: values['working-tree'] ?? 'not-recorded',
    entry: 'scripts/performance/benchmark-runtime.mts',
    bundlePath,
    bundleBytes: bundle.length,
    bundleSha256: createHash('sha256').update(bundle).digest('hex'),
  },
  method: {
    directOperation: 'teaching.lesson.compile',
    plugins: ['teaching', 'skills'],
    compositionSteps: steps.map(({ operation }) => operation),
    iterations,
    compositionIterations,
    warmupDirectPerMode: warmupDirect,
    warmupCompositionsPerMode: warmupCompositions,
    scopeCountPerMode: scopeCount,
    replacements,
    unloadCycles,
    retainedScopeLimit: 256,
    eventsPerScopeLimit: 200,
    modelConfigured: false,
    storageConfigured: false,
  },
  coldImportMs: {
    core: round(coreImported - importStart),
    skills: round(skillsImported - coreImported),
    teaching: round(teachingImported - skillsImported),
    total: round(teachingImported - importStart),
  },
  memoryBeforeImportsBytes: memoryBeforeImports,
  memoryAfterImportsBytes: memoryAfterImports,
  historyModes,
  lifecycle,
  verification: { ...counters, allAssertionsPassed: true },
  measuredHarnessWallMs: round(performance.now() - processStart),
  processResourceUsage: {
    maxRssKiB: usage.maxRSS,
    userCpuMs: usage.userCPUTime / 1000,
    systemCpuMs: usage.systemCPUTime / 1000,
    voluntaryContextSwitches: usage.voluntaryContextSwitches,
    involuntaryContextSwitches: usage.involuntaryContextSwitches,
  },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
