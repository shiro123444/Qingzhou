// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CallbackDeliveryError } from '@/server/services/bot/callbackLedger';

import { botCallback } from '../botCallback';

const mockHandleCallback = vi.fn();

vi.mock('@/server/services/bot/BotCallbackService', () => ({
  BotCallbackService: vi.fn().mockImplementation(() => ({
    handleCallback: mockHandleCallback,
  })),
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn().mockResolvedValue({} as any),
}));

function buildContext(opts: { body?: unknown; jsonThrows?: boolean }) {
  const captures: Array<{ body: any; status: number }> = [];
  const ctx = {
    header: vi.fn(),
    json: (b: any, status = 200) => {
      captures.push({ body: b, status });
      return Response.json(b, { status });
    },
    req: {
      json: opts.jsonThrows
        ? async () => {
            throw new Error('bad json');
          }
        : async () => opts.body,
    },
  } as any;
  return { ctx, getCaptures: () => captures };
}

const validStepBody = {
  applicationId: 'app-1',
  platformThreadId: 'thread-1',
  progressMessageId: 'msg-1',
  type: 'step',
};

describe('botCallback handler', () => {
  beforeEach(() => {
    mockHandleCallback.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when JSON parsing throws', async () => {
    const { ctx } = buildContext({ jsonThrows: true });
    const res = await botCallback(ctx);
    expect(res.status).toBe(400);
    expect(mockHandleCallback).not.toHaveBeenCalled();
  });

  it.each([
    ['type', { ...validStepBody, type: undefined }],
    ['applicationId', { ...validStepBody, applicationId: undefined }],
    ['platformThreadId', { ...validStepBody, platformThreadId: undefined }],
  ])('returns 400 when required field %s is missing', async (_field, body) => {
    const { ctx, getCaptures } = buildContext({ body });
    const res = await botCallback(ctx);
    expect(res.status).toBe(400);
    expect(getCaptures()[0].body.error).toMatch(/Missing required fields/);
    expect(mockHandleCallback).not.toHaveBeenCalled();
  });

  it('returns 400 for unknown callback types', async () => {
    const { ctx, getCaptures } = buildContext({
      body: { ...validStepBody, type: 'unknown' },
    });
    const res = await botCallback(ctx);
    expect(res.status).toBe(400);
    expect(getCaptures()[0].body.error).toBe('Unknown callback type: unknown');
  });

  it('delegates to BotCallbackService and returns 200 on happy path', async () => {
    mockHandleCallback.mockResolvedValue({ status: 'delivered' });
    const { ctx, getCaptures } = buildContext({ body: validStepBody });

    const res = await botCallback(ctx);

    expect(res.status).toBe(200);
    expect(getCaptures()[0].body).toEqual({ status: 'delivered', success: true });
    expect(mockHandleCallback).toHaveBeenCalledWith(validStepBody);
  });

  it('accepts type=completion', async () => {
    mockHandleCallback.mockResolvedValue({ status: 'delivered' });
    const body = { ...validStepBody, type: 'completion' };
    const { ctx } = buildContext({ body });

    const res = await botCallback(ctx);
    expect(res.status).toBe(200);
    expect(mockHandleCallback).toHaveBeenCalledWith(body);
  });

  it('returns sanitized 500 when the service throws', async () => {
    mockHandleCallback.mockRejectedValue(new Error('service down'));
    const { ctx, getCaptures } = buildContext({ body: validStepBody });

    const res = await botCallback(ctx);

    expect(res.status).toBe(500);
    expect(getCaptures()[0].body).toEqual({
      retryable: true,
      status: 'callback_failed',
      success: false,
    });
  });
});

it.each([
  ['busy', 503, true],
  ['lease_lost', 503, true],
  ['backend_unavailable', 503, true],
  ['unknown_delivery', 409, false],
  ['payload_conflict', 409, false],
  ['invalid_callback', 400, false],
] as const)('exposes %s without leaking its cause', async (status, code, retryable) => {
  mockHandleCallback.mockRejectedValue(
    new CallbackDeliveryError(status, { cause: new Error('secret') }),
  );
  const { ctx, getCaptures } = buildContext({ body: validStepBody });
  const response = await botCallback(ctx);
  expect(response.status).toBe(code);
  expect(getCaptures()[0].body).toEqual({ retryable, status, success: false });
  if (retryable) expect(ctx.header).toHaveBeenCalledWith('Retry-After', '30');
});

it('returns 200 skip for a duplicate', async () => {
  mockHandleCallback.mockResolvedValue({ status: 'skipped' });
  const { ctx, getCaptures } = buildContext({ body: validStepBody });
  expect((await botCallback(ctx)).status).toBe(200);
  expect(getCaptures()[0].body.status).toBe('skipped');
});

it.each([null, [], 'text'])('rejects non-object JSON %j', async (body) => {
  expect((await botCallback(buildContext({ body }).ctx)).status).toBe(400);
});

it('reports a human-approval pause as skipped and still delegates resumed callbacks', async () => {
  mockHandleCallback.mockReset();
  mockHandleCallback
    .mockResolvedValueOnce({ status: 'skipped' })
    .mockResolvedValue({ status: 'delivered' });
  const pause = {
    ...validStepBody,
    operationId: 'paused-op',
    type: 'completion',
    reason: 'waiting_for_human',
  };
  const { ctx, getCaptures } = buildContext({ body: pause });
  expect((await botCallback(ctx)).status).toBe(200);
  expect(getCaptures()[0].body).toEqual({ status: 'skipped', success: true });
  const resumed = { ...pause, type: 'step', reason: undefined, stepIndex: 2 };
  expect((await botCallback(buildContext({ body: resumed }).ctx)).status).toBe(200);
  const completion = { ...pause, reason: 'completed' };
  expect((await botCallback(buildContext({ body: completion }).ctx)).status).toBe(200);
  expect(mockHandleCallback).toHaveBeenNthCalledWith(1, pause);
  expect(mockHandleCallback).toHaveBeenNthCalledWith(2, resumed);
  expect(mockHandleCallback).toHaveBeenNthCalledWith(3, completion);
});
