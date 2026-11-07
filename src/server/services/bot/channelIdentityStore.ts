import { randomUUID } from 'node:crypto';

import type Redis from 'ioredis';

import { boundedGatewayIO } from '@/server/services/gateway/ConnectionLease';

import { generatePairingCode } from './dmPairingStore';

const CHALLENGE_TTL_SECONDS = 300;

export interface ChannelIdentityChallenge {
  applicationId: string;
  platform: string;
  providerId: string;
  revision: string;
  userId: string;
}

const prefix = (providerId: string) => `bot:identity:{${providerId}}:`;

export async function createIdentityChallenge(
  redis: Redis | null,
  challenge: ChannelIdentityChallenge,
) {
  if (!redis) throw new Error('Identity binding requires Redis');
  const base = prefix(challenge.providerId);
  const payload = JSON.stringify(challenge);
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generatePairingCode();
    const result = await boundedGatewayIO(() =>
      redis.eval(
        `local count = redis.call('INCR', KEYS[3])
       if count == 1 then redis.call('EXPIRE', KEYS[3], 600) end
       if count > 5 then return -1 end
       if not redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', 300) then return 0 end
       local old = redis.call('GET', KEYS[2])
       if old then redis.call('DEL', ARGV[3] .. old) end
       redis.call('SET', KEYS[2], ARGV[2], 'EX', 300)
       return 1`,
        3,
        `${base}code:${code}`,
        `${base}user:${challenge.userId}`,
        `${base}rate:${challenge.userId}`,
        payload,
        code,
        `${base}code:`,
      ),
    );
    if (result === -1) throw new Error('Too many binding requests. Try again later.');
    if (result === 1)
      return {
        code,
        command: `/bind ${code}`,
        expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000,
      };
  }
  throw new Error('Unable to create binding code');
}

export async function claimIdentityChallenge(
  redis: Redis | null,
  providerId: string,
  code: string,
  senderId: string,
) {
  if (!redis) throw new Error('Identity binding requires Redis');
  if (!/^[A-Z2-9]{8}$/.test(code)) throw new Error('Binding code is invalid or expired');
  const base = prefix(providerId);
  const claimOwner = randomUUID();
  const raw = await boundedGatewayIO(() =>
    redis.eval(
      `local count = redis.call('INCR', KEYS[3])
     if count == 1 then redis.call('EXPIRE', KEYS[3], 60) end
     if count > 10 then return false end
     local payload = redis.call('GET', KEYS[1])
     if not payload then return false end
     if not redis.call('SET', KEYS[2], ARGV[1], 'NX', 'EX', 60) then return false end
     return payload`,
      3,
      `${base}code:${code}`,
      `${base}claim:${code}`,
      `${base}attempts:${senderId}`,
      claimOwner,
    ),
  );
  if (typeof raw !== 'string') throw new Error('Binding code is invalid, expired or in use');
  return { challenge: JSON.parse(raw) as ChannelIdentityChallenge, claimOwner, code, raw };
}

export async function releaseIdentityChallenge(
  redis: Redis,
  providerId: string,
  claim: { claimOwner: string; code: string; raw: string },
  consumed: boolean,
) {
  const base = prefix(providerId);
  await boundedGatewayIO(() =>
    redis.eval(
      `if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
     if ARGV[3] == '1' and redis.call('GET', KEYS[1]) == ARGV[2] then
       redis.call('DEL', KEYS[1])
     end
     redis.call('DEL', KEYS[2])
     return 1`,
      2,
      `${base}code:${claim.code}`,
      `${base}claim:${claim.code}`,
      claim.claimOwner,
      claim.raw,
      consumed ? '1' : '0',
    ),
  );
}

export async function assertIdentityChallengeClaim(
  redis: Redis,
  providerId: string,
  claim: { claimOwner: string; code: string; raw: string },
) {
  const base = prefix(providerId);
  const held = await boundedGatewayIO(() =>
    redis.eval(
      `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
     if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
     return 1`,
      2,
      `${base}code:${claim.code}`,
      `${base}claim:${claim.code}`,
      claim.raw,
      claim.claimOwner,
    ),
  );
  if (held !== 1) throw new Error('Binding code is invalid or expired');
}
