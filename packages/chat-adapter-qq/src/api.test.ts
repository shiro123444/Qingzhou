import { afterEach, describe, expect, it, vi } from 'vitest';

import { QQApiClient, QQApiError } from './api';
import type { QQStreamMessageRequest } from './types';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('QQ API endpoints', () => {
  const frame = (overrides: Partial<QQStreamMessageRequest> = {}): QQStreamMessageRequest => ({
    content_raw: 'First text',
    content_type: 'markdown',
    index: 0,
    input_mode: 'replace',
    input_state: 1,
    msg_id: 'inbound',
    msg_seq: 3,
    ...overrides,
  });

  it('sends cumulative C2C stream frames with one reply sequence and a terminal state', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ access_token: 'test-token', expires_in: 7200 }))
      .mockResolvedValueOnce(Response.json({ id: 'stream-1', timestamp: 'now' }))
      .mockResolvedValueOnce(Response.json({ id: 'stream-1', timestamp: 'later' }));
    const api = new QQApiClient('app', 'secret');
    const first = await api.sendC2CStreamMessage('target/id', frame());
    const terminal = frame({
      content_raw: 'First text and final text',
      input_state: 10,
      index: 1,
      stream_msg_id: first.id,
    });
    await api.sendC2CStreamMessage('target/id', terminal);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://api.bot.qq.com/v2/users/target%2Fid/stream_messages',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(frame()) }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      'https://api.bot.qq.com/v2/users/target%2Fid/stream_messages',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(terminal) }),
    );
  });

  it('rejects invalid or unanchored stream state before contacting QQ', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const api = new QQApiClient('app', 'secret');
    for (const invalid of [
      { msg_id: '' },
      { event_id: 'also-an-event' },
      { msg_seq: 0 },
      { index: -1 },
      { index: 1 },
      { stream_msg_id: 'unexpected-on-first-frame' },
      { content_raw: '' },
    ]) {
      await expect(api.sendC2CStreamMessage('target', frame(invalid))).rejects.toThrow(
        'Invalid QQ',
      );
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces business rejection and retry timing without exposing response text', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ access_token: 'test-token', expires_in: 7200 }))
      .mockResolvedValueOnce(
        Response.json(
          { code: 50002, message: 'private-provider-detail' },
          { status: 429, headers: { 'retry-after': '2' } },
        ),
      );
    const api = new QQApiClient('app', 'secret');
    const rejected = api.sendC2CStreamMessage('target', frame());
    await expect(rejected).rejects.toMatchObject({
      name: 'QQApiError',
      httpStatus: 429,
      code: 50002,
      retryAfterMs: 2000,
    });
    await expect(rejected).rejects.not.toThrow('private-provider-detail');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('treats a nonzero business code as rejection even with HTTP 200', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ access_token: 'test-token', expires_in: 7200 }))
      .mockResolvedValueOnce(Response.json({ code: 40034090, message: 'no capability' }));
    const api = new QQApiClient('app', 'secret');
    await expect(api.sendC2CStreamMessage('target', frame())).rejects.toBeInstanceOf(QQApiError);
  });

  it('does not retry or fall back after an unknown stream send outcome', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ access_token: 'test-token', expires_in: 7200 }))
      .mockRejectedValueOnce(new TypeError('connection interrupted'));
    const api = new QQApiClient('app', 'secret');
    await expect(api.sendC2CStreamMessage('target', frame())).rejects.toThrow(
      'connection interrupted',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('preserves an ambiguous malformed stream receipt instead of starting another message', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ access_token: 'test-token', expires_in: 7200 }))
      .mockResolvedValueOnce(Response.json({}));
    const api = new QQApiClient('app', 'secret');
    await expect(api.sendC2CStreamMessage('target', frame())).rejects.toThrow('message id');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['image/gif', 1],
    ['image/webp', 1],
    ['image/bmp', 1],
    ['video/mp4', 2],
    ['audio/silk', 3],
    ['audio/mpeg', 3],
    ['audio/wav', 3],
    ['audio/ogg', 3],
    ['application/pdf', 4],
    ['application/octet-stream', 4],
  ])(
    'uploads %s using its native QQ media type %i without making a visible send',
    async (mimeType, fileType) => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(Response.json({ access_token: 'test-token', expires_in: 7200 }))
        .mockResolvedValueOnce(Response.json({ file_info: 'media-info' }));
      await new QQApiClient('app', 'secret').uploadFile('c2c', 'target', {
        bytes: new Uint8Array([1, 2, 3]),
        filename: 'artifact',
        mimeType: String(mimeType),
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchSpy.mock.calls[1][1]!.body as string)).toMatchObject({
        file_type: fileType,
        srv_send_msg: false,
      });
    },
  );

  it.each(['group', 'c2c'] as const)(
    'uploads owned bytes privately before the separately sent %s file message',
    async (threadType) => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(Response.json({ access_token: 'test-token', expires_in: 7200 }))
        .mockResolvedValueOnce(Response.json({ file_info: 'uploaded-file-info' }))
        .mockResolvedValueOnce(Response.json({ id: 'media-reply' }));
      const api = new QQApiClient('app', 'secret');
      const info = await api.uploadFile(threadType, 'target', {
        bytes: new Uint8Array([1, 2, 3]),
        filename: 'formula.png',
        mimeType: 'image/png',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const prefix = threadType === 'group' ? 'groups' : 'users';
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        `https://api.bot.qq.com/v2/${prefix}/target/files`,
        expect.objectContaining({
          body: JSON.stringify({
            file_type: 1,
            file_data: 'AQID',
            file_name: 'formula.png',
            srv_send_msg: false,
          }),
        }),
      );
      await api.sendFile(threadType, 'target', info, { msgId: 'original', msgSeq: 3 });
      expect(fetchSpy).toHaveBeenNthCalledWith(
        3,
        `https://api.bot.qq.com/v2/${prefix}/target/messages`,
        expect.objectContaining({
          body: JSON.stringify({
            content: '',
            msg_type: 7,
            media: { file_info: info },
            msg_id: 'original',
            msg_seq: 3,
          }),
        }),
      );
    },
  );

  it('does not send anything for oversized bytes or a malformed upload receipt', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const api = new QQApiClient('app', 'secret');
    await expect(
      api.uploadFile('group', 'target', {
        bytes: new Uint8Array(10 * 1024 * 1024 + 1),
        filename: 'file.txt',
        mimeType: 'text/plain',
      }),
    ).rejects.toThrow('10 MiB');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy
      .mockResolvedValueOnce(Response.json({ access_token: 'test-token', expires_in: 7200 }))
      .mockResolvedValueOnce(Response.json({}));
    await expect(
      api.uploadFile('group', 'target', {
        bytes: new Uint8Array([1]),
        filename: 'file.txt',
        mimeType: 'text/plain',
      }),
    ).rejects.toThrow('file_info');
    expect(JSON.parse(fetchSpy.mock.calls[1][1]!.body as string)).toMatchObject({
      file_type: 4,
      srv_send_msg: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('authenticates separately and discovers the gateway through the unified API domain', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockResolvedValueOnce(Response.json({ access_token: 'test-access-token', expires_in: 7200 }))
      .mockResolvedValueOnce(Response.json({ url: 'wss://gateway.qq.com/' }));

    const client = new QQApiClient('test-app-id', 'test-app-secret');

    await expect(client.getGatewayUrl()).resolves.toEqual({ url: 'wss://gateway.qq.com/' });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'https://bots.qq.com/app/getAppAccessToken',
      expect.objectContaining({
        body: JSON.stringify({ appId: 'test-app-id', clientSecret: 'test-app-secret' }),
        method: 'POST',
      }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://api.bot.qq.com/gateway',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'QQBot test-access-token' }),
        method: 'GET',
      }),
    );
  });

  it('sends private and group replies through the unified domain using the cached token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockResolvedValueOnce(Response.json({ access_token: 'test-access-token', expires_in: 7200 }))
      .mockResolvedValueOnce(Response.json({ id: 'private-reply' }))
      .mockResolvedValueOnce(Response.json({ id: 'group-reply' }));

    const client = new QQApiClient('test-app-id', 'test-app-secret');

    await expect(
      client.sendC2CMessage('user-open-id', 'Private reply', {
        msgId: 'private-inbound',
        msgSeq: 1,
      }),
    ).resolves.toEqual({ id: 'private-reply' });
    await expect(
      client.sendGroupMessage('group-open-id', 'Group reply', {
        msgId: 'group-inbound',
        msgSeq: 2,
      }),
    ).resolves.toEqual({ id: 'group-reply' });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://api.bot.qq.com/v2/users/user-open-id/messages',
      expect.objectContaining({
        body: JSON.stringify({
          content: 'Private reply',
          msg_type: 0,
          msg_id: 'private-inbound',
          msg_seq: 1,
        }),
        method: 'POST',
      }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      'https://api.bot.qq.com/v2/groups/group-open-id/messages',
      expect.objectContaining({
        body: JSON.stringify({
          content: 'Group reply',
          msg_type: 0,
          msg_id: 'group-inbound',
          msg_seq: 2,
        }),
        method: 'POST',
      }),
    );
  });
});
