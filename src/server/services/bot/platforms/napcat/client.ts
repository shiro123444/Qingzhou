import { setTimeout as delay } from 'node:timers/promises';

import { updateBotRuntimeStatus } from '@/server/services/gateway/runtimeStatus';

import { signGatewayRequest } from '../../security/gatewayAuth';
import { stripMarkdown } from '../stripMarkdown';
import {
  type BotPlatformRuntimeContext,
  type BotProviderConfig,
  ClientFactory,
  type PlatformClient,
} from '../types';
import { allowOneBotEvent } from './access';
import { NapCatAdapter } from './adapter';
import { type OneBotConfig, OneBotConnection } from './connection';
import { decodeThread, parseOneBotEvent } from './protocol';

const connectionConfig = (config: BotProviderConfig): OneBotConfig => ({
  selfId: config.applicationId,
  token: config.credentials.accessToken,
  url: String(config.settings.websocketUrl ?? ''),
});

export class NapCatClient implements PlatformClient {
  readonly id = 'napcat';
  readonly applicationId: string;
  private abort = new AbortController();
  private connection?: OneBotConnection;
  private task?: Promise<void>;

  constructor(
    private readonly config: BotProviderConfig,
    private readonly context: BotPlatformRuntimeContext,
  ) {
    this.applicationId = config.applicationId;
  }
  private async status(status: 'starting' | 'connected' | 'disconnected' | 'failed') {
    await (this.context.updateRuntimeStatus ?? updateBotRuntimeStatus)(
      {
        applicationId: this.applicationId,
        platform: this.id,
        status,
      },
      { redisClient: this.context.redisClient as any, ttlMs: 90_000 },
    );
  }
  async start() {
    await this.stop();
    this.abort = new AbortController();
    await this.status('starting');
    try {
      await this.open();
    } catch (error) {
      this.connection?.close();
      await this.status('failed');
      throw error;
    }
    this.task = this.monitor().catch(async () => {
      this.connection?.close();
      if (!this.abort.signal.aborted) await this.status('failed').catch(() => {});
    });
  }
  private async open() {
    this.context.assertConnectionHeld?.();
    this.abort.signal.throwIfAborted();
    this.connection = new OneBotConnection(connectionConfig(this.config), async (payload) => {
      const parsed = parseOneBotEvent(payload, this.applicationId);
      if (!parsed || !allowOneBotEvent(this.config.settings, parsed)) return;
      const body = JSON.stringify(parsed.event);
      const url = `${(this.context.appUrl || '').replace(/\/$/, '')}/api/agent/webhooks/napcat/${this.applicationId}`;
      for (let attempt = 0; attempt < 5; attempt++) {
        this.context.assertConnectionHeld?.();
        this.abort.signal.throwIfAborted();
        try {
          const response = await fetch(url, {
            ...signGatewayRequest({
              applicationId: this.applicationId,
              platform: this.id,
              secret: this.config.credentials.accessToken,
              url,
              body,
            }),
            signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]),
            redirect: 'error',
          });
          if (response.ok) return;
        } catch {
          this.abort.signal.throwIfAborted();
        }
        await delay(Math.min(1000 * 2 ** attempt, 8000), undefined, { signal: this.abort.signal });
      }
      throw new Error('NapCat durable receipt unavailable');
    });
    await this.connection.connect();
    this.context.assertConnectionHeld?.();
    this.abort.signal.throwIfAborted();
    await this.status('connected');
  }
  private async monitor() {
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing || this.abort.signal.aborted) return;
      renewing = true;
      Promise.resolve()
        .then(async () => {
          this.context.assertConnectionHeld?.();
          if (this.connection?.isConnected) await this.status('connected');
        })
        .catch(() => {
          this.abort.abort();
          this.connection?.close();
        })
        .finally(() => {
          renewing = false;
        });
    }, 30_000);
    timer.unref?.();
    let retries = 0;
    try {
      while (!this.abort.signal.aborted) {
        await this.connection!.closed;
        this.context.assertConnectionHeld?.();
        this.abort.signal.throwIfAborted();
        await this.status('disconnected');
        await delay(Math.min(1000 * 2 ** Math.min(retries++, 5), 30_000), undefined, {
          signal: this.abort.signal,
        });
        try {
          await this.open();
          retries = 0;
        } catch {
          this.connection?.close();
          await this.status('failed');
        }
      }
    } finally {
      clearInterval(timer);
    }
  }
  async stop() {
    this.abort.abort();
    this.connection?.close();
    await this.task;
    this.task = undefined;
  }
  createAdapter() {
    return {
      napcat: new NapCatAdapter(this.config, this.context, (thread, text) =>
        this.send(thread, text),
      ),
    };
  }
  private async send(threadId: string, text: string) {
    const target = decodeThread(threadId);
    const connection = new OneBotConnection(connectionConfig(this.config));
    try {
      await connection.connect();
      const receipt = await connection.call(
        target.type === 'group' ? 'send_group_msg' : 'send_private_msg',
        {
          [target.type === 'group' ? 'group_id' : 'user_id']: target.id,
          message: [{ type: 'text', data: { text } }],
        },
      );
      if (!['number', 'string'].includes(typeof receipt.message_id))
        throw new Error('NapCat delivery receipt missing');
      return String(receipt.message_id);
    } finally {
      connection.close();
    }
  }
  getMessenger(threadId: string) {
    return {
      createMessage: async (text: string) => {
        await this.send(threadId, text);
      },
      editMessage: async () => {
        throw new Error('NapCat messages cannot be edited');
      },
      removeReaction: async () => {},
    };
  }
  extractChatId(threadId: string) {
    return decodeThread(threadId).id;
  }
  parseMessageId(id: string) {
    return id;
  }
  formatMarkdown(text: string) {
    return stripMarkdown(text);
  }
}

export class NapCatClientFactory extends ClientFactory {
  createClient(config: BotProviderConfig, context: BotPlatformRuntimeContext) {
    return new NapCatClient(config, context);
  }
  async validateCredentials(
    credentials: Record<string, string>,
    settings: Record<string, unknown> = {},
    applicationId = '',
  ) {
    let connection: OneBotConnection | undefined;
    try {
      connection = new OneBotConnection(
        connectionConfig({ credentials, settings, applicationId, platform: 'napcat' }),
      );
      await connection.connect();
      return { valid: true };
    } catch {
      return {
        valid: false,
        errors: [
          { field: 'credentials', message: 'Check NapCat address, token and logged-in QQ number' },
        ],
      };
    } finally {
      connection?.close();
    }
  }
}
