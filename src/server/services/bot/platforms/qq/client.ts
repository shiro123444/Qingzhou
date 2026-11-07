import type { QQAdapter } from '@lobechat/chat-adapter-qq';
import { createQQAdapter, QQApiClient } from '@lobechat/chat-adapter-qq';
import type { Chat as ChatBot, Message } from 'chat';
import debug from 'debug';

import type { AttachmentSource } from '@/server/services/aiAgent/ingestAttachment';
import {
  claimWebhookReplay,
  createGatewayAuthenticator,
  signGatewayRequest,
} from '@/server/services/bot/security/gatewayAuth';
import {
  BOT_RUNTIME_STATUSES,
  getRuntimeStatusErrorMessage,
  updateBotRuntimeStatus,
} from '@/server/services/gateway/runtimeStatus';

import { allocateQQReply, ReplyUnavailableError } from '../../replyBudget';

import { stripMarkdown } from '../stripMarkdown';
import {
  type BotPlatformRuntimeContext,
  type BotProviderConfig,
  ClientFactory,
  type PlatformClient,
  type PlatformMessenger,
  type UsageStats,
  type ValidationResult,
} from '../types';
import { formatUsageStats } from '../utils';

const log = debug('bot-platform:qq:bot');

const CONNECTED_STATUS_TTL_BUFFER_MS = 60 * 1000;
const DEFAULT_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

export interface GatewayListenerOptions {
  durationMs?: number;
  waitUntil?: (task: Promise<any>) => void;
}

function extractChatId(platformThreadId: string): string {
  return platformThreadId.split(':')[2];
}

function extractThreadType(platformThreadId: string): string {
  return platformThreadId.split(':')[1] || 'group';
}

async function sendQQMessage(
  api: QQApiClient,
  threadType: string,
  targetId: string,
  content: string,
  options?: { msgId: string; msgSeq: number },
): Promise<void> {
  switch (threadType) {
    case 'group': {
      await api.sendGroupMessage(targetId, content, options);
      return;
    }
    case 'guild': {
      await api.sendGuildMessage(targetId, content, options);
      return;
    }
    case 'c2c': {
      await api.sendC2CMessage(targetId, content, options);
      return;
    }
    case 'dms': {
      await api.sendDmsMessage(targetId, content, options);
      return;
    }
    default: {
      await api.sendGroupMessage(targetId, content, options);
    }
  }
}

function replyOptions(
  config: BotProviderConfig,
  context: BotPlatformRuntimeContext,
  threadId: string,
) {
  return () => allocateQQReply(config.applicationId, threadId, context);
}

function qqFileTransport(
  api: QQApiClient,
  threadType: string,
  targetId: string,
  nextOptions: () => Promise<{ msgId: string; msgSeq: number } | undefined>,
): Pick<PlatformMessenger, 'prepareFile'> {
  if (threadType !== 'group' && threadType !== 'c2c') return {};
  return {
    prepareFile: async (file) => {
      const info = await api.uploadFile(threadType, targetId, file);
      return async () => {
        await api.sendFile(threadType, targetId, info, await nextOptions());
      };
    },
  };
}

/** The caller persists frames/receipts; this adapter keeps no process-local stream state. */
function qqStreamTransport(
  api: QQApiClient,
  config: BotProviderConfig,
  context: BotPlatformRuntimeContext,
  threadType: string,
  targetId: string,
  nextOptions: () => Promise<{ msgId: string; msgSeq: number } | undefined>,
): Pick<PlatformMessenger, 'prepareReplyStream' | 'sendReplyStreamFrame'> {
  const receivedAt = context.replyToMessageReceivedAt;
  const isFresh = () =>
    typeof receivedAt === 'number' &&
    Number.isFinite(receivedAt) &&
    receivedAt <= Date.now() &&
    Date.now() - receivedAt < 5 * 60_000;
  if (
    config.settings.c2cStreaming !== true ||
    threadType !== 'c2c' ||
    !context.replyToMessageId ||
    !context.redisClient?.incr ||
    typeof receivedAt !== 'number' ||
    !Number.isFinite(receivedAt) ||
    receivedAt > Date.now()
  )
    return {};
  const assertFresh = () => {
    if (!isFresh()) throw new ReplyUnavailableError('reply_window_expired');
  };
  return {
    prepareReplyStream: async () => {
      assertFresh();
      const options = await nextOptions();
      assertFresh();
      if (!options) throw new Error('QQ C2C stream requires a passive reply reference');
      return { msgSeq: options.msgSeq, replyMessageId: options.msgId };
    },
    sendReplyStreamFrame: async (frame) => {
      assertFresh();
      if (frame.replyMessageId !== context.replyToMessageId)
        throw new Error('QQ C2C stream reply reference does not match this conversation');
      const receipt = await api.sendC2CStreamMessage(targetId, {
        content_raw: frame.content,
        content_type: 'markdown',
        index: frame.index,
        input_mode: 'replace',
        input_state: frame.final ? 10 : 1,
        msg_id: frame.replyMessageId,
        msg_seq: frame.msgSeq,
        ...(frame.streamId ? { stream_msg_id: frame.streamId } : {}),
      });
      return {
        streamId: frame.streamId ?? receipt.id,
        ...(Number.isSafeInteger(receipt.remain_msg_len) && receipt.remain_msg_len! >= 0
          ? { remainingCharacters: receipt.remain_msg_len }
          : {}),
      };
    },
  };
}

