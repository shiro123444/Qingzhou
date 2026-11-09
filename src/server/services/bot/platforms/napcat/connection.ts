import { randomUUID } from 'node:crypto';

import type WebSocket from 'ws';

export interface OneBotConfig {
  selfId: string;
  token: string;
  url: string;
}

export function validateOneBotConfig(config: OneBotConfig) {
  const url = new URL(config.url);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    (url.protocol === 'ws:' && !local) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !config.token.trim() ||
    !/^[1-9]\d{4,15}$/.test(config.selfId)
  )
    throw new Error('NapCat requires a QQ number, token and local ws:// or remote wss:// address');
}

/** An authenticated OneBot v11 Universal socket. Sends are never automatically replayed. */
export class OneBotConnection {
  get isConnected() {
    return this.ready && !this.stopped;
  }
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pending = new Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private ready = false;
  private stopped = false;
  private buffered: unknown[] = [];
  private queued = 0;
  private queue = Promise.resolve();
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(
    private readonly config: OneBotConfig,
    private readonly onEvent?: (event: unknown) => Promise<void>,
  ) {
    validateOneBotConfig(config);
  }

  async connect() {
    const { default: WebSocket } = await import('ws');
    if (this.stopped) throw new Error('NapCat connection stopped');
    const socket = new WebSocket(this.config.url, {
      headers: { Authorization: `Bearer ${this.config.token}` },
      handshakeTimeout: 10_000,
      maxPayload: 1024 * 1024,
      followRedirects: false,
    });
    this.socket = socket;
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
    socket.on('message', (raw) => {
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        this.close();
        return;
      }
      if (!value || typeof value !== 'object') return;
      const pending = typeof value.echo === 'string' ? this.pending.get(value.echo) : undefined;
      if (pending) {
        this.pending.delete(value.echo as string);
        clearTimeout(pending.timer);
        if (value.status !== 'ok' || value.retcode !== 0)
          pending.reject(new Error('NapCat API rejected request'));
        else pending.resolve((value.data ?? {}) as Record<string, unknown>);
        return;
      }
      if (!this.onEvent || value.post_type !== 'message') return;
      if (!this.ready) {
        if (this.buffered.length >= 256) this.close();
        else this.buffered.push(value);
      } else this.enqueue(value);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const opened = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(new Error('NapCat connection unavailable'));
        };
        const cleanup = () => {
          socket.off('open', opened);
          socket.off('error', failed);
          socket.off('close', failed);
        };
        socket.once('open', opened);
        socket.once('error', failed);
        socket.once('close', failed);
      });
      const info = await this.call('get_login_info');
      if (String(info.user_id) !== this.config.selfId)
        throw new Error('NapCat logged-in QQ number does not match');
      this.ready = true;
      for (const event of this.buffered) this.enqueue(event);
      this.buffered = [];
      let alive = true;
      socket.on('pong', () => {
        alive = true;
      });
      this.heartbeat = setInterval(() => {
        if (!alive) {
          this.close();
          return;
        }
        alive = false;
        socket.ping();
      }, 30_000);
      this.heartbeat.unref?.();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private enqueue(event: unknown) {
    if (this.stopped) return;
    if (++this.queued > 256) {
      this.close();
      return;
    }
    this.queue = this.queue
      .then(async () => {
        if (!this.stopped) await this.onEvent?.(event);
      })
      .catch(() => this.close())
      .finally(() => {
        this.queued--;
      });
  }

  call(action: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || this.stopped)
      return Promise.reject(new Error('NapCat is disconnected'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error('NapCat API response timeout; delivery may be unknown'));
      }, 10_000);
      this.pending.set(echo, { resolve, reject, timer });
      socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(new Error('NapCat API connection lost; delivery may be unknown'));
      });
    });
  }

  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    clearInterval(this.heartbeat);
    this.socket?.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('NapCat connection closed; delivery may be unknown'));
    }
    this.pending.clear();
    this.buffered = [];
    this.resolveClosed();
  }
}
