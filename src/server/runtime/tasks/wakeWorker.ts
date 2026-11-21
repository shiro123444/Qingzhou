import type { AgentWakeJob } from '@/database/schemas/agentWake';
import { startStepLeaseRenewal } from '@/server/modules/AgentRuntime/stepLease';

import type { NativeWakeStore } from './wakeStore';
import type { NativeExecutionGuard } from './worker';

export interface WakeResult {
  receipt?: Record<string, any>;
  recurring?: { payload: Record<string, any>; delay: number };
}
export class NativeWakeWorker {
  private running?: Promise<number>;
  private stopped = false;
  private controller?: AbortController;
  constructor(
    private readonly store: NativeWakeStore,
    private readonly execute: (
      job: AgentWakeJob,
      guard: NativeExecutionGuard,
    ) => Promise<WakeResult>,
    private readonly beforeTick?: () => Promise<void>,
  ) {}
  tick() {
    if (this.stopped) return Promise.resolve(0);
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async run() {
    await this.beforeTick?.();
    await this.store.recover();
    let count = 0;
    while (!this.stopped && count < 4) {
      const startedAt = Date.now();
      const job = await this.store.claim();
      if (!job) break;
      count++;
      const lease = { id: job.id, owner: job.leaseOwner! };
      const controller = new AbortController();
      this.controller = controller;
      const renewal = startStepLeaseRenewal({
        lease: { operationId: job.id, stepIndex: 0, ownerToken: lease.owner },
        renew: () => this.store.renew(lease),
        startedAt,
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
        assertHeld();
        if (this.stopped) throw new Error('Worker stopped');
        if (!(await this.store.dispatch(lease))) continue;
        dispatched = true;
        const result = await this.execute(job, { signal, assertHeld });
        assertHeld();
        await this.store.finish(lease, result.receipt ?? {}, result.recurring);
      } catch (error) {
        const failure = error as {
          cause?: { code?: unknown };
          code?: unknown;
          errorType?: unknown;
          name?: unknown;
          stack?: unknown;
        };
        const code = failure?.cause?.code ?? failure?.code;
        // Keep diagnostic frames, without logging payloads, SQL parameters or provider responses.
        console.error('[native-wake-worker] Wake failed; durable outcome retained', {
          kind: job.kind,
          name: typeof failure?.name === 'string' ? failure.name : undefined,
          code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
          errorType: typeof failure?.errorType === 'string' ? failure.errorType : undefined,
          frames:
            typeof failure?.stack === 'string'
              ? failure.stack
                  .split('\n')
                  .filter((line) => line.trimStart().startsWith('at '))
                  .slice(0, 5)
              : undefined,
        });
        await this.store.fail(lease, dispatched).catch(() => undefined);
      } finally {
        await renewal.stop();
        this.controller = undefined;
      }
    }
    return count;
  }
  start() {
    const run = () =>
      void this.tick().catch(() =>
        console.error('[native-wake-worker] Tick deferred; durable intents retained'),
      );
    const timer = setInterval(run, 1_000);
    timer.unref?.();
    run();
    return async () => {
      clearInterval(timer);
      await this.stop();
    };
  }
  async stop() {
    this.stopped = true;
    this.controller?.abort(new Error('Wake worker stopped'));
    await this.running;
  }
}
