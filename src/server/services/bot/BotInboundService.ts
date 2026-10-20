import { AsyncLocalStorage } from 'node:async_hooks';

import { BotInboundModel } from '@/database/models/botInbound';
import type { LobeChatDatabase } from '@/database/type';

import { callbackHash } from './callbackLedger';
import { isInboundStopCommand } from './inboundControl';
import { boundedDeliveryIO } from './postgresCallbackLedger';

export class InboundSessionBusy extends Error {
  constructor() {
    super('inbound_session_busy');
  }
}
export const inboundExecution = new AsyncLocalStorage<{
  assertHeld: () => void;
  receivedAt?: Date;
}>();

export class BotInboundService {
  readonly model: BotInboundModel;
  constructor(private readonly db: LobeChatDatabase) {
    this.model = new BotInboundModel(db);
  }

  async accept(
    userId: string,
    platform: string,
    applicationId: string,
    payload: unknown,
    eventId: string,
    threadId: string,
  ) {
    if (!eventId || eventId.length > 512 || !threadId || threadId.length > 4096)
      throw new Error('invalid_inbound_identity');
    const wire = JSON.stringify(payload);
    if (Buffer.byteLength(wire) > 1024 * 1024) throw new Error('inbound_too_large');
    const canonical = JSON.parse(
      JSON.stringify(payload, (key, value) => {
        if (key === 'context_token') return undefined;
        return value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((k) => [k, value[k]]),
            )
          : value;
      }),
    );
    return boundedDeliveryIO(() =>
      this.model.enqueue({
        id: callbackHash([userId, platform, applicationId, eventId]),
        userId,
        platform,
        applicationId,
        eventId,
        threadId,
        payload: wire,
        payloadHash: callbackHash(canonical),
        isControl: isInboundStopCommand(platform, payload),
      }),
    );
  }

  async sweep({ controlsOnly = false } = {}) {
    const recovered = await boundedDeliveryIO(() => this.model.recover());
    const sessionsReleased = await boundedDeliveryIO(() => this.model.recoverTerminalSessions());
    const report = { recovered, sessionsReleased, processed: 0, deferred: 0 };
    const started = Date.now();
    for (let i = 0; i < 8 && Date.now() - started < 20_000; i++) {
      const job = await boundedDeliveryIO(() => this.model.claim(controlsOnly));
      if (!job) break;
      let dispatched = false;
      let lost = false;
      let renewing: Promise<void> | undefined;
      let expiresAt = Math.min(Date.now() + 50_000, (job.leaseExpiresAt?.getTime() ?? 0) - 5000);
      const assertHeld = () => {
        if (lost || Date.now() >= expiresAt) throw new Error('inbound_lease_lost');
      };
      const timer = setInterval(() => {
        if (renewing || lost) return;
        const begun = Date.now();
        renewing = boundedDeliveryIO(() => this.model.renew(job))
          .then((ok) => {
            if (!ok || Date.now() >= expiresAt) lost = true;
            else expiresAt = begun + 50_000;
          })
          .catch(() => {
            lost = true;
          })
          .finally(() => {
            renewing = undefined;
          });
      }, 15_000);
      timer.unref?.();
      try {
        if (!job.payload) throw new Error('missing_inbound_payload');
        const { getBotMessageRouter } = await import('./index');
        assertHeld();
        if (!(await boundedDeliveryIO(() => this.model.beginDispatch(job))))
          throw new Error('inbound_lease_lost');
        dispatched = true;
        await inboundExecution.run({ assertHeld, receivedAt: job.createdAt }, () =>
          getBotMessageRouter().dispatchPersistedInbound(job),
        );
        assertHeld();
        if (!(await boundedDeliveryIO(() => this.model.finish(job))))
          throw new Error('inbound_lease_lost');
        report.processed++;
      } catch (error) {
        const busy = error instanceof InboundSessionBusy;
        await boundedDeliveryIO(() =>
          this.model.fail(job, dispatched && !busy, busy ? 'session_busy' : 'inbound_failed'),
        );
        report.deferred++;
      } finally {
        clearInterval(timer);
        await renewing;
      }
    }
    return report;
  }
}
