import { z } from 'zod';

import {
  BotDeliveryConflict,
  BotDeliveryModel,
  type DeliveryJobLease,
} from '@/database/models/botDelivery';
import type { LobeChatDatabase } from '@/database/type';
import { getAgentRuntimeRedisClient } from '@/server/modules/AgentRuntime/redis';

import { CallbackDeliveryError, type LedgerBackend, type LedgerState } from './callbackLedger';

/** Bound receipt/ownership I/O, never interpret a late SQL result as permission to send. */
export async function boundedDeliveryIO<T>(run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        if (Date.now() >= deadline) throw new CallbackDeliveryError('backend_unavailable');
        return run();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CallbackDeliveryError('backend_unavailable')), 5000);
      }),
    ]);
    if (Date.now() >= deadline) throw new CallbackDeliveryError('backend_unavailable');
    return result;
  } catch (error) {
    if (error instanceof CallbackDeliveryError || error instanceof BotDeliveryConflict) throw error;
    throw new CallbackDeliveryError('backend_unavailable');
  } finally {
    clearTimeout(timer);
  }
}

const ledgerStateSchema = z.object({
  completionStarted: z.boolean().optional(),
  effects: z.record(z.enum(['delivered', 'unknown_delivery'])),
  events: z.record(
    z.object({
      delivered: z.boolean().optional(),
      fingerprint: z.string(),
      plan: z.string().optional(),
      renderedPlan: z.unknown().optional(),
    }),
  ),
  highestStep: z.number().int().nonnegative().optional(),
});

// Read-only migration: refuse to snapshot an installation while an old worker owns it.
const LEGACY_SNAPSHOT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return {0, ''} end
return {1, redis.call('GET', KEYS[2]) or ''}
`;

export class PostgresCallbackLedger implements LedgerBackend {
  private readonly model: BotDeliveryModel;
  private readonly startedAt = Date.now();
  private sends = 0;

  beforeEffect(): void {
    if (!this.job) return;
    if (this.sends >= 16 || (this.sends > 0 && Date.now() - this.startedAt >= 20_000)) {
      throw new CallbackDeliveryError('budget_exhausted');
    }
    this.sends++;
  }
  constructor(
    db: LobeChatDatabase,
    private readonly userId: string,
    private readonly job?: DeliveryJobLease,
    public readonly assertHeld?: () => void,
  ) {
    this.model = new BotDeliveryModel(db);
  }

  private async readLegacy(key: string): Promise<LedgerState | null> {
    const redis = getAgentRuntimeRedisClient();
    if (!redis) throw new CallbackDeliveryError('backend_unavailable');
    const snapshot = (await boundedDeliveryIO(() =>
      redis.eval(LEGACY_SNAPSHOT, 2, `bot:callback:{${key}}:lease`, `bot:callback:{${key}}:state`),
    )) as [number, string];
    if (snapshot[0] !== 1) throw new CallbackDeliveryError('busy');
    if (!snapshot[1]) return null;
    try {
      const parsed = JSON.parse(snapshot[1]);
      if (!ledgerStateSchema.safeParse(parsed).success)
        throw new Error('Invalid legacy ledger structure');
      return parsed;
    } catch {
      throw new CallbackDeliveryError('backend_unavailable');
    }
  }

  /** Explicit owner-scoped migration for old unknown deliveries with no new inbox job. No message is sent. */
  async importLegacy(key: string): Promise<void> {
    if (await boundedDeliveryIO(() => this.model.getLedger(this.userId, key))) return;
    const state = await this.readLegacy(key);
    if (!state) throw new BotDeliveryConflict('legacy_not_found');
    await boundedDeliveryIO(() => this.model.importLedger(this.userId, key, state));
  }

  async acquire(key: string, owner: string): Promise<LedgerState | null> {
    this.assertHeld?.();
    const existing = await boundedDeliveryIO(() => this.model.getLedger(this.userId, key));
    // Fail closed rather than forgetting old unknown sends. Old workers MUST be drained first.
    const seed = existing
      ? existing.state
      : ((await this.readLegacy(key)) ?? { effects: {}, events: {} });
    const state = await boundedDeliveryIO(() =>
      this.model.acquireLedger(this.userId, key, owner, seed, this.job),
    );
    if (state && !ledgerStateSchema.safeParse(state).success)
      throw new CallbackDeliveryError('backend_unavailable');
    this.assertHeld?.();
    return state;
  }

  async save(key: string, owner: string, state: LedgerState): Promise<void> {
    this.assertHeld?.();
    if (
      !(await boundedDeliveryIO(() =>
        this.model.saveLedger(this.userId, key, owner, state, this.job),
      ))
    )
      throw new CallbackDeliveryError('lease_lost');
  }
  async renew(key: string, owner: string): Promise<void> {
    this.assertHeld?.();
    if (!(await boundedDeliveryIO(() => this.model.renewLedger(this.userId, key, owner, this.job))))
      throw new CallbackDeliveryError('lease_lost');
  }
  async release(key: string, owner: string): Promise<void> {
    await boundedDeliveryIO(() => this.model.releaseLedger(this.userId, key, owner));
  }
}
