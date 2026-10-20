import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKeyFromSecret(clientSecret: string) {
  const secret = Buffer.from(clientSecret, 'utf8');
  if (!secret.length) throw new Error('QQ client secret must not be empty');
  const seed = Buffer.alloc(32);
  for (let i = 0; i < seed.length; i++) seed[i] = secret[i % secret.length];
  return createPrivateKey({
    format: 'der',
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    type: 'pkcs8',
  });
}

/** QQ signs event_ts + plain_token for URL registration. Validate challenge data before calling. */
export function signWebhookResponse(
  eventTs: string,
  plainToken: string,
  clientSecret: string,
): string {
  return sign(null, Buffer.from(eventTs + plainToken), privateKeyFromSecret(clientSecret)).toString(
    'hex',
  );
}

/** Verify the exact incoming bytes, never a parsed/re-serialized JSON body. */
export function verifyWebhookSignature(
  timestamp: string,
  body: Uint8Array,
  signature: string,
  clientSecret: string,
): boolean {
  if (!/^[\da-f]{128}$/i.test(signature)) return false;
  return verify(
    null,
    Buffer.concat([Buffer.from(timestamp), body]),
    createPublicKey(privateKeyFromSecret(clientSecret)),
    Buffer.from(signature, 'hex'),
  );
}
