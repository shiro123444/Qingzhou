import { afterEach, describe, expect, it, vi } from 'vitest';

import { LarkApiClient } from './api';
import { buildLarkReplyCard, type LarkReplyCard } from './cards';

const card: LarkReplyCard = {
  content: 'Please review this request.',
  deliveryId: 'operation:completion:card-1',
  title: 'Confirmation required',
  actions: [
    {
      action: 'confirm',
      label: 'Allow',
      platformThreadId: 'feishu:p2p:oc_chat',
      token: 'a123456789bc',
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Feishu native reply cards', () => {
  it('uses JSON 2.0 callback buttons with only scoped decision fields', () => {
    const rendered = buildLarkReplyCard(card);
    expect(rendered).toMatchObject({
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: card.content },
          {
            tag: 'button',
            behaviors: [
              {
                type: 'callback',
                value: {
                  qingzhouAction: 'confirm',
                  token: 'a123456789bc',
                  platformThreadId: 'feishu:p2p:oc_chat',
                },
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(rendered)).not.toContain('userId');
  });

  it('renders model-generated mentions as visible text', () => {
    expect(
      JSON.stringify(buildLarkReplyCard({ ...card, content: '<at id=all>everyone</at>' })),
    ).not.toContain('<at');
  });

  it('rejects action commands outside the confirmation contract', () => {
    expect(() =>
      buildLarkReplyCard({
        ...card,
        actions: [{ ...card.actions![0], action: 'stop' as 'confirm' }],
      }),
    ).toThrow('Invalid Feishu card action');
  });

  it('sends an interactive message with a stable, scoped delivery UUID', async () => {
    const api = new LarkApiClient('app', 'secret', 'feishu');
    vi.spyOn(api, 'getTenantAccessToken').mockResolvedValue('test-token');
    const fetch = vi
      .fn()
      .mockImplementation(async () => Response.json({ code: 0, data: { message_id: 'om_card' } }));
    vi.stubGlobal('fetch', fetch);
    await api.sendReplyCard('oc_chat', card);
    await api.sendReplyCard('oc_chat', card);
    await api.sendReplyCard('oc_other', card);
    const payloads = fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(fetch.mock.calls[0][0]).toBe(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
    );
    expect(payloads[0]).toMatchObject({ msg_type: 'interactive', receive_id: 'oc_chat' });
    expect(JSON.parse(payloads[0].content)).toMatchObject({ schema: '2.0' });
    expect(payloads[0].uuid.length).toBeLessThanOrEqual(50);
    expect(payloads[0].uuid).toBe(payloads[1].uuid);
    expect(payloads[0].uuid).not.toBe(payloads[2].uuid);
  });

  it('fails oversized cards before acquiring a token or making a request', async () => {
    const api = new LarkApiClient('app', 'secret');
    const token = vi.spyOn(api, 'getTenantAccessToken');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      api.sendReplyCard('oc_chat', { ...card, content: '脑'.repeat(15000) }),
    ).rejects.toThrow('message size');
    expect(token).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces platform business rejection and malformed success responses', async () => {
    const api = new LarkApiClient('app', 'secret');
    vi.spyOn(api, 'getTenantAccessToken').mockResolvedValue('test-token');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ code: 230006, msg: 'permission denied' }))
        .mockResolvedValueOnce(Response.json({ code: 0, data: {} })),
    );
    await expect(api.sendReplyCard('oc_chat', card)).rejects.toThrow('230006');
    await expect(api.sendReplyCard('oc_chat', card)).rejects.toThrow('message ID');
  });
});
