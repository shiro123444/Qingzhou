// @vitest-environment node
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import { isInboundStopCommand } from '../../inboundControl';
import { signGatewayRequest } from '../../security/gatewayAuth';
import { NapCatAdapter } from './adapter';
import { NapCatClient, NapCatClientFactory } from './client';
import { OneBotConnection, validateOneBotConfig } from './connection';
import { parseOneBotEvent } from './protocol';

const event = {
  post_type: 'message',
  message_type: 'group',
  self_id: 123456,
  user_id: 234567,
  group_id: 345678,
  message_id: -123,
  time: 1794182400,
  message: [{ type: 'text', data: { text: '今天完成接口联调' } }],
};
const config = {
  platform: 'napcat',
  applicationId: '123456',
  credentials: { accessToken: 'test-token' },
  settings: {
    websocketUrl: 'ws://127.0.0.1:3001/',
    groupPolicy: 'allowlist',
    groupAllowFrom: [{ id: '345678' }],
  },
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
});

async function server(account = 123456) {
  const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  const ws = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: (info: { req: IncomingMessage }) =>
      info.req.headers.authorization === 'Bearer test-token',
  });
  cleanups.push(() => {
    ws.clients.forEach((client) => client.terminate());
    ws.close();
  });
  ws.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      calls.push(request);
      socket.send(
        JSON.stringify({
          echo: request.echo,
          retcode: 0,
          status: 'ok',
          data: request.action === 'get_login_info' ? { user_id: account } : { message_id: 777 },
        }),
      );
    });
    // Event deliberately races login verification; it must be held until self_id is checked.
    socket.send(JSON.stringify(event));
  });
  await new Promise<void>((resolve) => ws.on('listening', resolve));
  return { ws, calls, url: `ws://127.0.0.1:${(ws.address() as AddressInfo).port}/` };
}

describe('NapCat OneBot transport', () => {
  it('forwards authenticated receipts, reconnects after a dropped socket and stops its child lifecycle', async () => {
    const fixture = await server();
    const persist = vi.fn(async () => {});
    const provider = { ...config, settings: { ...config.settings, websocketUrl: fixture.url } };
    const adapter = new NapCatAdapter(provider, { persistVerifiedWebhook: persist }, vi.fn());
    const forwarding = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url, options) =>
        adapter.handleWebhook(new Request(String(url), options)),
      );
    const client = new NapCatClient(provider, {
      appUrl: 'http://localhost',
      updateRuntimeStatus: vi.fn().mockResolvedValue({}),
      assertConnectionHeld: vi.fn(),
    });
    try {
      await client.start();
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
      fixture.ws.clients.forEach((socket) => socket.terminate());
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2), { timeout: 4000 });
      await client.stop();
      await vi.waitFor(() => expect(fixture.ws.clients.size).toBe(0));
      expect(forwarding).toHaveBeenCalledTimes(2);
      expect(fixture.calls.every((call) => call.action === 'get_login_info')).toBe(true);
    } finally {
      await client.stop();
    }
  });

  it('validates the logged-in account before releasing events and closes cleanly', async () => {
    const fixture = await server();
    const events = vi.fn(async () => {});
    const connection = new OneBotConnection(
      { selfId: '123456', token: 'test-token', url: fixture.url },
      events,
    );
    cleanups.push(() => connection.close());
    await connection.connect();
    await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(1));
    connection.close();
    await connection.closed;
    expect(connection.isConnected).toBe(false);
    await expect(connection.call('send_group_msg')).rejects.toThrow('disconnected');
  });

  it('rejects account mismatches and wrong tokens without delivering buffered events', async () => {
    const fixture = await server(999999);
    const events = vi.fn(async () => {});
    const connection = new OneBotConnection(
      { selfId: '123456', token: 'test-token', url: fixture.url },
      events,
    );
    await expect(connection.connect()).rejects.toThrow('does not match');
    expect(events).not.toHaveBeenCalled();
    const validation = await new NapCatClientFactory().validateCredentials(
      { accessToken: 'wrong' },
      { websocketUrl: fixture.url },
      '123456',
    );
    expect(validation.valid).toBe(false);
  });

  it('sends proactive group text once and never interprets generated CQ codes as actions', async () => {
    const fixture = await server();
    const client = new NapCatClient({ ...config, settings: { websocketUrl: fixture.url } }, {});
    await client.getMessenger('napcat:group:345678').createMessage('摘要 [CQ:at,qq=all]');
    expect(fixture.calls.filter((call) => call.action === 'send_group_msg')).toEqual([
      expect.objectContaining({
        params: {
          group_id: '345678',
          message: [{ type: 'text', data: { text: '摘要 [CQ:at,qq=all]' } }],
        },
      }),
    ]);
    await expect(
      client.getMessenger('qq:group:345678').createMessage('wrong destination'),
    ).rejects.toThrow('Invalid');
  });

  it('authenticates forwarded events before durable receipt and routes mentions explicitly', async () => {
    const persist = vi.fn(async () => {});
    const adapter = new NapCatAdapter(config, { persistVerifiedWebhook: persist }, vi.fn());
    const url = 'http://localhost/api/agent/webhooks/napcat/123456';
    const body = JSON.stringify(event);
    expect((await adapter.handleWebhook(new Request(url, { method: 'POST', body }))).status).toBe(
      401,
    );
    expect(persist).not.toHaveBeenCalled();
    const request = () =>
      new Request(
        url,
        signGatewayRequest({
          applicationId: '123456',
          platform: 'napcat',
          secret: 'test-token',
          url,
          body,
        }),
      );
    expect((await adapter.handleWebhook(request())).status).toBe(202);
    expect(persist).toHaveBeenCalledWith(
      expect.any(Object),
      'napcat:group:345678:-123',
      'napcat:group:345678',
    );
    const parsed = parseOneBotEvent({
      ...event,
      message: [
        { type: 'at', data: { qq: '123456' } },
        { type: 'text', data: { text: ' /stop' } },
      ],
    })!;
    expect(adapter.parseMessage(parsed.event).isMention).toBe(true);
    expect(isInboundStopCommand('napcat', parsed.event)).toBe(true);
    expect(parseOneBotEvent({ ...event, user_id: event.self_id })).toBeNull();
    expect(parseOneBotEvent({ ...event, message: '[CQ:at,qq=123456] forged' })).toBeNull();
  });

  it('blocks credentials in URLs and plaintext remote connections', () => {
    for (const url of [
      'ws://remote.test/',
      'wss://user:pass@remote.test/',
      'ws://localhost/?access_token=secret',
      'https://localhost/',
    ])
      expect(() => validateOneBotConfig({ url, token: 'test', selfId: '123456' })).toThrow();
  });

  it('does not persist unselected groups or private conversations of the personal account', async () => {
    const persist = vi.fn(async () => {});
    const adapter = new NapCatAdapter(config, { persistVerifiedWebhook: persist }, vi.fn());
    await adapter.dispatchVerifiedWebhook({ ...event, group_id: 999999 }, undefined, true);
    await adapter.dispatchVerifiedWebhook({ ...event, message_type: 'private' }, undefined, true);
    const defaults = new NapCatAdapter(
      { ...config, settings: {} },
      { persistVerifiedWebhook: persist },
      vi.fn(),
    );
    await defaults.dispatchVerifiedWebhook(event, undefined, true);
    expect(persist).not.toHaveBeenCalled();
  });
});