/**
 * Resolve attachments on an inbound QQ message into `AttachmentSource[]`.
 *
 * QQ is the simplest case: attachments come with public CDN URLs (`https://multimedia.nt.qq.com.cn/...`)
 * that require no auth and survive `Message.toJSON` unchanged. We just walk
 * the surviving attachment metadata and forward URLs to `ingestAttachment`,
 * which `fetch()`es them with no special handling.
 *
 * No `referenced_message` quirk like Discord, no auth like Slack, no
 * file_id download like Telegram/WeChat/Feishu — just URLs.
 */
function qqExtractFiles(message: Message): AttachmentSource[] | undefined {
  const attachments = (message as any).attachments as
    | Array<{
        height?: number;
        mimeType?: string;
        name?: string;
        size?: number;
        type?: string;
        url?: string;
        width?: number;
      }>
    | undefined;
  if (!attachments?.length) return undefined;

  log('extractFiles: msgId=%s, attachments=%d', (message as any).id, attachments.length);

  const results: AttachmentSource[] = [];
  for (const att of attachments) {
    if (!att.url) continue;
    results.push({
      mimeType: att.mimeType,
      name: att.name,
      size: att.size,
      url: att.url,
    });
  }

  return results.length > 0 ? results : undefined;
}

class QQGatewayClient implements PlatformClient {
  readonly id = 'qq';
  readonly applicationId: string;

  private abort = new AbortController();
  private bot: ChatBot<any> | null = null;
  private config: BotProviderConfig;
  private context: BotPlatformRuntimeContext;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTask?: Promise<void>;
  private stopped = false;

  constructor(config: BotProviderConfig, context: BotPlatformRuntimeContext) {
    this.config = config;
    this.context = context;
    this.applicationId = config.applicationId;
  }

  // --- Lifecycle ---

  async start(options?: GatewayListenerOptions): Promise<void> {
    log('Starting QQBot appId=%s', this.applicationId);

    this.stopped = false;
    this.abort = new AbortController();
    const durationMs = options?.durationMs ?? DEFAULT_DURATION_MS;
    const runtimeStatusTtlMs = durationMs + CONNECTED_STATUS_TTL_BUFFER_MS;
    await (this.context.updateRuntimeStatus ?? updateBotRuntimeStatus)(
      {
        applicationId: this.applicationId,
        platform: this.id,
        status: BOT_RUNTIME_STATUSES.starting,
      },
      { redisClient: this.context.redisClient as any, ttlMs: runtimeStatusTtlMs },
    );

    try {
      if (this.bot) {
        await this.bot.shutdown().catch(() => {});
        this.bot = null;
      }

      const adapter = createQQAdapter({
        appId: this.config.applicationId,
        getReplyOptions: (threadId) => allocateQQReply(this.applicationId, threadId, this.context),
        authenticateWebhook: createGatewayAuthenticator({
          durableReceipt: !!this.context.persistVerifiedWebhook,
          applicationId: this.applicationId,
          platform: this.id,
          secret: this.config.credentials.appSecret,
        }),
        clientSecret: this.config.credentials.appSecret,
      });

      const { Chat, ConsoleLogger } = await import('chat');

      const chatConfig: any = {
        adapters: { qq: adapter },
        userName: `lobehub-gateway-${this.applicationId}`,
      };

      if (this.context.redisClient) {
        const { createIoRedisState } = await import('@chat-adapter/state-ioredis');
        chatConfig.state = createIoRedisState({
          client: this.context.redisClient as any,
          logger: new ConsoleLogger(),
        });
      }

      const bot = new Chat(chatConfig);
      this.bot = bot;
      await bot.initialize();
      this.context.assertConnectionHeld?.();
      if (this.stopped || this.abort.signal.aborted) return;

      const qqAdapter = (bot as any).adapters.get('qq') as QQAdapter;
      const waitUntil = options?.waitUntil ?? ((task: Promise<any>) => task.catch(() => {}));

      const webhookUrl = `${(this.context.appUrl || '').trim()}/api/agent/webhooks/qq/${this.applicationId}`;

      await qqAdapter.startGatewayListener(
        { waitUntil },
        durationMs,
        this.abort.signal,
        webhookUrl,
        async (url, body) => {
          this.context.assertConnectionHeld?.();
          return fetch(url, {
            ...signGatewayRequest({
              applicationId: this.applicationId,
              body,
              platform: this.id,
              secret: this.config.credentials.appSecret,
              url,
            }),
            redirect: 'error',
            signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]),
          });
        },
      );

