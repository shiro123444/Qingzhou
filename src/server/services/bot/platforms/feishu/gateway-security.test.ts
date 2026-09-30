// @vitest-environment node
import { LarkAdapter } from '@lobechat/chat-adapter-feishu';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGatewayAuthenticator } from '../../security/gatewayAuth';
import { FeishuWSConnection } from './gateway';

const data = {
  message: {
    chat_id: 'oc_test',
    chat_type: 'p2p',
    content: '{"text":"hello"}',
    create_time: '1700000000000',
    message_id: 'om_test',
    message_type: 'text',
  },
  sender: { sender_id: { open_id: 'ou_test' }, sender_type: 'user' },
};
const url = 'https://example.com/api/agent/webhooks/feishu/cli_test';

afterEach(() => vi.restoreAllMocks());

describe('Feishu/Lark WS gateway forwarding', () => {
  it.each(['feishu', 'lark'] as const)(
    'delivers a signed %s internal event without native webhook secrets',
    async (platform) => {
      const claimReplay = vi.fn().mockResolvedValue(true);
      const authenticateWebhook = createGatewayAuthenticator({
        applicationId: 'cli_test',
        claimReplay,
        platform,
        secret: 'secret',
      });
      const adapter = new LarkAdapter({
        appId: 'cli_test',
        appSecret: 'secret',
        authenticateWebhook,
        platform,
      });
      const processMessage = vi.fn();
      (adapter as any).chat = { processMessage };
      (adapter as any).logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      vi.spyOn((adapter as any).api, 'getUserInfo').mockResolvedValue({ name: 'User' });
      let forwarded: Request | undefined;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (target, init) => {
        expect(init?.redirect).toBe('error');
        forwarded = new Request(String(target), init);
        return adapter.handleWebhook(forwarded.clone());
      });
      const gateway = new FeishuWSConnection({
        appId: 'cli_test',
        appSecret: 'secret',
        domain: platform,
        webhookUrl: url,
      });
      await (gateway as any).forwardEvent('im.message.receive_v1', data);
      expect(processMessage).toHaveBeenCalledOnce();
      expect(claimReplay).toHaveBeenCalledOnce();
      expect(forwarded!.headers.get('X-Lark-Signature')).toBeNull();
      const wrongPlatform = createGatewayAuthenticator({
        applicationId: 'cli_test',
        claimReplay,
        platform: platform === 'feishu' ? 'lark' : 'feishu',
        secret: 'secret',
      });
      expect((await wrongPlatform(forwarded!.clone()))?.status).toBe(401);
    },
  );

  it('surfaces non-2xx and network failures to the SDK handler', async () => {
    const gateway = new FeishuWSConnection({
      appId: 'cli_test',
      appSecret: 'secret',
      domain: 'feishu',
      webhookUrl: url,
    });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 503 }));
    await expect((gateway as any).forwardEvent('im.message.receive_v1', data)).rejects.toThrow(
      'HTTP 503',
    );
    fetch.mockRejectedValue(new Error('Network error'));
    await expect((gateway as any).forwardEvent('im.message.receive_v1', data)).rejects.toThrow(
      'Network error',
    );
  });
});
