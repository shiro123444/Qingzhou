const MAX_BODY_BYTES = 1024 * 1024;

export class WebhookBodyError extends Error {
  constructor(readonly status: number) {
    super(status === 413 ? 'Payload too large' : 'Invalid body');
  }
}

/** Bound bytes while reading, not after allocating an arbitrarily large body. */
export const readWebhookBody = async (request: Request): Promise<string> => {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WebhookBodyError(400)), 5000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new WebhookBodyError(413);
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error instanceof WebhookBodyError ? error : new WebhookBodyError(400);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
};