      this.context.assertConnectionHeld?.();
      if (this.stopped || this.abort.signal.aborted) return;
      if (!options && !this.stopped) {
        this.refreshTimer = setTimeout(() => {
          if (this.abort.signal.aborted || this.stopped) return;

          log(
            'QQBot appId=%s duration elapsed (%dh), refreshing...',
            this.applicationId,
            durationMs / 3_600_000,
          );
          this.abort.abort();
          this.refreshTask = this.start().catch((err) => {
            log('Failed to refresh QQBot appId=%s: %O', this.applicationId, err);
          });
        }, durationMs);
      }

      await (this.context.updateRuntimeStatus ?? updateBotRuntimeStatus)(
        {
          applicationId: this.applicationId,
          platform: this.id,
          status: BOT_RUNTIME_STATUSES.connected,
        },
        { redisClient: this.context.redisClient as any, ttlMs: runtimeStatusTtlMs },
      );

      log('QQBot appId=%s started, webhookUrl=%s', this.applicationId, webhookUrl);
    } catch (error) {
      await (this.context.updateRuntimeStatus ?? updateBotRuntimeStatus)(
        {
          applicationId: this.applicationId,
          errorMessage: getRuntimeStatusErrorMessage(error),
          platform: this.id,
          status: BOT_RUNTIME_STATUSES.failed,
        },
        { redisClient: this.context.redisClient as any, ttlMs: runtimeStatusTtlMs },
      );
      throw error;
    }
  }

  async stop(): Promise<void> {
    log('Stopping QQBot appId=%s', this.applicationId);
    this.stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.abort.abort();
    // A refresh may still be initializing its replacement bot.
    await this.refreshTask;
    if (this.bot) {
      await this.bot.shutdown().catch(() => {});
      this.bot = null;
    }
    await (this.context.updateRuntimeStatus ?? updateBotRuntimeStatus)(
      {
        applicationId: this.applicationId,
        platform: this.id,
        status: BOT_RUNTIME_STATUSES.disconnected,
      },
      { redisClient: this.context.redisClient as any },
    );
  }

  // --- Runtime Operations ---

  createAdapter(): Record<string, any> {
    return {
      qq: createQQAdapter({
        persistVerifiedWebhook: this.context.persistVerifiedWebhook,
        appId: this.config.applicationId,
        getReplyOptions: (threadId) => allocateQQReply(this.applicationId, threadId, this.context),
        authenticateWebhook: createGatewayAuthenticator({
          durableReceipt: !!this.context.persistVerifiedWebhook,
          applicationId: this.applicationId,
          platform: this.id,
          secret: this.config.credentials.appSecret,
        }),
        clientSecret: this.config.credentials.appSecret,
      }),
    };
  }

  getMessenger(
    platformThreadId: string,
    replyContext?: Pick<BotPlatformRuntimeContext, 'replyToMessageId' | 'replyToMessageReceivedAt'>,
  ): PlatformMessenger {
    const context = { ...this.context, ...replyContext };
    const api = new QQApiClient(this.config.applicationId, this.config.credentials.appSecret);
    const targetId = extractChatId(platformThreadId);
    const threadType = extractThreadType(platformThreadId);
    const nextOptions = replyOptions(this.config, context, platformThreadId);
    return {
      ...qqFileTransport(api, threadType, targetId, nextOptions),
      ...qqStreamTransport(api, this.config, context, threadType, targetId, nextOptions),
      createMessage: async (content) =>
        sendQQMessage(api, threadType, targetId, content, await nextOptions()),
      editMessage: async (_messageId, content) =>
        // QQ does not support editing — send a new message as fallback
        sendQQMessage(api, threadType, targetId, content, await nextOptions()),
      // QQ Bot API doesn't support reactions or typing
      removeReaction: () => Promise.resolve(),
    };
  }

  async extractFiles(message: Message): Promise<AttachmentSource[] | undefined> {
    return qqExtractFiles(message);
  }

  extractChatId(platformThreadId: string): string {
    return extractChatId(platformThreadId);
  }

  formatMarkdown(markdown: string): string {
    return stripMarkdown(markdown);
  }

  formatReply(body: string, stats?: UsageStats): string {
    if (!stats || !this.config.settings?.showUsageStats) return body;
    return `${body}\n\n${formatUsageStats(stats)}`;
  }

  parseMessageId(compositeId: string): string {
    return compositeId;
  }
}

