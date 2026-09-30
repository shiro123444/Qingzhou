import {
  BotDeliveryConflict,
  type BotDeliveryJob,
  BotDeliveryModel,
  type DeliveryJobLease,
} from '@/database/models/botDelivery';
import type { LobeChatDatabase } from '@/database/type';
import {
  BOT_CALLBACK_INTENT_PREFIX,
  BOT_CALLBACK_INTENT_READY_SET,
} from '@/server/modules/AgentRuntime/callbackIntent';
import { getAgentRuntimeRedisClient } from '@/server/modules/AgentRuntime/redis';

import { type BotCallbackBody, BotCallbackService } from './BotCallbackService';
import { CallbackDeliveryError } from './callbackLedger';
import { deliveryEnvelope } from './deliveryEnvelope';
import { boundedDeliveryIO, PostgresCallbackLedger } from './postgresCallbackLedger';

const ACK_INTENT = `
local current = redis.call('GET', KEYS[1])
if not current then return redis.call('SREM', KEYS[2], KEYS[1]) end
if current ~= ARGV[1] then return 0 end
if ARGV[2] ~= '' then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
redis.call('DEL', KEYS[1])
return redis.call('SREM', KEYS[2], KEYS[1])
`;
const SCAN_CURSOR = 'bot:delivery:scan-cursor:v1';
const SCAN_ROTATION = 'bot:delivery:scan-rotation:v1';

/** Durable internal callback pipeline. No timer/worker is started at module import. */
export class BotDeliveryService {
  readonly model: BotDeliveryModel;
  constructor(private readonly db: LobeChatDatabase) {
    this.model = new BotDeliveryModel(db);
  }

  async accept(payload: unknown) {
    const envelope = deliveryEnvelope(payload);
    if (envelope.payload.type === 'completion' && envelope.payload.reason === 'waiting_for_human')
      return { status: 'skipped' as const };
    return boundedDeliveryIO(() => this.model.enqueue('inbox', envelope));
  }

  /** Redis staging is acknowledged ONLY after all SQL outbox inserts have committed. */
  private async drainStaging(deadline: number) {
    const redis = getAgentRuntimeRedisClient();
    const report = { discardedDeletedUsers: 0, staged: 0, stagingErrors: 0 };
    if (!redis) return { ...report, stagingErrors: 1 };
    let cursor = (await boundedDeliveryIO(() => redis.get(SCAN_CURSOR))) ?? '0';
    if (!/^\d+$/.test(cursor)) cursor = '0';
    // Bound scanning as well as processing: Redis SCAN COUNT is a hint, not a hard limit.
    for (let page = 0; page < 8 && Date.now() < deadline; page++) {
      const [next, keys] = await boundedDeliveryIO(() =>
        redis.sscan(BOT_CALLBACK_INTENT_READY_SET, cursor, 'COUNT', 40),
      );
      const rotation = keys.length ? await boundedDeliveryIO(() => redis.incr(SCAN_ROTATION)) : 0;
      const offset = keys.length ? rotation % keys.length : 0;
      const orderedKeys = [...keys.slice(offset), ...keys.slice(0, offset)];
      for (const key of orderedKeys.slice(0, 40)) {
        if (Date.now() >= deadline) break;
        try {
          if (!key.startsWith(`${BOT_CALLBACK_INTENT_PREFIX}:`)) {
            // An invalid index member must never authorize reading/deleting another Redis namespace.
            await boundedDeliveryIO(() => redis.srem(BOT_CALLBACK_INTENT_READY_SET, key));
            report.stagingErrors++;
            continue;
          }
          const raw = await boundedDeliveryIO(() => redis.get(key));
          if (raw === null) {
            await boundedDeliveryIO(() =>
              redis.eval(ACK_INTENT, 2, key, BOT_CALLBACK_INTENT_READY_SET, '', ''),
            );
            continue;
          }
          const intents: unknown = JSON.parse(raw);
          if (!Array.isArray(intents) || intents.length > 128)
            throw new Error('invalid_staging_record');
          const failed: unknown[] = [];
          const deferred: unknown[] = [];
          for (const intent of intents) {
            if (Date.now() >= deadline) {
              deferred.push(intent);
              continue;
            }
            try {
              const envelope = deliveryEnvelope(intent);
              if (!(await boundedDeliveryIO(() => this.model.userExists(envelope.userId)))) {
                // Account deletion revokes pending sends; do not retain its plaintext in Redis forever.
                report.discardedDeletedUsers++;
                continue;
              }
              await boundedDeliveryIO(() => this.model.enqueue('outbox', envelope));
              report.staged++;
            } catch {
              failed.push(intent);
              report.stagingErrors++;
              console.error('Bot callback intent retained for recovery', { intentKey: key });
            }
          }
          const remaining = [...deferred, ...failed];
          // A bad progress intent cannot block its independent final reply, and partial
          // batches do not replay the same first N inserts forever under a time budget.
          await boundedDeliveryIO(() =>
            redis.eval(
              ACK_INTENT,
              2,
              key,
              BOT_CALLBACK_INTENT_READY_SET,
              raw,
              remaining.length ? JSON.stringify(remaining) : '',
            ),
          );
        } catch {
          report.stagingErrors++;
          // No payloads/credentials. Leave malformed/conflicting records for inspection, not silent loss.
          console.error('Bot callback staging transfer failed', { intentKey: key });
        }
      }
      cursor = next;
      await boundedDeliveryIO(() => redis.set(SCAN_CURSOR, cursor));
      if (cursor === '0') break;
    }
    return report;
  }

