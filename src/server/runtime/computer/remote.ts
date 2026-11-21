import { z } from 'zod';

import { browserFrameSchema } from '@/types/agentComputer';

import {
  type ComputerDispatch,
  ComputerError,
  type ComputerProvider,
  computerReceiptSchema,
} from './provider';

const responseSchema = computerReceiptSchema.extend({
  sessionId: z.string(),
  commandId: z.string(),
  revision: z.number().int(),
});

export class RemoteComputerProvider implements ComputerProvider {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
  ) {}
  private async post(
    path: 'invoke' | 'receipt' | 'frame',
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    // No redirects or automatic retry after an external dispatch.
    const response = await fetch(`${this.endpoint}/v1/computer/${path}`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ComputerError('INVALID_RESPONSE');
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > (path === 'frame' ? 400000 : 150000))
          throw new ComputerError('INVALID_RESPONSE');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new ComputerError('INVALID_RESPONSE');
    }
  }
  async execute(dispatch: ComputerDispatch, signal: AbortSignal) {
    const raw = await this.post('invoke', dispatch, signal);
    let result;
    try {
      result = responseSchema.parse(raw);
    } catch {
      throw new ComputerError('INVALID_RESPONSE');
    }
    if (
      result.sessionId !== dispatch.sessionId ||
      result.commandId !== dispatch.commandId ||
      result.revision !== dispatch.revision
    )
      throw new ComputerError('INVALID_RESPONSE');
    const { sessionId: _, commandId: __, revision: ___, ...receipt } = result;
    return receipt;
  }
  async observe(
    identity: { sessionId: string; resourceId: string; revision: number },
    signal: AbortSignal,
  ) {
    const schema = z
      .object({
        sessionId: z.string(),
        resourceId: z.string(),
        revision: z.number().int(),
        frame: browserFrameSchema,
      })
      .strict();
    const parsed = schema.safeParse(await this.post('frame', identity, signal));
    if (
      !parsed.success ||
      parsed.data.sessionId !== identity.sessionId ||
      parsed.data.resourceId !== identity.resourceId ||
      parsed.data.revision !== identity.revision
    )
      throw new ComputerError('INVALID_RESPONSE');
    return parsed.data.frame;
  }
  async lookup(
    identity: { sessionId: string; commandId: string; revision: number },
    signal: AbortSignal,
  ) {
    const schema = z.discriminatedUnion('status', [
      z
        .object({
          ...responseSchema.pick({ sessionId: true, commandId: true, revision: true }).shape,
          status: z.literal('done'),
          receipt: computerReceiptSchema,
        })
        .strict(),
      ...(['pending', 'unknown', 'missing'] as const).map((status) =>
        z
          .object({
            ...responseSchema.pick({ sessionId: true, commandId: true, revision: true }).shape,
            status: z.literal(status),
          })
          .strict(),
      ),
    ]);
    const parsed = schema.safeParse(await this.post('receipt', identity, signal));
    if (
      !parsed.success ||
      parsed.data.sessionId !== identity.sessionId ||
      parsed.data.commandId !== identity.commandId ||
      parsed.data.revision !== identity.revision
    )
      throw new ComputerError('INVALID_RESPONSE');
    return parsed.data.status === 'done'
      ? { status: 'done' as const, receipt: parsed.data.receipt }
      : { status: parsed.data.status };
  }
}
