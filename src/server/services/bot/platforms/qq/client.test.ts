import { QQApiClient } from '@lobechat/chat-adapter-qq';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockInitialize, mockShutdown, mockStartGateway } = vi.hoisted(() => ({
  mockInitialize: vi.fn().mockResolvedValue(undefined),
  mockShutdown: vi.fn().mockResolvedValue(undefined),
  mockStartGateway: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('chat', () => ({
  Chat: class {
    adapters = new Map([['qq', { startGatewayListener: mockStartGateway }]]);
    initialize = mockInitialize;
    shutdown = mockShutdown;
  },
  ConsoleLogger: class {},
}));

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

describe('QQ websocket lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('joins an in-flight refresh before closing its replacement bot', async () => {
    vi.useFakeTimers();
    const client = new QQClientFactory().createClient(
      {
        applicationId: 'app',
        credentials: { appSecret: 'test' },
        platform: 'qq',
        settings: { connectionMode: 'websocket' },
      },
      { appUrl: 'https://example.com' },
    );
    await client.start();
    let finishShutdown!: () => void;
    mockShutdown.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        }),
    );
    await vi.advanceTimersToNextTimerAsync();
    expect(mockShutdown).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = client.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finishShutdown();
    await stopping;
    await vi.advanceTimersByTimeAsync(0);
    expect(mockShutdown).toHaveBeenCalledTimes(2);
    expect(mockStartGateway).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

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
        {
          replyToMessageId: 'original',
          replyToMessageReceivedAt: Date.now(),
          redisClient: { incr, expire: vi.fn() } as any,
        },
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
          {
            replyToMessageId: 'original-id',
            replyToMessageReceivedAt: Date.now(),
            redisClient: { incr, expire } as any,
          },
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

describe('QQ native C2C stream replies', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function createStreamClient(
    options: {
      connectionMode?: 'websocket' | 'webhook';
      enabled?: boolean;
      receivedAt?: number;
      redisAvailable?: boolean;
      replyMessageId?: string;
    } = {},
  ) {
    const sendC2CStreamMessage = vi.fn().mockResolvedValue({ id: 'stream-message' });
    const sendC2CMessage = vi.fn().mockResolvedValue({ id: 'ordinary-message' });
    vi.mocked(QQApiClient).mockImplementation(
      () => ({ sendC2CStreamMessage, sendC2CMessage }) as any,
    );
    const incr = vi.fn().mockResolvedValue(2);
    const client = new QQClientFactory().createClient(
      {
        applicationId: 'app',
        credentials: { appSecret: 'test' },
        platform: 'qq',
        settings: {
          c2cStreaming: options.enabled ?? true,
          connectionMode: options.connectionMode ?? 'websocket',
        },
      },
      {
        replyToMessageId: options.replyMessageId ?? 'original',
        replyToMessageReceivedAt: options.receivedAt,
        redisClient:
          options.redisAvailable === false
            ? undefined
            : ({ incr, expire: vi.fn().mockResolvedValue(1) } as any),
      },
    );
    return { client, incr, sendC2CStreamMessage, sendC2CMessage };
  }

  it.each(['websocket', 'webhook'] as const)(
    'uses one passive sequence across persistent stream frames in %s mode',
    async (connectionMode) => {
      const { client, incr, sendC2CStreamMessage } = createStreamClient({
        connectionMode,
        receivedAt: Date.now(),
      });
      sendC2CStreamMessage.mockResolvedValueOnce({ id: 'stream-message', remain_msg_len: 200 });
      const messenger = client.getMessenger('qq:c2c:target');
      const prepared = await messenger.prepareReplyStream!();
      expect(prepared).toEqual({ msgSeq: 2, replyMessageId: 'original' });
      const first = await messenger.sendReplyStreamFrame!({
        ...prepared,
        content: 'Hello',
        final: false,
        index: 0,
      });
      expect(first.remainingCharacters).toBe(200);
      sendC2CStreamMessage.mockResolvedValueOnce({ id: 'latest-ack', remain_msg_len: 0 });
      const terminal = await messenger.sendReplyStreamFrame!({
        ...prepared,
        content: 'Hello world',
        final: true,
        index: 1,
        streamId: first.streamId,
      });
      expect(terminal.streamId).toBe('stream-message');
      expect(terminal.remainingCharacters).toBe(0);
      expect(incr).toHaveBeenCalledTimes(1);
      expect(sendC2CStreamMessage).toHaveBeenNthCalledWith(1, 'target', {
        content_raw: 'Hello',
        content_type: 'markdown',
        index: 0,
        input_mode: 'replace',
        input_state: 1,
        msg_id: 'original',
        msg_seq: 2,
      });
      expect(sendC2CStreamMessage).toHaveBeenNthCalledWith(2, 'target', {
        content_raw: 'Hello world',
        content_type: 'markdown',
        index: 1,
        input_mode: 'replace',
        input_state: 10,
        msg_id: 'original',
        msg_seq: 2,
        stream_msg_id: 'stream-message',
      });
    },
  );

  it('exposes native streaming only for an opted-in, timestamped C2C passive reply', () => {
    for (const options of [
      { enabled: false, receivedAt: Date.now() },
      { receivedAt: undefined },
      { receivedAt: Date.now() + 60_000 },
      { replyMessageId: '', receivedAt: Date.now() },
    ]) {
      expect(
        createStreamClient(options).client.getMessenger('qq:c2c:target').prepareReplyStream,
      ).toBeUndefined();
    }
    const { client } = createStreamClient({ receivedAt: Date.now() });
    for (const type of ['group', 'guild', 'dms'])
      expect(client.getMessenger(`qq:${type}:target`).prepareReplyStream).toBeUndefined();
  });

  it.each(['websocket', 'webhook'] as const)(
    'retains ordinary replies without sending when the shared budget is unavailable in %s mode',
    async (connectionMode) => {
      const { client, incr, sendC2CStreamMessage, sendC2CMessage } = createStreamClient({
        connectionMode,
        receivedAt: Date.now(),
        redisAvailable: false,
      });
      const messenger = client.getMessenger('qq:c2c:target');
      expect(messenger.prepareReplyStream).toBeUndefined();
      expect(messenger.sendReplyStreamFrame).toBeUndefined();
      expect(incr).not.toHaveBeenCalled();
      expect(sendC2CStreamMessage).not.toHaveBeenCalled();
      await expect(messenger.createMessage('ordinary')).rejects.toThrow('reply_budget_unavailable');
      expect(sendC2CMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['websocket', 'webhook'] as const)(
    'detects per-message native capability before allocating a reply or starting the %s SDK',
    async (connectionMode) => {
      const { client, incr, sendC2CStreamMessage, sendC2CMessage } = createStreamClient({
        connectionMode,
      });
      const messenger = client.getMessenger('qq:c2c:target', {
        replyToMessageId: 'current-message',
        replyToMessageReceivedAt: Date.now(),
      });
      expect(messenger.prepareReplyStream).toEqual(expect.any(Function));
      expect(incr).not.toHaveBeenCalled();
      expect(sendC2CStreamMessage).not.toHaveBeenCalled();
      expect(sendC2CMessage).not.toHaveBeenCalled();
      expect(mockInitialize).not.toHaveBeenCalled();
      expect(mockStartGateway).not.toHaveBeenCalled();
      await expect(messenger.prepareReplyStream!()).resolves.toEqual({
        msgSeq: 2,
        replyMessageId: 'current-message',
      });
      expect(incr).toHaveBeenCalledTimes(1);
      expect(incr).toHaveBeenCalledWith('qq:reply-seq:app:qq:c2c:target:current-message');
    },
  );

  it('refuses late frames and a reply reference belonging to another message', async () => {
    vi.useFakeTimers();
    const { client, sendC2CStreamMessage } = createStreamClient({ receivedAt: Date.now() });
    const messenger = client.getMessenger('qq:c2c:target');
    await expect(
      messenger.sendReplyStreamFrame!({
        content: 'text',
        final: true,
        index: 0,
        msgSeq: 1,
        replyMessageId: 'other',
      }),
    ).rejects.toThrow('does not match');
    vi.advanceTimersByTime(300_000);
    await expect(
      messenger.sendReplyStreamFrame!({
        content: 'text',
        final: true,
        index: 0,
        msgSeq: 1,
        replyMessageId: 'original',
      }),
    ).rejects.toThrow('reply_window_expired');
    expect(sendC2CStreamMessage).not.toHaveBeenCalled();
  });

  it('does not send an ordinary message after an ambiguous stream failure', async () => {
    const { client, sendC2CStreamMessage, sendC2CMessage } = createStreamClient({
      receivedAt: Date.now(),
    });
    sendC2CStreamMessage.mockRejectedValueOnce(new Error('unknown delivery'));
    const messenger = client.getMessenger('qq:c2c:target');
    await expect(
      messenger.sendReplyStreamFrame!({
        content: 'text',
        final: true,
        index: 0,
        msgSeq: 1,
        replyMessageId: 'original',
      }),
    ).rejects.toThrow('unknown delivery');
    expect(sendC2CStreamMessage).toHaveBeenCalledTimes(1);
    expect(sendC2CMessage).not.toHaveBeenCalled();
  });
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
