import { QQApiClient } from '@lobechat/chat-adapter-qq';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@lobechat/chat-adapter-qq', () => ({
  createQQAdapter: vi.fn(),
  QQApiClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@/server/services/gateway/runtimeStatus', () => ({
  BOT_RUNTIME_STATUSES: {
    connected: 'connected',
    disconnected: 'disconnected',
    failed: 'failed',
    starting: 'starting',
  },
  getRuntimeStatusErrorMessage: (e: any) => String(e?.message ?? e),
  updateBotRuntimeStatus: vi.fn().mockResolvedValue(undefined),
}));

const { QQClientFactory } = await import('./client');

describe('QQ passive reply context', () => {
  it.each(['websocket', 'webhook'])(
    'prepares file uploads privately and assigns the reply sequence at the visible send in %s mode',
    async (connectionMode) => {
      const uploadFile = vi.fn().mockResolvedValue('file-info');
      const sendFile = vi.fn().mockResolvedValue({ id: 'sent' });
      vi.mocked(QQApiClient).mockImplementation(() => ({ uploadFile, sendFile }) as any);
      const incr = vi.fn().mockResolvedValue(4);
      const client = new QQClientFactory().createClient(
        {
          applicationId: 'app',
          credentials: { appSecret: 'test' },
          platform: 'qq',
          settings: { connectionMode },
        },
        { replyToMessageId: 'original', redisClient: { incr } as any },
      );
      const messenger = client.getMessenger('qq:group:target');
      const file = {
        bytes: Buffer.from('PNG'),
        filename: 'formula.png',
        mimeType: 'image/png',
        deliveryId: 'delivery',
      };
      const send = await messenger.prepareFile!(file);
      expect(uploadFile).toHaveBeenCalledWith('group', 'target', file);
      expect(sendFile).not.toHaveBeenCalled();
      expect(incr).not.toHaveBeenCalled();
      await send();
      expect(sendFile).toHaveBeenCalledWith('group', 'target', 'file-info', {
        msgId: 'original',
        msgSeq: 4,
      });
      expect(client.getMessenger('qq:guild:target').prepareFile).toBeUndefined();
    },
  );

  it.each(['websocket', 'webhook'])(
    'preserves message ID and reply sequence in %s mode across callback clients',
    async (connectionMode) => {
      const send = vi.fn().mockResolvedValue({ id: 'reply' });
      vi.mocked(QQApiClient).mockImplementation(() => ({ sendGroupMessage: send }) as any);
      const incr = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
      const expire = vi.fn().mockResolvedValue(1);
      const create = () =>
        new QQClientFactory().createClient(
          {
            applicationId: 'app',
            credentials: { appSecret: 'test' },
            platform: 'qq',
            settings: { connectionMode },
          },
          { replyToMessageId: 'original-id', redisClient: { incr, expire } as any },
        );
      await create().getMessenger('qq:group:test').createMessage('first');
      await create().getMessenger('qq:group:test').createMessage('second');
      expect(send).toHaveBeenNthCalledWith(1, 'test', 'first', { msgId: 'original-id', msgSeq: 1 });
      expect(send).toHaveBeenNthCalledWith(2, 'test', 'second', {
        msgId: 'original-id',
        msgSeq: 2,
      });
      expect(incr.mock.calls[1][0]).toBe(incr.mock.calls[0][0]);
    },
  );
});

describe('QQGatewayClient.extractFiles', () => {
  // QQ is the simplest case among all platforms — public CDN URLs survive
  // serialization unchanged. extractFiles just walks `att.url` and forwards
  // them to ingestAttachment, which fetch()es with no special handling.

  const createClient = (connectionMode: 'webhook' | 'websocket' = 'websocket') =>
    new QQClientFactory().createClient(
      {
        applicationId: 'qq-app',
        credentials: { appSecret: 'sec' },
        platform: 'qq',
        settings: { connectionMode },
      },
      { appUrl: 'https://example.com' },
    );

  /** Build a fake Chat SDK Message with QQ attachments. */
  const makeMessage = (attachments: Array<Record<string, unknown>>, id = '12345') =>
    ({
      attachments,
      id,
      raw: {},
      text: '',
    }) as any;

  it('returns undefined when no attachments are present', async () => {
    const client = createClient();
    const result = await client.extractFiles!(makeMessage([]));
    expect(result).toBeUndefined();
  });

  it('forwards image attachments by URL', async () => {
    const client = createClient();
    const result = await client.extractFiles!(
      makeMessage([
        {
          mimeType: 'image/jpeg',
          name: 'photo.jpg',
          size: 12_345,
          type: 'image',
          url: 'https://multimedia.nt.qq.com.cn/download?fileid=abc',
        },
      ]),
    );

    expect(result).toEqual([
      {
        mimeType: 'image/jpeg',
        name: 'photo.jpg',
        size: 12_345,
        url: 'https://multimedia.nt.qq.com.cn/download?fileid=abc',
      },
    ]);
  });

  it('forwards video attachments by URL', async () => {
    const client = createClient();
    const result = await client.extractFiles!(
      makeMessage([
        {
          mimeType: 'video/mp4',
          name: 'clip.mp4',
          size: 100_000,
          type: 'video',
          url: 'https://multimedia.nt.qq.com.cn/download?fileid=def',
        },
      ]),
    );

    expect(result).toEqual([
      {
        mimeType: 'video/mp4',
        name: 'clip.mp4',
        size: 100_000,
        url: 'https://multimedia.nt.qq.com.cn/download?fileid=def',
      },
    ]);
  });

  it('skips attachments missing url', async () => {
    const client = createClient();
    const result = await client.extractFiles!(
      makeMessage([
        { mimeType: 'image/jpeg', name: 'orphan.jpg', type: 'image' },
        {
          mimeType: 'image/jpeg',
          name: 'good.jpg',
          type: 'image',
          url: 'https://multimedia.nt.qq.com.cn/download?fileid=good',
        },
      ]),
    );

    expect(result).toEqual([
      {
        mimeType: 'image/jpeg',
        name: 'good.jpg',
        size: undefined,
        url: 'https://multimedia.nt.qq.com.cn/download?fileid=good',
      },
    ]);
  });

  it('handles multiple attachments in order', async () => {
    const client = createClient();
    const result = await client.extractFiles!(
      makeMessage([
        {
          mimeType: 'image/jpeg',
          name: 'a.jpg',
          type: 'image',
          url: 'https://multimedia.nt.qq.com.cn/download?fileid=a',
        },
        {
          mimeType: 'application/pdf',
          name: 'b.pdf',
          type: 'file',
          url: 'https://multimedia.nt.qq.com.cn/download?fileid=b',
        },
      ]),
    );

    expect(result).toHaveLength(2);
    expect((result as any)?.[0]?.name).toBe('a.jpg');
    expect((result as any)?.[1]?.name).toBe('b.pdf');
  });

  it('returns undefined when all attachments lack urls', async () => {
    const client = createClient();
    const result = await client.extractFiles!(
      makeMessage([{ mimeType: 'image/jpeg', name: 'no-url.jpg', type: 'image' }]),
    );
    expect(result).toBeUndefined();
  });

  it('works the same for webhook connection mode', async () => {
    const client = createClient('webhook');
    const result = await client.extractFiles!(
      makeMessage([
        {
          mimeType: 'image/jpeg',
          name: 'a.jpg',
          type: 'image',
          url: 'https://multimedia.nt.qq.com.cn/download?fileid=a',
        },
      ]),
    );
    expect(result).toHaveLength(1);
  });
});
