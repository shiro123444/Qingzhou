import { CordisProfileLoader } from '@lobechat/cordis-runtime';

import type { LobeChatDatabase } from '@/database/type';

import { NativeWorkerSupervisor, WorkerHeartbeatStore } from './heartbeat';
import { isNativeAgentRuntimeEnabled } from './mode';

async function boundedPing(ping: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native event stream unavailable')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Mounted explicitly by instrumentation or the standalone worker, never by a page visit. */
export function createNativeAgentWorkerHost(db: LobeChatDatabase) {
  if (!isNativeAgentRuntimeEnabled()) throw new Error('AGENT_RUNTIME_MODE=native is required');
  return new CordisProfileLoader({
    bundles: {
      native: {
        entries: [
          { id: 'native-agent-worker', use: 'worker' },
          { id: 'native-wake-worker', use: 'wake' },
        ],
      },
    },
    modules: {
      worker: {
        manifest: { id: 'native-agent-worker', version: '1.2.0', requires: ['native-wake-worker'] },
        load: async () => {
          const { NativeAgentStore } = await import('./store');
          const { NativeAgentWorker } = await import('./worker');
          const { getAgentRuntimeRedisClient } =
            await import('@/server/modules/AgentRuntime/redis');
          const redis = getAgentRuntimeRedisClient();
          if (!redis) throw new Error('Redis is required for native agent event streams');
          await boundedPing(() => redis.ping());
          const store = new NativeAgentStore(db);
          const heartbeat = new WorkerHeartbeatStore(db);
          await heartbeat.ready();
          await store.stats('__readiness__'); // Fail before dispatch if migration 0114 is absent.
          const { NativeWakeStore } = await import('./wakeStore');
          await new NativeWakeStore(db).ready();
          const { AgentRuntimeService } = await import('@/server/services/agentRuntime');
          // Initialize the shared executor before handlers that also import it through TaskRunner.
          // Concurrent CJS/ESM entry points can otherwise wait on the same module cycle.
          await (await import('./wakeExecution')).preloadNativeWakeHandlers();
          return {
            apply(ctx) {
              const worker = new NativeAgentWorker(
                store,
                async (job, guard) => {
                  guard.assertHeld();
                  return new AgentRuntimeService(db, job.userId).executeStep({
                    ...job.message.payload,
                    context: job.message.context,
                    operationId: job.operationId,
                    stepIndex: job.stepIndex,
                    signal: guard.signal,
                    assertExecutionLease: guard.assertHeld,
                  });
                },
                {
                  beforeTick: () => boundedPing(() => redis.ping()),
                  notifySettled: async (operationId, stepIndex) => {
                    const { createStreamEventManager } =
                      await import('@/server/modules/AgentRuntime/factory');
                    const checkpoint = await store.checkpoint(operationId);
                    if (
                      checkpoint?.state &&
                      ['done', 'error', 'interrupted', 'waiting_for_human'].includes(
                        checkpoint.state.status,
                      ) &&
                      checkpoint.state.stepCount <= stepIndex + 1
                    )
                      await createStreamEventManager().publishAgentRuntimeEnd(
                        operationId,
                        checkpoint.state.stepCount,
                        checkpoint.state,
                        checkpoint.state.status,
                        checkpoint.state.interruption?.reason,
                      );
                  },
                  maintain: async () => {
                    const [{ BotDeliveryService }, { BotInboundService }] = await Promise.all([
                      import('@/server/services/bot/BotDeliveryService'),
                      import('@/server/services/bot/BotInboundService'),
                    ]);
                    await new BotDeliveryService(db).sweep();
                    await new BotInboundService(db).sweep();
                  },
                },
              );
              ctx.provide('qingzhou.tasks.worker', worker);
              ctx.effect(() => new NativeWorkerSupervisor(heartbeat, 'agent', worker).start());
            },
          };
        },
      },
      wake: {
        manifest: { id: 'native-wake-worker', version: '1.1.0' },
        load: async () => {
          const { NativeWakeStore } = await import('./wakeStore');
          const { NativeWakeWorker } = await import('./wakeWorker');
          const { createNativeWakeExecutor } = await import('./wakeExecution');
          const { getAgentRuntimeRedisClient } =
            await import('@/server/modules/AgentRuntime/redis');
          const redis = getAgentRuntimeRedisClient();
          if (!redis) throw new Error('Redis is required for native wake execution');
          await boundedPing(() => redis.ping());
          const store = new NativeWakeStore(db);
          const heartbeat = new WorkerHeartbeatStore(db);
          await heartbeat.ready();
          await store.ready();
          await store.seedScanners();
          return {
            apply(ctx) {
              const worker = new NativeWakeWorker(store, createNativeWakeExecutor(db), () =>
                boundedPing(() => redis.ping()),
              );
              ctx.provide('qingzhou.tasks.wake', worker);
              ctx.effect(() => new NativeWorkerSupervisor(heartbeat, 'wake', worker).start());
            },
          };
        },
      },
    },
    profile: { bundles: ['native'] },
  });
}

const registry = globalThis as typeof globalThis & {
  __qingzhouNativeAgentWorker?: CordisProfileLoader;
};
export function ensureNativeAgentWorkerHost(db: LobeChatDatabase) {
  if (process.env.VERCEL_ENV) throw new Error('Run the native agent worker on a persistent host');
  if (registry.__qingzhouNativeAgentWorker) return registry.__qingzhouNativeAgentWorker;
  const host = createNativeAgentWorkerHost(db);
  registry.__qingzhouNativeAgentWorker = host;
  void host
    .run(async () => undefined)
    .catch(async () => {
      if (registry.__qingzhouNativeAgentWorker === host)
        delete registry.__qingzhouNativeAgentWorker;
      await host.dispose().catch(() => undefined);
    });
  return host;
}
