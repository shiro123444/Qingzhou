import type {
  QQAccessTokenResponse,
  QQGatewayUrlResponse,
  QQSendMessageParams,
  QQSendMessageResponse,
  QQStreamMessageRequest,
} from './types';
import { QQ_MSG_TYPE } from './types';

const AUTH_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE_URL = 'https://api.bot.qq.com';
const MAX_TEXT_LENGTH = 2000;
const MEDIA_TYPE_BY_MIME: Record<string, number> = {
  'audio/mpeg': 3,
  'audio/mp3': 3,
  'audio/ogg': 3,
  'audio/silk': 3,
  'audio/wav': 3,
  'audio/x-wav': 3,
  'image/bmp': 1,
  'image/gif': 1,
  'image/jpeg': 1,
  'image/png': 1,
  'image/webp': 1,
  'video/mp4': 2,
};

/** A received platform rejection. Network failures have no delivery verdict. */
export class QQApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(
      `QQ API rejected request (HTTP ${httpStatus}${code === undefined ? '' : `, code ${code}`})`,
    );
    this.name = 'QQApiError';
  }
}

export class QQApiClient {
  private readonly appId: string;
  private readonly clientSecret: string;
  private cachedToken?: string;
  private tokenExpiresAt = 0;

  constructor(appId: string, clientSecret: string) {
    this.appId = appId;
    this.clientSecret = clientSecret;
  }

