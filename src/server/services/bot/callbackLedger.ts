import { createHash, randomUUID } from 'node:crypto';

import debug from 'debug';

import { getAgentRuntimeRedisClient } from '@/server/modules/AgentRuntime/redis';
import { isQueueAgentRuntimeEnabled } from '@/server/services/queue/impls';

const log = debug('lobe-server:bot:callback-ledger');

export type CallbackStatus =
  | 'budget_exhausted'
  | 'backend_unavailable'
  | 'busy'
  | 'invalid_callback'
  | 'lease_lost'
  | 'payload_conflict'
  | 'unknown_delivery';

export class CallbackDeliveryError extends Error {
  constructor(
    public readonly status: CallbackStatus,
    options?: ErrorOptions,
  ) {
    super(`Bot callback: ${status}`, options);
  }
}

export interface CallbackScope {
  applicationId: string;
  messengerInstallationKey?: string;
  operationId?: string;
  platformThreadId: string;
  reason?: string;
  stepIndex?: number;
  type: 'completion' | 'step';
  userId?: string;
}

export const callbackHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const callbackScopeKey = (body: CallbackScope): string =>
  callbackHash([
    body.platformThreadId.split(':')[0],
    body.messengerInstallationKey
      ? ['installation', body.messengerInstallationKey]
      : ['application', body.applicationId],
    body.userId ?? null,
    body.platformThreadId,
    body.operationId,
  ]);

export interface LedgerState {
  completionStarted?: boolean;
  effects: Record<string, 'delivered' | 'unknown_delivery'>;
  events: Record<
    string,
    {
      delivered?: boolean;
      fingerprint: string;
      plan?: string;
      renderedPlan?: unknown;
    }
  >;
  highestStep?: number;
}

const isProgressEffect = (id: string): boolean => /^step:\d+\/progress-edit$/.test(id);

const emptyState = (): LedgerState => ({ effects: {}, events: {} });
export const CALLBACK_LEASE_MS = 30_000;
export const CALLBACK_REDIS_TIMEOUT_MS = 5000;

async function bounded<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Callback command timed out')), timeoutMs);
      }),
    ]);
    // A suspended event loop can process a stale response before its timeout.
    if (Date.now() >= deadline) throw new Error('Callback command deadline exceeded');
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Both keys share a Redis Cluster hash slot. Every mutation is owner fenced. */
export const CALLBACK_LEDGER_SCRIPT = `
local action = ARGV[1]
if action == 'acquire' then
  if not redis.call('SET', KEYS[1], ARGV[2], 'NX', 'PX', ARGV[3]) then return {0} end
  return {1, redis.call('GET', KEYS[2]) or ''}
end
if redis.call('GET', KEYS[1]) ~= ARGV[2] then return 0 end
if action == 'save' then
  redis.call('SET', KEYS[2], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return 1
end
if action == 'renew' then return redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
if action == 'release' then return redis.call('DEL', KEYS[1]) end
return 0
`;

export interface LedgerBackend {
  acquire: (key: string, owner: string) => Promise<LedgerState | null>;
  assertHeld?: () => void;
  beforeEffect?: () => void;
  release: (key: string, owner: string) => Promise<void>;
  renew: (key: string, owner: string) => Promise<void>;
  save: (key: string, owner: string, state: LedgerState) => Promise<void>;
}

type RedisClient = NonNullable<ReturnType<typeof getAgentRuntimeRedisClient>>;

export class RedisCallbackLedger implements LedgerBackend {
  constructor(private readonly redis: Pick<RedisClient, 'eval'>) {}

  private async command(action: string, key: string, owner: string, state?: LedgerState) {
    try {
      return await bounded(
        () =>
          this.redis.eval(
            CALLBACK_LEDGER_SCRIPT,
            2,
            `bot:callback:{${key}}:lease`,
            `bot:callback:{${key}}:state`,
            action,
            owner,
            CALLBACK_LEASE_MS,
            state ? JSON.stringify(state) : '',
          ),
        CALLBACK_REDIS_TIMEOUT_MS,
      );
    } catch (cause) {
      throw new CallbackDeliveryError('backend_unavailable', { cause });
    }
  }

  async acquire(key: string, owner: string): Promise<LedgerState | null> {
    const result = (await this.command('acquire', key, owner)) as [number, string?];
    if (result[0] === 0) return null;
    try {
      return result[1] ? JSON.parse(result[1]) : emptyState();
    } catch (cause) {
      throw new CallbackDeliveryError('backend_unavailable', { cause });
    }
  }

  async save(key: string, owner: string, state: LedgerState): Promise<void> {
    if ((await this.command('save', key, owner, state)) !== 1) {
      throw new CallbackDeliveryError('lease_lost');
    }
  }

  async renew(key: string, owner: string): Promise<void> {
    if ((await this.command('renew', key, owner)) !== 1) {
      throw new CallbackDeliveryError('lease_lost');
    }
  }

  async release(key: string, owner: string): Promise<void> {
    await this.command('release', key, owner);
  }
}

