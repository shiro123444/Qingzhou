import { ownedLearningDirectory, withAccountData } from '../learning-lifecycle/files';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import type {
  TrialExecution,
  TrialStartInput,
  TrialWorkspaceStatus,
} from '@/types/presentationTrial';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { AtomicInvocation, AtomicOperation } from '../atomic-runtime';
import { acquirePresentationExecutionLease } from './execution-lease';
import type { FilePresentationStorage, StoredPresentationJob } from './file-storage';
import { trialDigest, trialJson, type TrialRequest } from './trial-configuration';
import type { TrialLearningWriter } from './trial-learning';
import type { FileTrialEvidenceStore } from './trial-review';
import type { RepresentativeTrialRunner, TrialRunReport } from './trial-runner';
import { SERIAL_TRIAL_BUDGET } from './trial-serial';

export const WORKSPACE_TRIAL_BUDGET = Object.freeze({
  maxProbes: 1,
  maxRenders: 2,
  maxEvaluations: 1,
  maxProposals: 1,
  maxTokens: 48_000,
  maxCostMicros: 2_000_000,
  maxDurationMs: 180_000,
  maxSnapshotBytes: 8 * 1024 * 1024,
  maxArtifactBytes: 8 * 1024 * 1024,
});
const id = z.string().trim().min(1).max(200);
const pageInput = z.object({ jobId: id, slideId: id }).strict();
export const workspaceTrialStartSchema = pageInput
  .extend({
    expectedVersionId: id,
    requestId: z.string().uuid(),
    confirmed: z.literal(true),
    mode: z.literal('serial').optional(),
  })
  .strict();