class QQWebhookClient implements PlatformClient {
  readonly id = 'qq';
  readonly applicationId: string;

  private config: BotProviderConfig;

  constructor(
    config: BotProviderConfig,
    private readonly context: BotPlatformRuntimeContext,
  ) {
    this.config = config;
    this.applicationId = config.applicationId;
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    log('Starting QQBot (webhook) appId=%s', this.applicationId);
    await updateBotRuntimeStatus({
      applicationId: this.applicationId,
      platform: this.id,
      status: BOT_RUNTIME_STATUSES.starting,
    });

    try {
      // Verify credentials by fetching an access token
      const api = new QQApiClient(this.config.applicationId, this.config.credentials.appSecret);
      await api.getAccessToken();

      await updateBotRuntimeStatus({
        applicationId: this.applicationId,
        platform: this.id,
        status: BOT_RUNTIME_STATUSES.connected,
      });

      log('QQBot (webhook) appId=%s credentials verified', this.applicationId);
    } catch (error) {
      await updateBotRuntimeStatus({
        applicationId: this.applicationId,
        errorMessage: getRuntimeStatusErrorMessage(error),
        platform: this.id,
        status: BOT_RUNTIME_STATUSES.failed,
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    log('Stopping QQBot (webhook) appId=%s', this.applicationId);
    await updateBotRuntimeStatus({
      applicationId: this.applicationId,
      platform: this.id,
      status: BOT_RUNTIME_STATUSES.disconnected,
    });
  }

  // --- Runtime Operations ---

  createAdapter(): Record<string, any> {
    return {
      qq: createQQAdapter({
        persistVerifiedWebhook: this.context.persistVerifiedWebhook,
        appId: this.config.applicationId,
        getReplyOptions: (threadId) => allocateQQReply(this.applicationId, threadId, this.context),
        claimWebhookReplay,
        clientSecret: this.config.credentials.appSecret,
      }),
    };
  }

  getMessenger(
    platformThreadId: string,
    replyContext?: Pick<BotPlatformRuntimeContext, 'replyToMessageId' | 'replyToMessageReceivedAt'>,
  ): PlatformMessenger {
    const context = { ...this.context, ...replyContext };
    const api = new QQApiClient(this.config.applicationId, this.config.credentials.appSecret);
    const targetId = extractChatId(platformThreadId);
    const threadType = extractThreadType(platformThreadId);
    const nextOptions = replyOptions(this.config, context, platformThreadId);
    return {
      ...qqFileTransport(api, threadType, targetId, nextOptions),
      ...qqStreamTransport(api, this.config, context, threadType, targetId, nextOptions),
      createMessage: async (content) =>
        sendQQMessage(api, threadType, targetId, content, await nextOptions()),
      editMessage: async (_messageId, content) =>
        sendQQMessage(api, threadType, targetId, content, await nextOptions()),
      removeReaction: () => Promise.resolve(),
    };
  }

  async extractFiles(message: Message): Promise<AttachmentSource[] | undefined> {
    return qqExtractFiles(message);
  }

  extractChatId(platformThreadId: string): string {
    return extractChatId(platformThreadId);
  }

  formatMarkdown(markdown: string): string {
    return stripMarkdown(markdown);
  }

  formatReply(body: string, stats?: UsageStats): string {
    if (!stats || !this.config.settings?.showUsageStats) return body;
    return `${body}\n\n${formatUsageStats(stats)}`;
  }

  parseMessageId(compositeId: string): string {
    return compositeId;
  }
}

export class QQClientFactory extends ClientFactory {
  createClient(config: BotProviderConfig, context: BotPlatformRuntimeContext): PlatformClient {
    // Fall back to 'webhook' to preserve behavior for legacy provider rows
    // that pre-date the connectionMode field (QQ shipped as webhook-only
    // before websocket support was added). New providers always go through
    // the form which seeds connectionMode from the schema default.
    const mode = (config.settings?.connectionMode as string) || 'webhook';
    if (mode === 'webhook') {
      return new QQWebhookClient(config, context);
    }
    return new QQGatewayClient(config, context);
  }

  async validateCredentials(
    credentials: Record<string, string>,
    _settings?: Record<string, unknown>,
    applicationId?: string,
  ): Promise<ValidationResult> {
    const errors: Array<{ field: string; message: string }> = [];

    if (!applicationId) errors.push({ field: 'applicationId', message: 'App ID is required' });
    if (!credentials.appSecret)
      errors.push({ field: 'appSecret', message: 'App Secret is required' });

    if (errors.length > 0) return { errors, valid: false };

    try {
      const api = new QQApiClient(applicationId!, credentials.appSecret);
      await api.getAccessToken();
      return { valid: true };
    } catch {
      return {
        errors: [{ field: 'credentials', message: 'Failed to authenticate with QQ API' }],
        valid: false,
      };
    }
  }
}