  private async processInbox(job: BotDeliveryJob): Promise<'delivered' | 'deferred'> {
    const lease: DeliveryJobLease = { id: job.id, owner: job.leaseOwner! };
    // Deadline begins no later than the SQL claim's update; subtract a safety margin.
    let expiresAt = Math.min(Date.now() + 50_000, (job.leaseExpiresAt?.getTime() ?? 0) - 5000);
    let stopped = false;
    let lost = false;
    let renewing: Promise<void> | undefined;
    const assertHeld = () => {
      if (lost || Date.now() >= expiresAt) throw new CallbackDeliveryError('lease_lost');
    };
    const renew = () => {
      if (stopped || renewing) return;
      if (Date.now() >= expiresAt) {
        lost = true;
        return;
      }
      const started = Date.now();
      renewing = boundedDeliveryIO(() => this.model.renewJob(lease))
        .then((held) => {
          if (!held || Date.now() >= expiresAt) {
            lost = true;
            return;
          }
          if (!lost) expiresAt = started + 50_000;
        })
        .catch(() => {
          lost = true;
        })
        .finally(() => {
          renewing = undefined;
        });
    };
    const timer = setInterval(renew, 15_000);
    timer.unref?.();
    try {
      if (!job.payload) throw new BotDeliveryConflict('missing_payload');
      const envelope = deliveryEnvelope(JSON.parse(job.payload));
      if (
        envelope.userId !== job.userId ||
        envelope.operationId !== job.operationId ||
        envelope.scopeKey !== job.scopeKey ||
        envelope.eventKey !== job.eventKey ||
        envelope.intentHash !== job.intentHash
      ) {
        throw new BotDeliveryConflict('payload_conflict');
      }
      assertHeld();
      const ledger = new PostgresCallbackLedger(this.db, job.userId, lease, assertHeld);
      const service = new BotCallbackService(this.db, ledger);
      await service.handleCallback(envelope.payload as unknown as BotCallbackBody);
      assertHeld();
      return (await boundedDeliveryIO(() => this.model.delivered(job))) ? 'delivered' : 'deferred';
    } catch (error) {
      const code =
        error instanceof CallbackDeliveryError
          ? error.status
          : error instanceof BotDeliveryConflict
            ? error.code
            : 'callback_failed';
      const uncertain = code === 'unknown_delivery' || code === 'payload_conflict';
      await boundedDeliveryIO(() => this.model.failed(job, code, uncertain));
      if (code !== 'budget_exhausted')
        console.error('Durable bot callback deferred', {
          code,
          jobId: job.id,
          operationId: job.operationId,
        });
      return 'deferred';
    } finally {
      stopped = true;
      clearInterval(timer);
      await renewing;
    }
  }

  /** Invoke via authenticated cron. Claims one job at a time, never a batch whose leases can expire in line. */
  async sweep() {
    const started = Date.now();
    const recovered = await boundedDeliveryIO(() => this.model.recoverExpiredJobs());
    const report = {
      delivered: 0,
      deferred: 0,
      discardedDeletedUsers: 0,
      recovered,
      staged: 0,
      stagingErrors: 0,
      transferred: 0,
    };
    try {
      Object.assign(report, await this.drainStaging(started + 8_000));
    } catch {
      report.stagingErrors++;
    }
    // Still attempt SQL work if staging is down. First-use legacy import may itself need Redis.
    for (let i = 0; i < 16 && Date.now() - started < 15_000; i++) {
      const job = await boundedDeliveryIO(() => this.model.claim('outbox'));
      if (!job) break;
      try {
        if (await boundedDeliveryIO(() => this.model.transfer(job))) report.transferred++;
      } catch (error) {
        const code = error instanceof BotDeliveryConflict ? error.code : 'transfer_failed';
        await boundedDeliveryIO(() => this.model.failed(job, code, code === 'payload_conflict'));
        report.deferred++;
      }
    }
    for (let i = 0; i < 8 && Date.now() - started < 25_000; i++) {
      const job = await boundedDeliveryIO(() => this.model.claim('inbox'));
      if (!job) break;
      const outcome = await this.processInbox(job);
      report[outcome]++;
    }
    return report;
  }
}