  async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const response = await fetch(AUTH_URL, {
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`QQ auth failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as QQAccessTokenResponse;

    this.cachedToken = data.access_token;
    // Refresh 5 minutes before expiration
    this.tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;

    return this.cachedToken;
  }

  private async call<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const token = await this.getAccessToken();
    const url = `${API_BASE_URL}${path}`;

    const init: RequestInit = {
      headers: {
        'Authorization': `QQBot ${token}`,
        'Content-Type': 'application/json',
      },
      method,
    };

    if (body && method !== 'GET' && method !== 'DELETE') {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    // Some endpoints return empty response
    const contentType = response.headers.get('content-type');
    const payload = contentType?.includes('application/json') ? await response.json() : undefined;
    const fields =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const code =
      typeof fields.code === 'number'
        ? fields.code
        : typeof fields.err_code === 'number'
          ? fields.err_code
          : undefined;
    if (!response.ok || (code !== undefined && code !== 0)) {
      const retryAfter = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfter ? Number(retryAfter) : NaN;
      throw new QQApiError(
        response.status,
        code,
        Number.isFinite(retryAfterSeconds) ? Math.max(0, retryAfterSeconds * 1000) : undefined,
      );
    }
    if (contentType?.includes('application/json')) {
      return payload as T;
    }

    return {} as T;
  }

  /**
   * Send message to a QQ group
   */
  async sendGroupMessage(
    groupOpenId: string,
    content: string,
    options?: { eventId?: string; msgId?: string; msgSeq?: number },
  ): Promise<QQSendMessageResponse> {
    const params: QQSendMessageParams = {
      content: this.truncateText(content),
      msg_type: QQ_MSG_TYPE.TEXT,
    };

    if (options?.msgId) {
      params.msg_id = options.msgId;
    }
    if (options?.eventId) {
      params.event_id = options.eventId;
    }
    if (options?.msgSeq !== undefined) {
      params.msg_seq = options.msgSeq;
    }

    return this.call<QQSendMessageResponse>('POST', `/v2/groups/${groupOpenId}/messages`, params);
  }

  /**
   * Send message to a QQ guild channel
   */
  async sendGuildMessage(
    channelId: string,
    content: string,
    options?: { eventId?: string; msgId?: string },
  ): Promise<QQSendMessageResponse> {
    const params: QQSendMessageParams = {
      content: this.truncateText(content),
      msg_type: QQ_MSG_TYPE.TEXT,
    };

    if (options?.msgId) {
      params.msg_id = options.msgId;
    }
    if (options?.eventId) {
      params.event_id = options.eventId;
    }

    return this.call<QQSendMessageResponse>('POST', `/channels/${channelId}/messages`, params);
  }

  /**
   * Send direct message to a user (C2C)
   */
  async sendC2CMessage(
    openId: string,
    content: string,
    options?: { eventId?: string; msgId?: string; msgSeq?: number },
  ): Promise<QQSendMessageResponse> {
    const params: QQSendMessageParams = {
      content: this.truncateText(content),
      msg_type: QQ_MSG_TYPE.TEXT,
    };

    if (options?.msgId) {
      params.msg_id = options.msgId;
    }
    if (options?.eventId) {
      params.event_id = options.eventId;
    }
    if (options?.msgSeq !== undefined) {
      params.msg_seq = options.msgSeq;
    }

    return this.call<QQSendMessageResponse>('POST', `/v2/users/${openId}/messages`, params);
  }

  /** One ledgered stream frame. Callers own sequence state and delivery recovery. */
  async sendC2CStreamMessage(
    openId: string,
    frame: QQStreamMessageRequest,
  ): Promise<QQSendMessageResponse> {
    if (
      !openId ||
      !!frame.msg_id === !!frame.event_id ||
      !Number.isSafeInteger(frame.msg_seq) ||
      frame.msg_seq < 1 ||
      !Number.isSafeInteger(frame.index) ||
      frame.index < 0 ||
      frame.input_mode !== 'replace' ||
      frame.content_type !== 'markdown' ||
      ![1, 10].includes(frame.input_state) ||
      !frame.content_raw ||
      (frame.index === 0 ? !!frame.stream_msg_id : !frame.stream_msg_id)
    )
      throw new Error('Invalid QQ C2C stream frame');
    const receipt = await this.call<QQSendMessageResponse>(
      'POST',
      `/v2/users/${encodeURIComponent(openId)}/stream_messages`,
      { ...frame },
    );
    if (!receipt || typeof receipt.id !== 'string' || !receipt.id)
      throw new Error('QQ stream response is missing its message id');
    return receipt;
  }

  /**
   * Send direct message in a guild (DMS)
   */
  async sendDmsMessage(
    guildId: string,
    content: string,
    options?: { eventId?: string; msgId?: string },
  ): Promise<QQSendMessageResponse> {
    const params: QQSendMessageParams = {
      content: this.truncateText(content),
      msg_type: QQ_MSG_TYPE.TEXT,
    };

    if (options?.msgId) {
      params.msg_id = options.msgId;
    }
    if (options?.eventId) {
      params.event_id = options.eventId;
    }

    return this.call<QQSendMessageResponse>('POST', `/dms/${guildId}/messages`, params);
  }

  /**
   * Get the WebSocket gateway URL for establishing a persistent connection.
   */
  async getGatewayUrl(): Promise<QQGatewayUrlResponse> {
    return this.call<QQGatewayUrlResponse>('GET', '/gateway');
  }

  /**
   * Get bot information
   */
  async getBotInfo(): Promise<{ avatar: string; id: string; username: string } | null> {
    try {
      const data = await this.call<{ avatar: string; id: string; username: string }>(
        'GET',
        '/users/@me',
      );
      return data;
    } catch {
      return null;
    }
  }

  private truncateText(text: string): string {
    if (text.length > MAX_TEXT_LENGTH) {
      return text.slice(0, MAX_TEXT_LENGTH - 3) + '...';
    }
    return text;
  }

  /** Upload without sending; the caller ledgers the separate visible message. */
  async uploadFile(
    threadType: 'group' | 'c2c',
    targetId: string,
    file: { bytes: Uint8Array; filename: string; mimeType: string },
  ): Promise<string> {
    if (file.bytes.length < 1 || file.bytes.length > 10 * 1024 * 1024)
      throw new Error('QQ direct file replies support files up to 10 MiB');
    const fileType = MEDIA_TYPE_BY_MIME[file.mimeType.toLowerCase()] ?? 4;
    const prefix = threadType === 'group' ? 'groups' : 'users';
    const result = await this.call<{ file_info?: string }>(
      'POST',
      `/v2/${prefix}/${encodeURIComponent(targetId)}/files`,
      {
        file_type: fileType,
        file_data: Buffer.from(file.bytes).toString('base64'),
        file_name: file.filename,
        srv_send_msg: false,
      },
    );
    if (typeof result.file_info !== 'string' || !result.file_info)
      throw new Error('QQ upload response is missing file_info');
    return result.file_info;
  }

  async sendFile(
    threadType: 'group' | 'c2c',
    targetId: string,
    fileInfo: string,
    options?: { msgId?: string; msgSeq?: number },
  ): Promise<QQSendMessageResponse> {
    const prefix = threadType === 'group' ? 'groups' : 'users';
    return this.call<QQSendMessageResponse>(
      'POST',
      `/v2/${prefix}/${encodeURIComponent(targetId)}/messages`,
      {
        content: '',
        msg_type: QQ_MSG_TYPE.MEDIA,
        media: { file_info: fileInfo },
        ...(options?.msgId ? { msg_id: options.msgId } : {}),
        ...(options?.msgSeq !== undefined ? { msg_seq: options.msgSeq } : {}),
      },
    );
  }
}
