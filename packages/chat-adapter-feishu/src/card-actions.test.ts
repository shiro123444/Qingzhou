import { createHash, randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LarkAdapter } from './adapter';
import { LarkApiClient } from './api';
import type { LarkWebhookPayload } from './types';

const action = (sender = 'ou_sender', value: Record<string, unknown> = {}) => ({
  header: { app_id: 'app', event_type: 'card.action.trigger' },
  event: {
    action: {
      value: {
        qingzhouAction: 'confirm',
        token: 'a123456789bc',
        platformThreadId: 'feishu:p2p:oc_chat',
        ...value,
      },
    },
    context: { open_chat_id: 'oc_chat', open_message_id: 'om_card' },
    operator: { open_id: sender },
    token: 'private-callback-token',
  },
});
const processMessage = vi.fn().mockResolvedValue(undefined);
const persist = vi.fn().mockResolvedValue(undefined);
let adapter: LarkAdapter;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(LarkApiClient.prototype, 'getTenantAccessToken').mockResolvedValue('test-token');
  vi.spyOn(LarkApiClient.prototype, 'getBotInfo').mockResolvedValue({});
  vi.spyOn(LarkApiClient.prototype, 'getUserInfo').mockResolvedValue(null);
  adapter = new LarkAdapter({
    appId: 'app',
    appSecret: 'secret',
    platform: 'feishu',
    authenticateWebhook: async () => {},
    persistVerifiedWebhook: persist,
  });
  await adapter.initialize({
    processMessage,
    getUserName: () => 'bot',
    getLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
  } as any);
});
afterEach(() => vi.restoreAllMocks());

const request = (body: unknown) =>
  new Request('https://local.invalid/webhook', { method: 'POST', body: JSON.stringify(body) });

describe('authenticated Feishu card callbacks', () => {
  it('persists a scoped command with the platform operator and strips the callback token', async () => {
    const response = await adapter.handleWebhook(request(action()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ toast: { type: 'info' } });
    expect(processMessage).not.toHaveBeenCalled();
    const [payload, eventId, threadId] = persist.mock.calls[0];
    expect(threadId).toBe('feishu:p2p:oc_chat');
    expect(payload.event.sender.sender_id.open_id).toBe('ou_sender');
    expect(JSON.parse(payload.event.message.content)).toEqual({ text: '/confirm a123456789bc' });
    expect(payload.event.message.message_id).toBe(eventId);
    expect(eventId).not.toBe('om_card');
    expect(JSON.stringify(payload)).not.toContain('private-callback-token');
    await adapter.dispatchVerifiedWebhook(payload as LarkWebhookPayload);
    expect(processMessage).toHaveBeenCalledWith(
      adapter,
      'feishu:p2p:oc_chat',
      expect.any(Function),
      undefined,
    );
    const message = await processMessage.mock.calls[0][2]();
    expect(message.author.userId).toBe('ou_sender');
    expect(message.text).toBe('/confirm a123456789bc');
  });

  it('separates actor-specific clicks so an unauthorized click cannot poison deduplication', async () => {
    await adapter.handleWebhook(request(action('ou_other')));
    await adapter.handleWebhook(request(action('ou_owner')));
    await adapter.handleWebhook(request(action('ou_owner')));
    const ids = persist.mock.calls.map((call) => call[1]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
  });

  it('keeps the durable receipt byte-stable across delayed redelivery', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await adapter.handleWebhook(request(action()));
    now.mockReturnValue(2000);
    await adapter.handleWebhook(request(action()));
    expect(persist.mock.calls[0]).toEqual(persist.mock.calls[1]);
  });

  it('verifies native callback signatures before accepting an external click', async () => {
    const external = new LarkAdapter({
      appId: 'app',
      appSecret: 'secret',
      encryptKey: 'encryption-key',
      platform: 'feishu',
      persistVerifiedWebhook: persist,
    });
    const body = JSON.stringify(action());
    expect((await external.handleWebhook(request(action()))).status).toBe(401);
    expect(persist).not.toHaveBeenCalled();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const signed = new Request('https://local.invalid/webhook', {
      method: 'POST',
      body,
      headers: {
        'X-Lark-Request-Timestamp': timestamp,
        'X-Lark-Request-Nonce': nonce,
        'X-Lark-Signature': createHash('sha256')
          .update(timestamp + nonce + 'encryption-key' + body)
          .digest('hex'),
      },
    });
    expect((await external.handleWebhook(signed)).status).toBe(200);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('returns before the platform callback deadline when SQL receipt stalls', async () => {
    vi.useFakeTimers();
    try {
      persist.mockImplementationOnce(() => new Promise(() => {}));
      const response = adapter.handleWebhook(request(action()));
      await vi.advanceTimersByTimeAsync(2000);
      expect((await response).status).toBe(503);
      expect(processMessage).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { platformThreadId: 'feishu:group:oc_other' },
    { platformThreadId: 'lark:p2p:oc_chat' },
    { qingzhouAction: 'stop' },
    { token: 'not-a-token' },
  ])('rejects forged scope or commands before persistence %o', async (value) => {
    expect((await adapter.handleWebhook(request(action('ou_sender', value)))).status).toBe(400);
    expect(persist).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('requires the official operator open_id and the real message context', async () => {
    const body = action();
    (body.event.operator as any) = { user_id: 'forged-fallback' };
    expect((await adapter.handleWebhook(request(body))).status).toBe(400);
    expect(persist).not.toHaveBeenCalled();
  });

  it('returns a retryable failure when durable receipt fails', async () => {
    persist.mockRejectedValueOnce(new Error('SQL unavailable'));
    expect((await adapter.handleWebhook(request(action()))).status).toBe(503);
    expect(processMessage).not.toHaveBeenCalled();
  });
});
