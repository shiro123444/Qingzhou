import { describe, expect, it, vi } from 'vitest';

import { WechatAdapter } from './adapter';
import type { WechatAdapterConfig } from './types';

const message = {
  context_token: 'private-context',
  from_user_id: 'user',
  item_list: [{ text_item: { text: 'hello' }, type: 1 }],
  message_id: 1,
  message_state: 2,
  message_type: 1,
  to_user_id: 'bot',
};
const request = (body: unknown = message) =>
  new Request('https://app.example/webhook', {
    body: JSON.stringify(body),
    headers: { 'x-internal': 'true', 'x-qingzhou-gateway-signature': 'forged' },
    method: 'POST',
  });
const setup = async (authenticateWebhook?: WechatAdapterConfig['authenticateWebhook']) => {
  const processMessage = vi.fn();
  const adapter = new WechatAdapter({ authenticateWebhook, botId: 'bot', botToken: 'secret' });
  await adapter.initialize({
    getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    getUserName: () => 'test-bot',
    processMessage,
  } as never);
  return { adapter, processMessage };
};

describe('WeChat forwarded-message security boundary', () => {
  it('rejects all unauthenticated delivery even with forged internal markers', async () => {
    const { adapter, processMessage } = await setup();
    expect((await adapter.handleWebhook(request())).status).toBe(401);
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('does not consume the body or parse malformed JSON before rejecting authentication', async () => {
    const { adapter, processMessage } = await setup(
      async () => new Response('Unauthorized', { status: 401 }),
    );
    const req = new Request('https://app.example/webhook', { body: 'not-json', method: 'POST' });
    expect((await adapter.handleWebhook(req)).status).toBe(401);
    expect(req.bodyUsed).toBe(false);
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('fails closed and does not echo errors from the authenticator', async () => {
    const { adapter, processMessage } = await setup(async () => {
      throw new Error('private-secret');
    });
    const response = await adapter.handleWebhook(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-secret');
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('passes an authenticated message into the existing Chat SDK flow', async () => {
    const authenticate = vi.fn(async () => {});
    const { adapter, processMessage } = await setup(authenticate);
    const req = request();
    expect((await adapter.handleWebhook(req)).status).toBe(200);
    expect(authenticate).toHaveBeenCalledWith(req);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage.mock.calls[0][1]).toBe('wechat:single:user');
  });

  it.each([null, [], {}, { ...message, from_user_id: '' }, { ...message, item_list: [null] }])(
    'rejects malformed authenticated message %j',
    async (body) => {
      const { adapter, processMessage } = await setup(async () => {});
      expect((await adapter.handleWebhook(request(body))).status).toBe(400);
      expect(processMessage).not.toHaveBeenCalled();
    },
  );

  it('limits actual body bytes instead of trusting Content-Length', async () => {
    const { adapter, processMessage } = await setup(async () => {});
    const req = new Request('https://app.example/webhook', {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
      duplex: 'half',
      headers: { 'content-length': '1' },
      method: 'POST',
    } as RequestInit);
    expect((await adapter.handleWebhook(req)).status).toBe(413);
    expect(processMessage).not.toHaveBeenCalled();
  });
});