/** Explicit process-local storage for direct function hooks, never a Redis error fallback. */
export class InMemoryCallbackLedger implements LedgerBackend {
  private readonly states = new Map<string, LedgerState>();
  private readonly leases = new Map<string, { expires: number; owner: string }>();

  async acquire(key: string, owner: string): Promise<LedgerState | null> {
    const lease = this.leases.get(key);
    if (lease && lease.expires > Date.now()) return null;
    this.leases.set(key, { expires: Date.now() + CALLBACK_LEASE_MS, owner });
    return structuredClone(this.states.get(key) ?? emptyState());
  }

  async save(key: string, owner: string, state: LedgerState): Promise<void> {
    const lease = this.leases.get(key);
    if (lease?.owner !== owner || lease.expires <= Date.now()) {
      throw new CallbackDeliveryError('lease_lost');
    }
    this.states.set(key, structuredClone(state));
    lease.expires = Date.now() + CALLBACK_LEASE_MS;
  }

  async renew(key: string, owner: string): Promise<void> {
    const lease = this.leases.get(key);
    if (lease?.owner !== owner || lease.expires <= Date.now()) {
      throw new CallbackDeliveryError('lease_lost');
    }
    lease.expires = Date.now() + CALLBACK_LEASE_MS;
  }

  async release(key: string, owner: string): Promise<void> {
    if (this.leases.get(key)?.owner === owner) this.leases.delete(key);
  }
}

const sharedLocalLedger = new InMemoryCallbackLedger();

/**
 * Redis delivery ledger, NOT an SQL outbox or exactly-once transport.
 * State has NO TTL, including unknown deliveries and completed tombstones.
 * Completed events discard rendered text; unresolved/partial plans retain it
 * until reconciliation/completion so retries cannot mix message content.
 * Operators must provision Redis persistence (AOF/backups + noeviction).
 * In-flight platform requests cannot be fenced by Redis after lease loss; the
 * message write-ahead unknown tombstone blocks replacement message dispatch
 * to that domain. Uncertain progress is retained, but completion may create a
 * separate final message instead of editing the uncertain progress message.
 * UX effects (typing/reaction/title) are best-effort, not delivery guarantees.
 * Redis loss/reset loses deduplication; reconcile platform delivery BEFORE deleting
 * any record. Local mode only retains state for this process's lifetime.
 */
export function getCallbackLedger(): LedgerBackend {
  if (!isQueueAgentRuntimeEnabled()) return sharedLocalLedger;
  const redis = getAgentRuntimeRedisClient();
  if (!redis) throw new CallbackDeliveryError('backend_unavailable');
  return new RedisCallbackLedger(redis);
}

export class CallbackDeliverySession {
  private heartbeat?: ReturnType<typeof setInterval>;
  private heartbeatError?: unknown;
  private heartbeatInFlight = false;
  private leaseDeadline = Date.now() + CALLBACK_LEASE_MS;

  private constructor(
    private readonly backend: LedgerBackend,
    private readonly key: string,
    private readonly owner: string,
    private readonly state: LedgerState,
    private readonly event: string,
  ) {}

  static async begin(body: CallbackScope, fingerprint: string, backend = getCallbackLedger()) {
    if (
      typeof body.operationId !== 'string' ||
      !body.operationId ||
      typeof body.applicationId !== 'string' ||
      !body.applicationId ||
      typeof body.platformThreadId !== 'string' ||
      !body.platformThreadId ||
      (body.type !== 'step' && body.type !== 'completion') ||
      (body.userId !== undefined && typeof body.userId !== 'string') ||
      (body.messengerInstallationKey !== undefined &&
        typeof body.messengerInstallationKey !== 'string') ||
      (body.type === 'step' && (!Number.isSafeInteger(body.stepIndex) || body.stepIndex! < 0))
    ) {
      throw new CallbackDeliveryError('invalid_callback');
    }
    const key = callbackScopeKey(body);
    const owner = randomUUID();
    const state = await backend.acquire(key, owner);
    if (!state) throw new CallbackDeliveryError('busy');
    const event =
      body.type === 'completion'
        ? 'completion'
        : `${body.reason === 'waiting_for_human' ? 'interaction' : 'step'}:${body.stepIndex}`;
    const session = new CallbackDeliverySession(backend, key, owner, state, event);
    try {
      if (
        (body.type === 'step' &&
          (state.completionStarted || (state.highestStep ?? -1) > body.stepIndex!)) ||
        state.events[event]?.delivered
      ) {
        await session.release();
        return null;
      }
      if (state.events[event] && state.events[event].fingerprint !== fingerprint) {
        if (session.hasMessageEffects()) throw new CallbackDeliveryError('payload_conflict');
        // No platform message has been attempted: a fresh terminal dispatch may
        // safely replace timing/content and its pre-send rendering plan.
        state.events[event] = { fingerprint };
      }
      if (
        Object.entries(state.effects).some(
          ([id, status]) =>
            status === 'unknown_delivery' &&
            // An uncertain progress message is a separate delivery domain. Final
            // replies may proceed ONLY by creating an independent message.
            !(body.type === 'completion' && isProgressEffect(id)),
        )
      ) {
        throw new CallbackDeliveryError('unknown_delivery');
      }
      state.events[event] ??= { fingerprint };
      if (body.type === 'completion') state.completionStarted = true;
      else state.highestStep = body.stepIndex;
      await session.save();
      session.heartbeat = setInterval(() => {
        if (session.heartbeatInFlight || session.heartbeatError) return;
        session.heartbeatInFlight = true;
        session
          .renew()
          .catch((error) => {
            session.heartbeatError = error;
            clearInterval(session.heartbeat);
          })
          .finally(() => {
            session.heartbeatInFlight = false;
          });
      }, CALLBACK_LEASE_MS / 3);
      session.heartbeat.unref?.();
      return session;
    } catch (error) {
      await session.release();
      throw error;
    }
  }

