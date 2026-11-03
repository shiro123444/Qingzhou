import { randomUUID } from 'node:crypto';

import type Redis from 'ioredis';

export const CONNECTION_LEASE_MS = 30_000;
export const CONNECTION_RENEW_MS = 10_000;
const COMMAND_TIMEOUT_MS = 5000;

export async function boundedGatewayIO<T>(
  run: () => Promise<T>,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        if (Date.now() >= deadline) throw new Error('Channel lease command expired');
        return run();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Channel lease backend unavailable')), timeoutMs);
      }),
    ]);
    if (Date.now() >= deadline) throw new Error('Channel lease response expired');
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export const CONNECTION_LEASE_SCRIPT = `
if ARGV[1] == 'acquire' then
  if redis.call('SET', KEYS[1], ARGV[2], 'NX', 'PX', ARGV[3]) then return 1 end
  return 0
end
if redis.call('GET', KEYS[1]) ~= ARGV[2] then return 0 end
if ARGV[1] == 'renew' then return redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
if ARGV[1] == 'release' then return redis.call('DEL', KEYS[1]) end
return 0
`;

/** One process owns a persistent installation. Failed/late Redis I/O revokes it. */
export class ConnectionLease {
  readonly owner = randomUUID();
  readonly key: string;
  private expiresAt = 0;
  private lost = false;
  private released = false;
  private accepting = true;
  private timer?: ReturnType<typeof setInterval>;
  private renewing?: Promise<void>;

  private constructor(
    private readonly redis: Pick<Redis, 'eval'>,
    runtimeKey: string,
    private readonly onLost: () => void,
  ) {
    // Match the existing runtime-status key's hash slot for atomic fenced writes.
    this.key = `bot:gateway:{bot:runtime-status:${runtimeKey}}:lease`;
  }

  static async acquire(
    redis: Pick<Redis, 'eval'> | null,
    runtimeKey: string,
    onLost: () => void,
  ): Promise<ConnectionLease | undefined> {
    if (!redis) throw new Error('Persistent channel connections require Redis');
    const lease = new ConnectionLease(redis, runtimeKey, onLost);
    const requestedAt = Date.now();
    if ((await lease.command('acquire')) !== 1) return;
    lease.expiresAt = requestedAt + CONNECTION_LEASE_MS;
    lease.timer = setInterval(() => lease.renew(), CONNECTION_RENEW_MS);
    lease.timer.unref?.();
    return lease;
  }

  get isHeld(): boolean {
    return !this.lost && !this.released && Date.now() < this.expiresAt;
  }

  assertHeld = (): void => {
    if (this.isHeld) {
      if (!this.accepting) throw new Error('Channel connection is stopping');
      return;
    }
    this.revoke();
    throw new Error('Channel connection lease lost');
  };

  stopAccepting(): void {
    this.accepting = false;
  }

  private async command(action: 'acquire' | 'release' | 'renew'): Promise<unknown> {
    return boundedGatewayIO(() =>
      this.redis.eval(
        CONNECTION_LEASE_SCRIPT,
        1,
        this.key,
        action,
        this.owner,
        CONNECTION_LEASE_MS,
      ),
    );
  }

  private revoke(): void {
    if (this.lost || this.released) return;
    this.lost = true;
    clearInterval(this.timer);
    this.onLost();
  }

  private renew(): void {
    if (this.renewing || this.lost || this.released) return;
    const requestedAt = Date.now();
    this.renewing = (async () => {
      if (!this.isHeld) throw new Error('Channel connection lease lost');
      const renewed = await this.command('renew');
      if (!this.isHeld) throw new Error('Channel connection lease lost');
      if (renewed !== 1) throw new Error('Channel connection lease lost');
      this.expiresAt = requestedAt + CONNECTION_LEASE_MS;
    })()
      .catch(() => this.revoke())
      .finally(() => {
        this.renewing = undefined;
      });
  }

  async release(): Promise<void> {
    this.released = true;
    clearInterval(this.timer);
    await this.renewing;
    await this.command('release');
  }
}