const fail = (code: string) => Object.assign(new Error(code), { code });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const ongoing = (execution: TrialExecution) => ['running', 'cancelling'].includes(execution.state);
interface Record {
  execution: TrialExecution;
  inputDigest: string;
  report?: TrialRunReport;
  sourceDigest: string;
}
export interface TrialRunnerSession {
  dispose: () => Promise<void>;
  runner: Pick<RepresentativeTrialRunner, 'run' | 'drain'>;
}
/** Local persistent async jobs. Lost workers are interrupted, never automatically billed again. */
export class PresentationTrialWorkspace {
  private tasks = new Set<Promise<void>>();
  private controllers = new Map<string, AbortController>();
  constructor(
    private readonly options: {
      root: string;
      storage: FilePresentationStorage;
      evidence: FileTrialEvidenceStore;
      learning?: TrialLearningWriter;
      supportsSerial?: boolean;
      companion?: {
        assertAvailable: (
          scope: RuntimeScope,
          source: StoredPresentationJob,
          slideId: string,
        ) => Promise<void>;
        operations: () => AtomicOperation[];
        drain: () => Promise<void>;
      };
      createRunner: (
        scope: RuntimeScope,
        source: StoredPresentationJob,
        signal: AbortSignal,
        mode?: 'serial',
        executionId?: string,
      ) => Promise<TrialRunnerSession>;
    },
  ) {}
  private dir(scope: RuntimeScope) {
    if (!scope.userId?.trim() || !scope.sessionId?.trim()) throw fail('PRESENTATION_INVALID');
    return ownedLearningDirectory(
      scope.userId,
      this.options.root,
      trialDigest([scope.userId, scope.sessionId]),
    );
  }
  private view(execution?: TrialExecution): TrialWorkspaceStatus {
    return {
      budget: execution?.mode === 'serial' ? SERIAL_TRIAL_BUDGET : WORKSPACE_TRIAL_BUDGET,
      ...(this.options.supportsSerial
        ? { serialBudget: SERIAL_TRIAL_BUDGET, singleBudget: WORKSPACE_TRIAL_BUDGET }
        : {}),
      ...(execution ? { execution } : {}),
    };
  }
  private file(scope: RuntimeScope, key: string) {
    return path.join(this.dir(scope), `${key}.json`);
  }
  private async read<T>(scope: RuntimeScope, key: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.file(scope, key), 'utf8')) as T;
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
  }
  private async write(scope: RuntimeScope, key: string, value: unknown) {
    return withAccountData(this.dir(scope), async () => {
      await mkdir(this.dir(scope), { recursive: true, mode: 0o700 });
      const file = this.file(scope, key),
        temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, trialJson(value), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
  }
  private async locked<T>(scope: RuntimeScope, fn: () => Promise<T>, wait?: AbortSignal) {
    let lease = await acquirePresentationExecutionLease(path.join(this.dir(scope), 'control.lock'));
    while (!lease && wait) {
      await delay(20, undefined, { signal: wait });
      lease = await acquirePresentationExecutionLease(path.join(this.dir(scope), 'control.lock'));
    }
    if (!lease) throw fail('PRESENTATION_CONFLICT');
    try {
      return await fn();
    } finally {
      await lease.release();
    }
  }
  private async cancelled(scope: RuntimeScope, executionId: string) {
    return Boolean(await this.read(scope, `cancel-${executionId}`));
  }
  private async archiveLearning(scope: RuntimeScope, record: Record) {
    if (
      this.options.learning &&
      !record.execution.learningEpisodeId &&
      !ongoing(record.execution)
    ) {
      try {
        record.execution.learningEpisodeId = await this.options.learning.recordAttempt(
          scope,
          record.execution,
          record.report,
        );
        record.execution.learningStatus = 'recorded';
      } catch {
        record.execution.learningStatus = 'pending';
      }
      await this.write(scope, record.execution.executionId, record);
    }
    return record.execution;
  }
  private async inspect(scope: RuntimeScope, executionId: string): Promise<TrialExecution> {
    const record = await this.read<Record>(scope, executionId);
    if (!record) throw fail('PRESENTATION_NOT_FOUND');
    if (ongoing(record.execution)) {
      const lease = await acquirePresentationExecutionLease(
        path.join(this.dir(scope), 'worker.lock'),
      );
      if (lease) {
        try {
          // The worker may have committed a terminal record between our first
          // read and lock acquisition. Re-read before declaring it interrupted.
          const latest = await this.read<Record>(scope, executionId);
          if (!latest) throw fail('PRESENTATION_NOT_FOUND');
          if (!ongoing(latest.execution)) return this.archiveLearning(scope, latest);
          latest.execution.state = 'interrupted';
          latest.execution.errorCode = 'TRIAL_WORKER_INTERRUPTED';
          latest.execution.updatedAt = new Date().toISOString();
          await this.write(scope, executionId, latest);
          return this.archiveLearning(scope, latest);
        } finally {
          await lease.release();
        }
      } else if (await this.cancelled(scope, executionId))
        return { ...record.execution, state: 'cancelling' };
    }
    return this.archiveLearning(scope, record);
  }
  async status(scope: RuntimeScope, jobId: string, slideId: string): Promise<TrialWorkspaceStatus> {
    if (!(await this.options.storage.getJob(scope, jobId))) throw fail('PRESENTATION_NOT_FOUND');
    return this.locked(scope, async () => {
      const pointer = await this.read<{ executionId: string }>(
        scope,
        `page-${trialDigest([jobId, slideId])}`,
      );
      return this.view(pointer ? await this.inspect(scope, pointer.executionId) : undefined);
    });
  }
  async start(
    scope: RuntimeScope,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<TrialWorkspaceStatus> {
    const parsed = workspaceTrialStartSchema.safeParse(raw);
    if (!parsed.success) throw fail('PRESENTATION_INVALID');
    const input: TrialStartInput = parsed.data;
    if (input.mode === 'serial' && !this.options.supportsSerial) throw fail('PRESENTATION_INVALID');
    signal?.throwIfAborted();
    return this.locked(scope, async () => {
      signal?.throwIfAborted();
      const executionId = `trial-task-${trialDigest([input.jobId, input.requestId])}`;
      const previous = await this.read<Record>(scope, executionId);
      if (previous) {
        if (previous.inputDigest !== trialDigest(input)) throw fail('PRESENTATION_CONFLICT');
        return this.view(await this.inspect(scope, executionId));
      }
      const pointer = await this.read<{ executionId: string }>(scope, 'active');
      if (pointer && ongoing(await this.inspect(scope, pointer.executionId)))
        throw fail('PRESENTATION_CONFLICT');
      const worker = await acquirePresentationExecutionLease(
        path.join(this.dir(scope), 'worker.lock'),
      );
      if (!worker) throw fail('PRESENTATION_CONFLICT');
      let dispatched = false;
      try {
        const source = await this.options.storage.getJob(scope, input.jobId);
        if (
          !source?.plan ||
          source.job.state !== 'completed' ||
          source.job.versionId !== input.expectedVersionId ||
          !source.plan.slides.some((slide) => slide.slideId === input.slideId)
        )
          throw fail('PRESENTATION_CONFLICT');
        if (Buffer.byteLength(trialJson(source)) > WORKSPACE_TRIAL_BUDGET.maxSnapshotBytes)
          throw fail('PRESENTATION_OUTPUT_LIMIT');
        const frozenSource = JSON.parse(trialJson(source)) as StoredPresentationJob;
        await this.options.companion?.assertAvailable(scope, frozenSource, input.slideId);
        signal?.throwIfAborted();
        const now = new Date().toISOString();
        const record: Record = {
          inputDigest: trialDigest(input),
          sourceDigest: trialDigest({ input: source.input, plan: source.plan }),
          execution: {
            executionId,
            ...(input.mode === 'serial' ? { mode: 'serial' as const } : {}),
            requestId: input.requestId,
            source: {
              jobId: input.jobId,
              versionId: input.expectedVersionId,
              slideId: input.slideId,
            },
            state: 'running',
            phase: 'preparing',
            startedAt: now,
            updatedAt: now,
          },
        };
        await this.options.learning?.prepareAttempt(scope, record.execution, frozenSource);
        signal?.throwIfAborted();
        await this.write(scope, executionId, record);
        await this.write(scope, 'active', { executionId });
        await this.write(scope, `page-${trialDigest([input.jobId, input.slideId])}`, {
          executionId,
        });
        const controller = new AbortController();
        const lost = () => controller.abort(fail('TRIAL_LEASE_LOST'));
        worker.signal.addEventListener('abort', lost, { once: true });
        if (worker.signal.aborted) lost();
        this.controllers.set(path.join(this.dir(scope), executionId), controller);
        const task = this.execute(scope, record, frozenSource, controller).finally(async () => {
          this.controllers.delete(path.join(this.dir(scope), executionId));
          worker.signal.removeEventListener('abort', lost);
          await worker.release();
        });
        this.tasks.add(task);
        void task.then(
          () => this.tasks.delete(task),
          () => this.tasks.delete(task),
        );
        dispatched = true;
        return this.view(structuredClone(record.execution));
      } finally {
        if (!dispatched) await worker.release();
      }
    });
  }
  async cancel(scope: RuntimeScope, executionId: string): Promise<TrialWorkspaceStatus> {
    if (!/^trial-task-[a-f0-9]{64}$/u.test(executionId)) throw fail('PRESENTATION_INVALID');
    return this.locked(scope, async () => {
      const execution = await this.inspect(scope, executionId);
      if (ongoing(execution)) {
        await this.write(scope, `cancel-${executionId}`, { requested: true });
        this.controllers
          .get(path.join(this.dir(scope), executionId))
          ?.abort(fail('TRIAL_CANCELLED'));
        return this.view({ ...execution, state: 'cancelling' });
      }
      return this.view(execution);
    });
  }
  private async execute(
    scope: RuntimeScope,
    record: Record,
    source: StoredPresentationJob,
    controller: AbortController,
  ) {
    const execution = record.execution,
      { signal } = controller;
    let writes = Promise.resolve(),
      session: TrialRunnerSession | undefined;
    let preparing: Promise<TrialRunnerSession> | undefined;
    const deadline = setTimeout(
      () => controller.abort(fail('TRIAL_DEADLINE')),
      (execution.mode === 'serial' ? SERIAL_TRIAL_BUDGET : WORKSPACE_TRIAL_BUDGET).maxDurationMs,
    );
    const poll = setInterval(() => {
      void this.cancelled(scope, execution.executionId).then(
        (cancelled) => {
          if (cancelled) controller.abort(fail('TRIAL_CANCELLED'));
        },
        () => controller.abort(fail('TRIAL_CANCELLED')),
      );
    }, 200);
    const save = () => {
      execution.updatedAt = new Date().toISOString();
      const snapshot = structuredClone(record);
      writes = writes.then(() => this.write(scope, execution.executionId, snapshot));
      void writes.catch(() => controller.abort(fail('TRIAL_STORAGE_FAILED')));
    };
    try {
      preparing = this.options.createRunner(
        scope,
        source,
        signal,
        execution.mode,
        execution.executionId,
      );
      let abort!: () => void;
      try {
        session = await Promise.race([
          preparing,
          new Promise<never>((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          }),
        ]);
      } finally {
        signal.removeEventListener('abort', abort);
      }
      signal.throwIfAborted();
      const request: TrialRequest = {
        jobId: execution.source.jobId,
        expectedVersionId: execution.source.versionId,
        slideId: execution.source.slideId,
        candidates: [{ id: 'candidate', patch: {} }],
      };
      const onEvent: AtomicInvocation['onEvent'] = (event) => {
        if (event.name === 'trials.serial' && execution.mode === 'serial') {
          const ledger = z
            .object({
              round: z.union([z.literal(1), z.literal(2)]),
              tokens: z.number().int().nonnegative().safe(),
              costMicros: z.number().int().nonnegative().safe(),
            })
            .strict()
            .parse(JSON.parse(event.detail ?? '{}'));
          execution.round = ledger.round;
          execution.charged = { tokens: ledger.tokens, costMicros: ledger.costMicros };
          save();
          return;
        }
        const phase = event.name.replace('trials.', '');
        if (['propose', 'probe', 'render', 'evaluate'].includes(phase)) {
          execution.phase = phase as TrialExecution['phase'];
          save();
        }
      };
      const report = await session.runner.run(request, { scope, signal, onEvent });
      record.report = report;
      execution.charged = report.improvement?.charged ?? report.charged;
      signal.throwIfAborted();
      await writes;
      if (report.status === 'completed' && report.comparison) {
        execution.phase = 'finalizing';
        save();
        await writes;
        await this.locked(
          scope,
          async () => {
            if (await this.cancelled(scope, execution.executionId)) throw fail('TRIAL_CANCELLED');
            signal.throwIfAborted();
            const lease = await this.options.storage.acquireLease(scope, execution.source.jobId);
            if (!lease) throw fail('TRIAL_SOURCE_CHANGED');
            try {
              const current = await this.options.storage.getJob(scope, execution.source.jobId);
              if (
                current?.job.state !== 'completed' ||
                current.job.versionId !== execution.source.versionId ||
                trialDigest({ input: current.input, plan: current.plan }) !== record.sourceDigest
              )
                throw fail('TRIAL_SOURCE_CHANGED');
              signal.throwIfAborted();
              lease.signal.throwIfAborted();
              await this.options.evidence.publish(scope, report);
              execution.runId = report.runId;
              execution.state = 'completed';
              save();
              await writes;
            } finally {
              await lease.release();
            }
          },
          signal,
        );
      } else {
        execution.state = ['cancelled', 'budget-exceeded', 'deadline-exceeded'].includes(
          report.status,
        )
          ? (report.status as TrialExecution['state'])
          : 'failed';
        execution.errorCode = report.errorCode ?? 'TRIAL_EXECUTION_FAILED';
        save();
      }
    } catch (error) {
      const code = signal.aborted ? signal.reason?.code : (error as { code?: string })?.code;
      execution.state =
        code === 'TRIAL_DEADLINE'
          ? 'deadline-exceeded'
          : code === 'TRIAL_CANCELLED'
            ? 'cancelled'
            : code === 'TRIAL_LEASE_LOST'
              ? 'interrupted'
              : 'failed';
      execution.errorCode = [
        'TRIAL_SOURCE_CHANGED',
        'TRIAL_CANCELLED',
        'TRIAL_DEADLINE',
        'TRIAL_VISION_REQUIRED',
      ].includes(code)
        ? code
        : 'TRIAL_EXECUTION_FAILED';
      // A failed progress write is retried by the terminal record; it never reruns inference.
      await writes.catch(() => undefined);
      writes = Promise.resolve();
      save();
    } finally {
      clearTimeout(deadline);
      clearInterval(poll);
      await writes.catch(() => undefined);
      await this.archiveLearning(scope, record).catch(() => undefined);
      // Keep the worker lock while uncooperative calls drain, even after cancellation is visible.
      session ??= await preparing?.catch(() => undefined);
      if (session) {
        await session.runner.drain();
        await session.dispose();
        await writes.catch(() => undefined);
      }
    }
  }
  async drain() {
    await Promise.allSettled(this.tasks);
    await this.options.companion?.drain();
  }
  operations(): AtomicOperation[] {
    return [
      ...(this.options.companion?.operations() ?? []),
      {
        name: 'presentation.trial.start',
        description: 'Explicitly start one bounded page trial.',
        input: workspaceTrialStartSchema,
        execute: (input, ctx) => this.start(ctx.scope, input, ctx.signal),
      },
      {
        name: 'presentation.trial.status',
        description: 'Read owned page trial progress.',
        input: pageInput,
        execute: (input, ctx) => this.status(ctx.scope, input.jobId, input.slideId),
      },
      {
        name: 'presentation.trial.cancel',
        description: 'Persist cancellation of an owned page trial.',
        input: z.object({ executionId: id }).strict(),
        execute: (input, ctx) => this.cancel(ctx.scope, input.executionId),
      },
    ];
  }
}
