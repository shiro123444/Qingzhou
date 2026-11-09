import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  FormattedContent,
  RawMessage,
  WebhookOptions,
} from 'chat';
import { BaseFormatConverter, Message, parseMarkdown, stringifyMarkdown } from 'chat';

import { createGatewayAuthenticator, MAX_GATEWAY_BODY_BYTES } from '../../security/gatewayAuth';
import type { BotPlatformRuntimeContext, BotProviderConfig } from '../types';
import { allowOneBotEvent } from './access';
import { decodeThread, type OneBotEvent, parseOneBotEvent } from './protocol';

class TextConverter extends BaseFormatConverter {
  fromAst(ast: FormattedContent) {
    return stringifyMarkdown(ast);
  }
  toAst(text: string) {
    return parseMarkdown(text);
  }
}

/** Chat routing and HTTP receipt only. The socket belongs to the disposable gateway client. */
export class NapCatAdapter implements Adapter<ReturnType<typeof decodeThread>, OneBotEvent> {
  readonly name = 'napcat';
  readonly userName = 'NapCat';
  readonly botUserId: string;
  private chat!: ChatInstance;
  private formatter = new TextConverter();
  private authenticate;

  constructor(
    private readonly config: BotProviderConfig,
    private readonly context: BotPlatformRuntimeContext,
    private readonly send: (threadId: string, text: string) => Promise<string>,
  ) {
    this.botUserId = config.applicationId;
    this.authenticate = createGatewayAuthenticator({
      applicationId: this.botUserId,
      platform: this.name,
      secret: config.credentials.accessToken,
      durableReceipt: !!context.persistVerifiedWebhook,
    });
  }

  async initialize(chat: ChatInstance) {
    this.chat = chat;
  }

  async handleWebhook(request: Request, options?: WebhookOptions) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    try {
      const rejection = await this.authenticate(request);
      if (rejection) return rejection;
    } catch {
      return new Response('Authentication unavailable', { status: 503 });
    }
    // The authenticator has already bounded and checked the cloned request body.
    const body = await request.text();
    if (Buffer.byteLength(body) > MAX_GATEWAY_BODY_BYTES)
      return new Response('Too large', { status: 413 });
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }
    return this.dispatchVerifiedWebhook(payload, options, true);
  }

  async dispatchVerifiedWebhook(payload: unknown, options?: WebhookOptions, persist = false) {
    const parsed = parseOneBotEvent(payload, this.botUserId);
    if (!parsed || !allowOneBotEvent(this.config.settings, parsed))
      return Response.json({ ignored: true });
    if (persist) {
      if (!this.context.persistVerifiedWebhook)
        return new Response('Receipt unavailable', { status: 503 });
      try {
        await this.context.persistVerifiedWebhook(parsed.event, parsed.eventId, parsed.threadId);
        return Response.json({ accepted: true }, { status: 202 });
      } catch {
        return new Response('Receipt unavailable', { status: 503 });
      }
    }
    await this.chat.processMessage(
      this,
      parsed.threadId,
      async () => this.parseMessage(parsed.event),
      options,
    );
    return Response.json({ ok: true });
  }

  parseMessage(raw: OneBotEvent) {
    const parsed = parseOneBotEvent(raw, this.botUserId);
    if (!parsed) throw new Error('Invalid OneBot message');
    return new Message({
      attachments: [],
      id: raw.message_id,
      threadId: parsed.threadId,
      text: parsed.text,
      formatted: parseMarkdown(parsed.text),
      raw,
      isMention: parsed.isMention,
      author: {
        userId: raw.user_id,
        userName: raw.sender?.nickname ?? raw.user_id,
        fullName: raw.sender?.card || raw.sender?.nickname || raw.user_id,
        isBot: false,
        isMe: false,
      },
      metadata: { dateSent: new Date(raw.time * 1000), edited: false },
    });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<OneBotEvent>> {
    const id = await this.send(threadId, this.formatter.renderPostable(message));
    return { id, threadId, raw: {} as OneBotEvent };
  }
  async editMessage(): Promise<never> {
    throw new Error('NapCat text messages cannot be edited');
  }
  async deleteMessage() {
    throw new Error('NapCat deletion is not enabled');
  }
  async addReaction() {}
  async removeReaction() {}
  async startTyping() {}
  async fetchMessages() {
    return { messages: [] };
  }
  async fetchThread(threadId: string) {
    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      isDM: this.isDM(threadId),
      metadata: {},
    };
  }
  encodeThreadId(data: ReturnType<typeof decodeThread>) {
    return `napcat:${data.type}:${data.id}`;
  }
  decodeThreadId(threadId: string) {
    return decodeThread(threadId);
  }
  channelIdFromThreadId(threadId: string) {
    return decodeThread(threadId).id;
  }
  isDM(threadId: string) {
    return decodeThread(threadId).type === 'private';
  }
  renderFormatted(content: FormattedContent) {
    return stringifyMarkdown(content);
  }
}
