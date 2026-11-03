import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeishuWSConnection } from './gateway';

// ---- Mock @larksuiteoapi/node-sdk ----

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn();
let capturedEventHandlers: Record<string, (...args: any[]) => any> = {};

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockEventDispatcher {
    register(handles: Record<string, (...args: any[]) => any>) {
      capturedEventHandlers = { ...capturedEventHandlers, ...handles };
      return this;
    }
  }

  class MockWSClient {
    close = mockClose;
    start = mockStart;
    constructor() {}
  }

  return {
    Domain: { Feishu: 0, Lark: 1 },
    EventDispatcher: MockEventDispatcher,
    LoggerLevel: { info: 3 },
    WSClient: MockWSClient,
  };
});

// ---- Tests ----

describe('FeishuWSConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEventHandlers = {};
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function createConnection() {
    return new FeishuWSConnection({
      appId: 'cli_test',
      appSecret: 'test_secret',
      domain: 'feishu',
      webhookUrl: 'http://localhost:3000/api/agent/webhooks/feishu/test_app',
    });
  }

  describe('start', () => {
    it('should call WSClient.start with EventDispatcher', async () => {
      const conn = createConnection();
      await conn.start();

      expect(mockStart).toHaveBeenCalledWith(
        expect.objectContaining({ eventDispatcher: expect.any(Object) }),
      );
    });

    it('should register im.message.receive_v1 handler', async () => {
      const conn = createConnection();
      await conn.start();

      expect(capturedEventHandlers['im.message.receive_v1']).toBeTypeOf('function');
    });
  });

  describe('event forwarding', () => {
    it('registers and forwards authenticated card callbacks before acknowledging the click', async () => {
      const conn = createConnection();
      await conn.start();
      const event = {
        action: {
          value: {
            qingzhouAction: 'confirm',
            token: 'a123456789bc',
            platformThreadId: 'feishu:p2p:oc_chat',
          },
        },
        context: { open_chat_id: 'oc_chat', open_message_id: 'om_card' },
        operator: { open_id: 'ou_sender' },
      };
      expect(await capturedEventHandlers['card.action.trigger'](event)).toMatchObject({
        toast: { type: 'info' },
      });
      const request = vi.mocked(fetch).mock.calls[0][1]!;
      expect(JSON.parse(request.body as string)).toMatchObject({
        event,
        header: { app_id: 'cli_test', event_type: 'card.action.trigger' },
      });
      await conn.close();
      await expect(capturedEventHandlers['card.action.trigger'](event)).rejects.toThrow('closing');
    });

    it('does not acknowledge a card action whose durable forward was rejected', async () => {
      const conn = createConnection();
      await conn.start();
      vi.mocked(fetch).mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
      await expect(capturedEventHandlers['card.action.trigger']({})).rejects.toThrow('HTTP 503');
      await conn.close();
    });

    it('should forward im.message.receive_v1 events to webhook URL', async () => {
      const conn = createConnection();
      await conn.start();

      const eventData = {
        message: {
          chat_id: 'oc_test',
          content: '{"text":"hello"}',
          message_type: 'text',
        },
        sender: { sender_id: { open_id: 'ou_test' } },
      };

      await capturedEventHandlers['im.message.receive_v1'](eventData);

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/agent/webhooks/feishu/test_app',
        expect.objectContaining({
          body: expect.any(String),
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          redirect: 'error',
          method: 'POST',
        }),
      );

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(fetchCall[1]!.body as string);
      expect(body.schema).toBe('2.0');
      expect(body.header.event_type).toBe('im.message.receive_v1');
      expect(body.event).toEqual(eventData);
    });
  });

  describe('close', () => {
    it('waits for accepted forwards and rejects late SDK events during drain', async () => {
      const conn = createConnection();
      await conn.start();
      let releaseForward!: (value: Response) => void;
      vi.mocked(fetch).mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseForward = resolve;
          }),
      );
      const handler = capturedEventHandlers['im.message.receive_v1'];
      const accepted = handler({ message: { message_id: 'pending' } });
      let closed = false;
      const draining = conn.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      await expect(handler({ message: { message_id: 'late' } })).rejects.toThrow('closing');
      expect(fetch).toHaveBeenCalledTimes(1);
      releaseForward(new Response(null, { status: 202 }));
      await Promise.all([accepted, draining]);
      expect(closed).toBe(true);
    });

    it('should call wsClient.close()', async () => {
      const conn = createConnection();
      await conn.start();

      conn.close();
      expect(mockClose).toHaveBeenCalledWith({ force: true });
    });

    it('should be safe to call close() without starting', () => {
      const conn = createConnection();
      conn.close(); // Should not throw
    });
  });
});