  private assertLocalLease() {
    this.backend.assertHeld?.();
    if (this.heartbeatError) throw this.heartbeatError;
    if (Date.now() >= this.leaseDeadline) throw new CallbackDeliveryError('lease_lost');
  }

  private async ownedCommand(run: () => Promise<void>) {
    this.assertLocalLease();
    const deadline = Date.now() + CALLBACK_LEASE_MS;
    await run();
    if (this.heartbeatError) throw this.heartbeatError;
    if (Date.now() >= deadline) throw new CallbackDeliveryError('lease_lost');
    // Conservative local validity begins when the command was SENT, not received.
    this.leaseDeadline = Math.max(this.leaseDeadline, deadline);
  }

  private async save() {
    await this.ownedCommand(() => this.backend.save(this.key, this.owner, this.state));
  }

  private async renew() {
    await this.ownedCommand(() => this.backend.renew(this.key, this.owner));
  }

  /** UX is not message delivery: verify ownership, but never poison the message ledger. */
  async bestEffort(id: string, send: () => Promise<unknown>): Promise<void> {
    await this.renew();
    this.assertLocalLease();
    try {
      await bounded(() => {
        this.assertLocalLease();
        return send();
      }, CALLBACK_REDIS_TIMEOUT_MS);
    } catch {
      log('Optional callback effect failed: %s', id);
    }
  }

  hasUncertainProgress(): boolean {
    return Object.entries(this.state.effects).some(
      ([id, status]) => isProgressEffect(id) && status === 'unknown_delivery',
    );
  }

  hasDeliveredEffect(id: string): boolean {
    return this.state.effects[`${this.event}/${id}`] === 'delivered';
  }

  private hasMessageEffects(): boolean {
    return Object.keys(this.state.effects).some((id) => id.startsWith(`${this.event}/`));
  }

  async plan<T>(value: T): Promise<T> {
    const event = this.state.events[this.event];
    if (event.plan && this.hasMessageEffects()) {
      // Stable payload fields were verified in begin(). Reuse the original
      // rendered text/targets/statistics, never re-render a partially sent plan
      // using a new duration or changed platform formatting configuration.
      if (event.renderedPlan === undefined || callbackHash(event.renderedPlan) !== event.plan) {
        throw new CallbackDeliveryError('payload_conflict');
      }
      return structuredClone(event.renderedPlan) as T;
    }
    event.plan = callbackHash(value);
    event.renderedPlan = value;
    await this.save();
    return value;
  }

  async effect(id: string, send: () => Promise<unknown>): Promise<void> {
    const key = `${this.event}/${id}`;
    if (this.state.effects[key] === 'delivered') return;
    if (this.state.effects[key] === 'unknown_delivery') {
      throw new CallbackDeliveryError('unknown_delivery');
    }
    this.backend.beforeEffect?.();
    // Write ahead BEFORE dispatch. A crash, timeout, ambiguous edit failure, or
    // expired lease leaves a permanent unknown tombstone, not permission to resend.
    this.state.effects[key] = 'unknown_delivery';
    await this.save(); // owner check + lease renewal before EVERY outbound effect
    this.assertLocalLease();
    try {
      // A timed-out send stays unknown even if its underlying transport ignores cancellation.
      await bounded(() => {
        this.assertLocalLease();
        return send();
      }, 30_000);
    } catch (cause) {
      throw new CallbackDeliveryError('unknown_delivery', { cause });
    }
    this.state.effects[key] = 'delivered';
    await this.save(); // an old worker can never overwrite a replacement owner
  }

  async complete(): Promise<void> {
    this.state.events[this.event].delivered = true;
    // Completed tombstones need only intent/plan hashes and delivery markers.
    // Keep rendered text exclusively for unresolved/partial message delivery.
    delete this.state.events[this.event].renderedPlan;
    await this.save();
  }

  async release(): Promise<void> {
    clearInterval(this.heartbeat);
    try {
      await this.backend.release(this.key, this.owner);
    } catch {
      // Cleanup cannot overwrite unknown_delivery or turn confirmed delivery
      // into permission to resend. The owner lease will expire on its own.
      log('Callback lease release failed');
    }
  }
}
