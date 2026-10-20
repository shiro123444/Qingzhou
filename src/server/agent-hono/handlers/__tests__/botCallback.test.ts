// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BotDeliveryConflict } from '@/database/models/botDelivery';
import { MAX_CALLBACK_BYTES } from '@/server/services/bot/deliveryEnvelope';

import { botCallback } from '../botCallback';

const { accept, wake } = vi.hoisted(() => ({ accept: vi.fn(), wake: vi.fn() }));

vi.mock('@/server/services/bot/BotDeliveryService', () => ({
  BotDeliveryService: vi.fn().mockImplementation(() => ({ accept })),
}));
vi.mock('@/server/services/bot/deliveryWake', () => ({ wakeBotDelivery: wake }));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn().mockResolvedValue({}) }));

function context(body: unknown, raw = JSON.stringify(body)) {
  return {
    header: vi.fn(),
    json: (value: unknown, status = 200) => Response.json(value, { status }),
    req: { text: vi.fn().mockResolvedValue(raw) },
  } as any;
}

const step = {
  applicationId: 'app-1',
  operationId: 'op-1',
  platformThreadId: 'qq:group:thread-1',
  progressMessageId: 'msg-1',
  stepIndex: 1,
  type: 'step',
  userId: 'user-1',
};

describe('botCallback durable receipt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accept.mockReset().mockResolvedValue({ id: 'receipt-1', status: 'pending' });
  });

  it('rejects invalid JSON before touching the receipt store', async () => {
    const response = await botCallback(context(undefined, '{'));
    expect(response.status).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  });

  it('bounds the raw callback before parsing or persisting it', async () => {
    const response = await botCallback(context({}, 'x'.repeat(MAX_CALLBACK_BYTES + 1)));
    expect(response.status).toBe(413);
    expect(accept).not.toHaveBeenCalled();
  });

  it.each(['type', 'applicationId', 'platformThreadId', 'operationId', 'userId', 'stepIndex'])(
    'rejects a missing %s before touching the receipt store',
    async (key) => {
      expect((await botCallback(context({ ...step, [key]: undefined }))).status).toBe(400);
      expect(accept).not.toHaveBeenCalled();
    },
  );

  it.each([null, [], 'text', { ...step, type: 'unknown' }])(
    'rejects invalid payload %j',
    async (body) => {
      expect((await botCallback(context(body))).status).toBe(400);
      expect(accept).not.toHaveBeenCalled();
    },
  );

  it.each(['pending', 'running'])(
    'acknowledges SQL receipt %s and wakes recovery',
    async (status) => {
      accept.mockResolvedValue({ id: 'receipt-1', status });
      const response = await botCallback(context(step));
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        deliveryStatus: status,
        receiptId: 'receipt-1',
        status: 'accepted',
        success: true,
      });
      expect(accept).toHaveBeenCalledWith(step);
      expect(wake).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['delivered', 'unknown_delivery', 'dead'])(
    'preserves existing %s receipt without waking a send',
    async (status) => {
      accept.mockResolvedValue({ id: 'receipt-1', status });
      const response = await botCallback(context(step));
      expect(response.status).toBe(202);
      expect((await response.json()).deliveryStatus).toBe(status);
      expect(wake).not.toHaveBeenCalled();
    },
  );

  it('accepts completion without a step index', async () => {
    const body = { ...step, stepIndex: undefined, type: 'completion' };
    expect((await botCallback(context(body))).status).toBe(202);
    expect(accept).toHaveBeenCalledWith(JSON.parse(JSON.stringify(body)));
  });

  it('returns a sanitized retryable failure when SQL receipt is unavailable', async () => {
    accept.mockRejectedValue(new Error('database password=secret'));
    const ctx = context(step);
    const response = await botCallback(ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'receipt_unavailable', success: false });
    expect(ctx.header).toHaveBeenCalledWith('Retry-After', '10');
    expect(wake).not.toHaveBeenCalled();
  });

  it('rejects conflicting intent without waking a send', async () => {
    accept.mockRejectedValue(new BotDeliveryConflict('payload_conflict'));
    const response = await botCallback(context(step));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: 'payload_conflict', success: false });
    expect(wake).not.toHaveBeenCalled();
  });

  it('acknowledges a paused execution as skipped and accepts the resumed intent', async () => {
    accept.mockResolvedValueOnce({ status: 'skipped' });
    const pause = { ...step, type: 'completion', reason: 'waiting_for_human' };
    const response = await botCallback(context(pause));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'skipped', success: true });
    expect(wake).not.toHaveBeenCalled();
    expect((await botCallback(context({ ...step, stepIndex: 2 }))).status).toBe(202);
    expect(wake).toHaveBeenCalledTimes(1);
  });
});
