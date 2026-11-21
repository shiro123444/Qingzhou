import type { NativeAgentJob } from '@/database/schemas/agentRuntime';
import { startStepLeaseRenewal } from '@/server/modules/AgentRuntime/stepLease';
import type { AgentExecutionResult } from '@/server/services/agentRuntime/types';

import type { NativeAgentStore, NativeJobLease } from './store';

export interface NativeExecutionGuard {
  assertHeld: () => void;
  signal: AbortSignal;
}
export type NativeStepExecutor = (
  job: NativeAgentJob,
  guard: NativeExecutionGuard,
) => Promise<AgentExecutionResult>;
export interface NativeWorkerOptions {
  beforeTick?: () => Promise<void>;
  maintain?: () => Promise<void>;
  notifySettled?: (operationId: string, stepIndex: number) => Promise<void>;
}

/** A bounded supervisor around the existing executor. Recovery never replays an uncertain dispatch. */
export class NativeAgentWorker {
  private running?: Promise<number>;
  private stopped = false;
  private controller?: AbortController;
  constructor(
    private readonly store: NativeAgentStore,
    private readonly execute: NativeStepExecutor,
    private readonly options: NativeWorkerOptions = {},
  ) {}
  tick(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async run() {
    await this.options.beforeTick?.();
    await this.store.recover();
    if (this.options.notifySettled)
      for (const item of await this.store.pendingNotifications()) {
        await this.options.notifySettled(item.operationId, item.stepIndex);
        await this.store.acknowledgeNotification(item.id);
      }
    let processed = 0;
    while (!this.stopped && processed < 4) {
      const claimedAt = Date.now();
      const job = await this.store.claim();
      if (!job) break;
      await this.process(job, claimedAt);
      processed++;
    }
    if (!this.stopped) await this.options.maintain?.();
    return processed;
  }
  private async process(job: NativeAgentJob, claimedAt: number) {
    const lease: NativeJobLease = { id: job.id, owner: job.leaseOwner! };
    const controller = new AbortController();
    this.controller = controller;
    const renewal = startStepLeaseRenewal({
      lease: { operationId: job.operationId, stepIndex: job.stepIndex, ownerToken: lease.owner },
      renew: () => this.store.renewJob(lease),
      startedAt: claimedAt,
      ttlSeconds: 60,
      intervalMs: 15_000,
    });
    const signal = AbortSignal.any([controller.signal, renewal.signal]);
    const assertHeld = () => {
      signal.throwIfAborted();
      renewal.assertHeld();
    };
    let dispatched = false;
    try {
      if (this.stopped) {
        await this.store.finish(lease, 'queued');
        return;
      }
      assertHeld();
      if (!(await this.store.dispatch(lease))) return;
      dispatched = true;
      assertHeld();
      const result = await this.execute(job, { assertHeld, signal });
      assertHeld();
      if (result.locked) {
        // The executor guarantees no step ran when acquireStepLease returned contention.
        await this.store.finish(lease, 'queued', 'step_busy');
        return;
      }
      const checkpoint = await this.store.checkpoint(job.operationId);
      const committed =
        checkpoint?.state &&
        (checkpoint.state.stepCount > job.stepIndex ||
          ['done', 'error', 'interrupted'].includes(checkpoint.state.status) ||
          (result.success && checkpoint.state.status === 'waiting_for_human'));
      await this.store.finish(lease, committed ? 'done' : 'unknown');
    } catch {
      // Keep the original step's status if it committed. Otherwise quarantine its outcome.
      await this.store.finish(lease, dispatched ? 'unknown' : 'queued').catch(() => undefined);
    } finally {
      await renewal.stop();
      this.controller = undefined;
    }
  }
  start(intervalMs = 1_000) {
    const run = () => {
      void this.tick().catch(() =>
        console.error('[native-agent-worker] Tick deferred; durable work retained'),
      );
    };
    const timer = setInterval(run, intervalMs);
    timer.unref?.();
    run();
    return async () => {
      clearInterval(timer);
      await this.stop();
    };
  }
  async stop() {
    this.stopped = true;
    this.controller?.abort(new Error('NATIVE_WORKER_STOPPED'));
    await this.running;
  }
}
