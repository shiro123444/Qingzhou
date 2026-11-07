import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreateLarkAdapter = vi.hoisted(() => vi.fn());
const mockDownloadMediaFromRawMessage = vi.hoisted(() => vi.fn());
const mockGetTenantAccessToken = vi.hoisted(() => vi.fn().mockResolvedValue('tok'));
const mockInitialize = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('chat', () => ({
  Chat: class {
    initialize = mockInitialize;
    shutdown = vi.fn().mockResolvedValue(undefined);
  },
  ConsoleLogger: class {},
}));

vi.mock('@lobechat/chat-adapter-feishu', () => ({
  createLarkAdapter: mockCreateLarkAdapter,
  decodeLarkThreadId: (threadId: string) => ({ chatId: threadId.split(':').at(-1) }),
  downloadMediaFromRawMessage: mockDownloadMediaFromRawMessage,
  LarkApiClient: vi.fn().mockImplementation(() => ({
    getTenantAccessToken: mockGetTenantAccessToken,
  })),
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

vi.mock('./gateway', () => ({
  FeishuWSConnection: vi.fn().mockImplementation(() => ({
    close: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
  })),
}));

const { FeishuClientFactory } = await import('./client');

describe('Feishu native card capability', () => {
  afterEach(() => vi.clearAllMocks());

  it.each(['webhook', 'websocket'])(
    'exposes scoped card sending only when enabled in %s mode',
    async (connectionMode) => {
      const { LarkApiClient } = await import('@lobechat/chat-adapter-feishu');
      const sendReplyCard = vi.fn().mockResolvedValue({ messageId: 'card' });
      vi.mocked(LarkApiClient).mockImplementationOnce(() => ({ sendReplyCard }) as any);
      const client = new FeishuClientFactory().createClient(
        {
          applicationId: 'cli_card',
          credentials: { appSecret: 'secret' },
          platform: 'feishu',
          settings: { connectionMode, nativeCards: true },
        },
        {},
      );
      const card = { title: 'Done', content: 'result', deliveryId: 'delivery-1' };
      await client.getMessenger('feishu:p2p:oc_chat').createReplyCard!(card);
      expect(sendReplyCard).toHaveBeenCalledWith('oc_chat', card);
    },
  );

  it('keeps legacy providers on their existing text capability', () => {
    const client = new FeishuClientFactory().createClient(
      {
        applicationId: 'cli_text',
        credentials: { appSecret: 'secret' },
        platform: 'feishu',
        settings: {},
      },
      {},
    );
    expect(client.getMessenger('feishu:p2p:oc_chat').createReplyCard).toBeUndefined();
  });
});

describe('Feishu websocket lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('closes a refreshing transport without leaving a replacement refresh timer', async () => {
    vi.useFakeTimers();
    const client = new FeishuClientFactory().createClient(
      {
        applicationId: 'cli_test_app',
        credentials: { appSecret: 'secret' },
        platform: 'feishu',
        settings: { connectionMode: 'websocket' },
      },
      { appUrl: 'https://example.com' },
    );
    await client.start();

    let finishInitialize!: () => void;
    mockInitialize.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishInitialize = resolve;
        }),
    );
    await vi.advanceTimersToNextTimerAsync();
    expect(mockInitialize).toHaveBeenCalledTimes(2);
    const stopping = client.stop();
    finishInitialize();
    await stopping;

    const { FeishuWSConnection } = await import('./gateway');
    const transports = vi.mocked(FeishuWSConnection).mock.results;
    expect(transports).toHaveLength(2);
    expect(transports[1].value.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('FeishuWebhookClient.extractFiles', () => {
  // Verifies the post-Redis re-download path: when Feishu messages
  // round-trip through the chat-sdk debounce/queue, `Message.toJSON`
  // strips both `att.buffer` and `att.fetchData`. We recover by walking
  // `message.raw.content` (JSON) and re-running the same download logic
  // via the package-exported helper.

  const createClient = (platform: 'feishu' | 'lark' = 'feishu') =>
    new FeishuClientFactory().createClient(
      {
        applicationId: 'cli_test_app',
        credentials: { appSecret: 'sec', encryptKey: 'enc' },
        platform,
        // No connectionMode → defaults to webhook
        settings: {},
      },
      { appUrl: 'https://example.com' },
    );

  /** Build a fake Chat SDK Message with a Lark raw payload. */
  const makeMessage = (raw: Record<string, unknown>, id = 'om_test_msg_001') =>
    ({ id, attachments: [], raw, text: '' }) as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when message has no raw payload', async () => {
    const client = createClient();
    const message = { id: 'm', attachments: [], text: '' } as any;
    const result = await client.extractFiles!(message);
    expect(mockDownloadMediaFromRawMessage).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('delegates to downloadMediaFromRawMessage and maps the result', async () => {
    const buffer = Buffer.from('lark-image-bytes');
    mockDownloadMediaFromRawMessage.mockResolvedValue([
      {
        buffer,
        mimeType: 'image/jpeg',
        name: 'image.jpg',
        type: 'image',
      },
    ]);

    const client = createClient();
    const raw = {
      chat_id: 'oc_test',
      content: JSON.stringify({ image_key: 'img_1' }),
      create_time: '1700000000000',
      message_id: 'om_test_msg_001',
      message_type: 'image',
    };
    const result = await client.extractFiles!(makeMessage(raw));

    expect(mockDownloadMediaFromRawMessage).toHaveBeenCalledTimes(1);
    expect(mockDownloadMediaFromRawMessage).toHaveBeenCalledWith(
      expect.anything(), // LarkApiClient instance
      raw,
    );
    expect(result).toEqual([
      { buffer, mimeType: 'image/jpeg', name: 'image.jpg', size: undefined },
    ]);
  });

  it('returns undefined when downloadMediaFromRawMessage resolves to empty array', async () => {
    mockDownloadMediaFromRawMessage.mockResolvedValue([]);
    const client = createClient();
    const result = await client.extractFiles!(
      makeMessage({
        message_id: 'm',
        message_type: 'text',
        content: JSON.stringify({ text: 'hi' }),
      }),
    );
    expect(mockDownloadMediaFromRawMessage).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  it('maps file attachments preserving name + size', async () => {
    const buffer = Buffer.from('pdf-bytes');
    mockDownloadMediaFromRawMessage.mockResolvedValue([
      {
        buffer,
        mimeType: 'application/pdf',
        name: 'report.pdf',
        size: 4096,
        type: 'file',
      },
    ]);
    const client = createClient();
    const result = await client.extractFiles!(
      makeMessage({
        message_id: 'm',
        message_type: 'file',
        content: JSON.stringify({ file_key: 'f', file_name: 'report.pdf' }),
      }),
    );
    expect(result).toEqual([
      { buffer, mimeType: 'application/pdf', name: 'report.pdf', size: 4096 },
    ]);
  });

  it('caches LarkApiClient across multiple extractFiles calls (token cache hot)', async () => {
    const { LarkApiClient } = await import('@lobechat/chat-adapter-feishu');
    const ctorSpy = vi.mocked(LarkApiClient);
    const ctorCallCountBefore = ctorSpy.mock.calls.length;

    const client = createClient();
    mockDownloadMediaFromRawMessage.mockResolvedValue([]);

    await client.extractFiles!(
      makeMessage({ message_id: 'm1', message_type: 'text', content: '{}' }),
    );
    await client.extractFiles!(
      makeMessage({ message_id: 'm2', message_type: 'text', content: '{}' }),
    );

    // The lazy `_api` getter should construct LarkApiClient at most ONCE per
    // FeishuWebhookClient instance, so the second extractFiles call reuses
    // the same instance (and its tenant token cache).
    expect(ctorSpy.mock.calls.length - ctorCallCountBefore).toBeLessThanOrEqual(1);
  });

  it('propagates errors from downloadMediaFromRawMessage as-is', async () => {
    mockDownloadMediaFromRawMessage.mockRejectedValue(new Error('helper crashed'));
    const client = createClient();
    await expect(
      client.extractFiles!(
        makeMessage({
          message_id: 'm',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'k' }),
        }),
      ),
    ).rejects.toThrow('helper crashed');
  });

  it('works the same for lark platform variant', async () => {
    const buffer = Buffer.from('lark');
    mockDownloadMediaFromRawMessage.mockResolvedValue([
      { buffer, mimeType: 'image/jpeg', name: 'image.jpg', type: 'image' },
    ]);

    const client = createClient('lark');
    const raw = {
      chat_id: 'oc_test',
      content: JSON.stringify({ image_key: 'img_1' }),
      create_time: '1700000000000',
      message_id: 'om_test_msg_001',
      message_type: 'image',
    };
    const result = await client.extractFiles!(makeMessage(raw));

    expect(result).toEqual([
      { buffer, mimeType: 'image/jpeg', name: 'image.jpg', size: undefined },
    ]);
  });
});

describe('Feishu/Lark inbound authentication mode', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetTenantAccessToken.mockResolvedValue('tok');
    const { LarkApiClient } = await import('@lobechat/chat-adapter-feishu');
    vi.mocked(LarkApiClient).mockImplementation(
      () =>
        ({
          getTenantAccessToken: mockGetTenantAccessToken,
        }) as any,
    );
  });

  it.each(['feishu', 'lark'])(
    'injects shared replay claims only for external %s webhooks',
    (platform) => {
      const client = new FeishuClientFactory().createClient(
        {
          applicationId: 'cli_test_app',
          credentials: { appSecret: 'secret', encryptKey: 'enc' },
          platform,
          settings: { connectionMode: 'webhook' },
        },
        { appUrl: 'https://example.com' },
      );
      client.createAdapter();
      expect(mockCreateLarkAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          claimWebhookReplay: expect.any(Function),
          encryptKey: 'enc',
          platform,
        }),
      );
      expect(mockCreateLarkAdapter.mock.calls[0][0].authenticateWebhook).toBeUndefined();
    },
  );

  it.each(['feishu', 'lark'])(
    'requires internal signed envelopes in %s WS mode',
    async (platform) => {
      const client = new FeishuClientFactory().createClient(
        {
          applicationId: 'cli_test_app',
          credentials: { appSecret: 'secret' },
          platform,
          settings: { connectionMode: 'websocket' },
        },
        { appUrl: 'https://example.com' },
      );
      client.createAdapter();
      const config = mockCreateLarkAdapter.mock.calls[0][0];
      expect(config.encryptKey).toBeUndefined();
      expect(config.verificationToken).toBeUndefined();
      expect(config.claimWebhookReplay).toBeUndefined();
      expect(config.authenticateWebhook).toEqual(expect.any(Function));
      const response = await config.authenticateWebhook(
        new Request('http://localhost/webhook', {
          body: '{}',
          method: 'POST',
        }),
      );
      expect(response.status).toBe(401);
    },
  );

  it('requires Encrypt Key only in webhook/legacy mode with a useful field error', async () => {
    const factory = new FeishuClientFactory();
    for (const settings of [undefined, { connectionMode: 'webhook' }]) {
      const result = await factory.validateCredentials(
        { appSecret: 'secret' },
        settings,
        'app',
        'feishu',
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'encryptKey' }));
    }
    expect(
      (
        await factory.validateCredentials(
          { appSecret: 'secret' },
          { connectionMode: 'websocket' },
          'app',
          'lark',
        )
      ).valid,
    ).toBe(true);
    expect(
      (
        await factory.validateCredentials(
          { appSecret: 'secret', encryptKey: 'enc' },
          { connectionMode: 'webhook' },
          'app',
          'feishu',
        )
      ).valid,
    ).toBe(true);
  });
});
