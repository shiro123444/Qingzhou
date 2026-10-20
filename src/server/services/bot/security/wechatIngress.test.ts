// @vitest-environment node
import type { WechatAdapter } from '@lobechat/chat-adapter-wechat';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as redisRuntime from '@/server/modules/AgentRuntime/redis';
import { WechatClientFactory } from '@/server/services/bot/platforms/wechat/client';

import { signGatewayRequest } from './gatewayAuth';

const config = {
  applicationId: 'wechat-app',
  credentials: { botId: 'bot', botToken: 'test-only-token' },
  platform: 'wechat',
  settings: {},
};
const url = 'https://app.example/api/agent/webhooks/wechat/wechat-app';
const body = JSON.stringify({
  context_token: 'context-private',
  from_user_id: 'alice',
  item_list: [{ text_item: { text: 'hello' }, type: 1 }],
  message_id: 123,
  message_state: 2,
  message_type: 1,
  to_user_id: 'bot',
});
const signed = () =>
  signGatewayRequest({
    applicationId: config.applicationId,
    body,
    platform: config.platform,
    secret: config.credentials.botToken,
    url,
  });
const setup = async () => {
  const client = new WechatClientFactory().createClient(config, { appUrl: 'https://app.example' });
  const adapter = client.createAdapter().wechat as WechatAdapter;
  const processMessage = vi.fn();
  await adapter.initialize({
    getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    getUserName: () => 'test-bot',
    processMessage,
  } as never);
  return { adapter, processMessage };
};

afterEach(() => vi.restoreAllMocks());

describe('real WeChat client → configured adapter → gateway authentication', () => {
  it('allows an identical authenticated retry after SQL receipt fails', async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue(undefined);
    const client = new WechatClientFactory().createClient(config, {
      persistVerifiedWebhook: persist,
    });
    const adapter = client.createAdapter().wechat as WechatAdapter;
    const processMessage = vi.fn();
    await adapter.initialize({
      getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
      getUserName: () => 'test-bot',
      processMessage,
    } as never);
    const init = signed();
    expect((await adapter.handleWebhook(new Request(url, init))).status).toBe(503);
    expect((await adapter.handleWebhook(new Request(url, init))).status).toBe(202);
    expect(processMessage).not.toHaveBeenCalled();
    const tampered = new Request(url, { ...init, body: body.replace('alice', 'victim') });
    expect((await adapter.handleWebhook(tampered)).status).toBe(401);
    expect(persist).toHaveBeenCalledTimes(2);
  });
  it('accepts signed forwards once and blocks unsigned/modified deliveries', async () => {
    const keys = new Set<string>();
    const set = vi.fn(async (key: string) => {
      if (keys.has(key)) return null;
      keys.add(key);
      return 'OK';
    });
    vi.spyOn(redisRuntime, 'getAgentRuntimeRedisClient').mockReturnValue({ set } as never);
    const { adapter, processMessage } = await setup();
    const init = signed();
    expect((await adapter.handleWebhook(new Request(url, { body, method: 'POST' }))).status).toBe(
      401,
    );
    expect(
      (
        await adapter.handleWebhook(
          new Request(url, { ...init, body: body.replace('alice', 'victim') }),
        )
      ).status,
    ).toBe(401);
    expect((await adapter.handleWebhook(new Request(url, init))).status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
    const second = await setup();
    expect((await second.adapter.handleWebhook(new Request(url, init))).status).toBe(409);
    expect(second.processMessage).not.toHaveBeenCalled();
  });

  it('does not dispatch when the shared replay store is unavailable', async () => {
    vi.spyOn(redisRuntime, 'getAgentRuntimeRedisClient').mockReturnValue(null);
    const { adapter, processMessage } = await setup();
    expect((await adapter.handleWebhook(new Request(url, signed()))).status).toBe(503);
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('rejects a signature for another platform with the same secret', async () => {
    const { adapter, processMessage } = await setup();
    const init = signGatewayRequest({
      applicationId: config.applicationId,
      body,
      platform: 'qq',
      secret: config.credentials.botToken,
      url,
    });
    expect((await adapter.handleWebhook(new Request(url, init))).status).toBe(401);
    expect(processMessage).not.toHaveBeenCalled();
  });
});
