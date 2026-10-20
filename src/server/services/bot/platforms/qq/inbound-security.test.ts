// @vitest-environment node
import { signWebhookResponse } from '@lobechat/chat-adapter-qq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as runtimeRedis from '@/server/modules/AgentRuntime/redis';
import { signGatewayRequest } from '@/server/services/bot/security/gatewayAuth';

import type { BotProviderConfig } from '../types';
import { QQClientFactory } from './client';

const config: BotProviderConfig = {
  applicationId: 'qq-app',
  credentials: { appSecret: 'secret' },
  platform: 'qq',
  settings: {},
};
const url = 'https://example.com/api/agent/webhooks/qq/qq-app';
const body = JSON.stringify({
  d: { author: { id: 'u' }, content: 'hello', group_openid: 'g', id: 'm' },
  op: 0,
  t: 'GROUP_AT_MESSAGE_CREATE',
});
const scope = {
  applicationId: config.applicationId,
  platform: 'qq',
  secret: config.credentials.appSecret,
};
const redisSet = vi.fn();
function setup(mode: string) {
  const client = new QQClientFactory().createClient(
    { ...config, settings: { connectionMode: mode } },
    {} as any,
  );
  const adapter = client.createAdapter().qq;
  const processMessage = vi.fn();
  adapter.chat = { processMessage };
  return { adapter, processMessage };
}
function native() {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request(url, {
    body,
    headers: {
      'X-Bot-Appid': config.applicationId,
      'X-Signature-Ed25519': signWebhookResponse(timestamp, body, scope.secret),
      'X-Signature-Timestamp': timestamp,
    },
    method: 'POST',
  });
}

beforeEach(() => {
  const claimed = new Set<string>();
  redisSet.mockReset().mockImplementation(async (key: string) => {
    if (claimed.has(key)) return null;
    claimed.add(key);
    return 'OK';
  });
  vi.spyOn(runtimeRedis, 'getAgentRuntimeRedisClient').mockReturnValue({ set: redisSet } as any);
});
afterEach(() => vi.restoreAllMocks());

describe('QQ server authentication mode wiring', () => {
  it('accepts a signed WS envelope once and uses atomic shared replay protection', async () => {
    const { adapter, processMessage } = setup('websocket');
    const init = signGatewayRequest({ ...scope, body, url });
    expect((await adapter.handleWebhook(new Request(url, init))).status).toBe(200);
    expect((await setup('websocket').adapter.handleWebhook(new Request(url, init))).status).toBe(
      409,
    );
    expect(processMessage).toHaveBeenCalledOnce();
    expect(redisSet).toHaveBeenCalledWith(expect.any(String), '1', 'EX', 601, 'NX');
  });

  it.each(['platform', 'applicationId', 'path', 'body', 'timestamp', 'nonce'])(
    'binds internal envelope to %s',
    async (field) => {
      const { adapter, processMessage } = setup('websocket');
      const init = signGatewayRequest({
        ...scope,
        body,
        url,
        ...(field === 'platform' ? { platform: 'weixin' } : {}),
        ...(field === 'applicationId' ? { applicationId: 'other' } : {}),
      });
      if (field === 'body') init.body = body.replace('hello', 'tampered');
      const req = new Request(field === 'path' ? url + '/other' : url, init);
      if (field === 'timestamp')
        req.headers.set('x-qingzhou-gateway-timestamp', String(Math.floor(Date.now() / 1000) - 1));
      if (field === 'nonce') req.headers.set('x-qingzhou-gateway-nonce', 'ab'.repeat(24));
      expect((await adapter.handleWebhook(req)).status).toBe(401);
      expect(processMessage).not.toHaveBeenCalled();
      expect(redisSet).not.toHaveBeenCalled();
    },
  );

  it('does not select authentication mode from caller headers', async () => {
    const ws = setup('websocket');
    expect((await ws.adapter.handleWebhook(native())).status).toBe(401);
    const webhook = setup('webhook');
    expect(
      (
        await webhook.adapter.handleWebhook(
          new Request(url, signGatewayRequest({ ...scope, body, url })),
        )
      ).status,
    ).toBe(401);
    expect(ws.processMessage).not.toHaveBeenCalled();
    expect(webhook.processMessage).not.toHaveBeenCalled();
  });

  it('accepts native webhook signatures once across adapter instances', async () => {
    const { adapter, processMessage } = setup('webhook');
    expect((await adapter.handleWebhook(native())).status).toBe(200);
    expect((await setup('webhook').adapter.handleWebhook(native())).status).toBe(409);
    expect(processMessage).toHaveBeenCalledOnce();
    expect(redisSet).toHaveBeenCalledWith(expect.any(String), '1', 'EX', 601, 'NX');
  });

  it.each(['webhook', 'websocket'])('fails closed with no Redis in %s mode', async (mode) => {
    vi.mocked(runtimeRedis.getAgentRuntimeRedisClient).mockReturnValue(null);
    const { adapter, processMessage } = setup(mode);
    const request =
      mode === 'webhook' ? native() : new Request(url, signGatewayRequest({ ...scope, body, url }));
    expect((await adapter.handleWebhook(request)).status).toBe(503);
    expect(processMessage).not.toHaveBeenCalled();
  });
});
