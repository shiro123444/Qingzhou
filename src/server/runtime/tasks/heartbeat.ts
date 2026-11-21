import { randomUUID } from 'node:crypto';

import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import { agentWorkerHeartbeats as beats } from '@/database/schemas/agentActivity';
import type { LobeChatDatabase } from '@/database/type';
import type { WorkerKind } from '@/types/backgroundActivity';

const now = sql`clock_timestamp()`;

export class WorkerHeartbeatStore {
  constructor(private readonly db: LobeChatDatabase) {}
  async ready() {
    await this.db.select({ id: beats.id }).from(beats).limit(0);
  }
  async register(kind: WorkerKind) {
    const id = randomUUID();
    await this.db.insert(beats).values({ id, kind, phase: 'idle' });
    return id;
  }
  private writable(id: string) {
    return and(eq(beats.id, id), inArray(beats.phase, ['idle', 'busy', 'degraded']));
  }
  async pulse(id: string) {
    await this.db
      .update(beats)
      .set({ heartbeatAt: now })
      .where(and(eq(beats.id, id), ne(beats.phase, 'stopped')));
  }
  async polling(id: string) {
    await this.db
      .update(beats)
      .set({
        phase: sql`case when ${beats.consecutiveFailures} > 0 then 'degraded' else 'busy' end`,
        lastPollAt: now,
        heartbeatAt: now,
      })
      .where(this.writable(id));
  }
  async success(id: string) {
    await this.db
      .update(beats)
      .set({ phase: 'idle', lastSuccessAt: now, heartbeatAt: now, consecutiveFailures: 0 })
      .where(this.writable(id));
  }
  async failure(id: string) {
    await this.db
      .update(beats)
      .set({
        phase: 'degraded',
        lastFailureAt: now,
        heartbeatAt: now,
        consecutiveFailures: sql`${beats.consecutiveFailures} + 1`,
      })
      .where(this.writable(id));
  }
  async stopping(id: string) {
    await this.db
      .update(beats)
      .set({ phase: 'stopping', heartbeatAt: now })
      .where(this.writable(id));
  }
  async stopped(id: string) {
    await this.db.update(beats).set({ phase: 'stopped', heartbeatAt: now }).where(eq(beats.id, id));
  }
}

/** A separate heartbeat survives a long tick, without implying that work completed. */
export class NativeWorkerSupervisor {
  constructor(
    private readonly store: WorkerHeartbeatStore,
    private readonly kind: WorkerKind,
    private readonly worker: { tick: () => Promise<number>; stop: () => Promise<void> },
  ) {}
  async start() {
    const id = await this.store.register(this.kind);
    let stopped = false;
    let poll: Promise<void> | undefined;
    let pulse: Promise<void> | undefined;
    const run = () => {
      if (stopped || poll) return;
      poll = (async () => {
        try {
          await this.store.polling(id);
          if (stopped) return;
          await this.worker.tick();
          await this.store.success(id);
        } catch {
          await this.store.failure(id).catch(() => undefined);
        }
      })().finally(() => {
        poll = undefined;
      });
    };
    const pulseTimer = setInterval(() => {
      if (!pulse)
        pulse = this.store
          .pulse(id)
          .catch(() => undefined)
          .finally(() => {
            pulse = undefined;
          });
    }, 5000);
    const pollTimer = setInterval(run, 1000);
    pulseTimer.unref?.();
    pollTimer.unref?.();
    run();
    return async () => {
      stopped = true;
      clearInterval(pollTimer);
      await this.store.stopping(id).catch(() => undefined);
      try {
        await this.worker.stop();
        await poll;
      } finally {
        clearInterval(pulseTimer);
        await pulse;
        await this.store.stopped(id).catch(() => undefined);
      }
    };
  }
}
