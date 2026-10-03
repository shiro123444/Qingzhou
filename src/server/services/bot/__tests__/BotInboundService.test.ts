// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BotInboundModel } from '@/database/models/botInbound';

import { BotInboundService, inboundExecution, InboundSessionBusy } from '../BotInboundService';
import { isInboundStopCommand } from '../inboundControl';
import { botSessionKey } from '../sessionScope';

const dispatch = vi.hoisted(() => vi.fn());
vi.mock('../index', () => ({
  getBotMessageRouter: () => ({ dispatchPersistedInbound: dispatch }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  dispatch.mockReset();
});
const db = {} as any;
const job = {
  id: 'a',
  leaseOwner: 'owner',
  leaseExpiresAt: new Date(Date.now() + 60_000),
  payload: '{}',
  attempts: 1,
} as any;

describe('durable incoming worker', () => {
  function prepare() {
    vi.spyOn(BotInboundModel.prototype, 'recover').mockResolvedValue(0);
    vi.spyOn(BotInboundModel.prototype, 'recoverTerminalSessions').mockResolvedValue(0);
    vi.spyOn(BotInboundModel.prototype, 'claim').mockResolvedValueOnce(job).mockResolvedValue(null);
    vi.spyOn(BotInboundModel.prototype, 'beginDispatch').mockResolvedValue(true);
    vi.spyOn(BotInboundModel.prototype, 'finish').mockResolvedValue(true);
    return vi.spyOn(BotInboundModel.prototype, 'fail').mockResolvedValue(undefined);
  }
  it('makes rotating context tokens irrelevant to duplicate intent identity', async () => {
    const enqueue = vi
      .spyOn(BotInboundModel.prototype, 'enqueue')
      .mockResolvedValue({ id: 'a', status: 'pending' });
    const service = new BotInboundService(db);
    await service.accept(
      'u',
      'wechat',
      'app',
      { text: 'hello', context_token: 'one' },
      'event',
      'thread',
    );
    await service.accept(
      'u',
      'wechat',
      'app',
      { context_token: 'two', text: 'hello' },
      'event',
      'thread',
    );
    const [first, next] = enqueue.mock.calls.map(([input]) => input);
    expect(next.id).toBe(first.id);
    expect(next.payloadHash).toBe(first.payloadHash);
    expect(next.payload).not.toBe(first.payload);
    await service.accept('u', 'wechat', 'other-app', {}, 'event', 'thread');
    expect(enqueue.mock.calls[2][0].id).not.toBe(first.id);
  });
  it('records completion only after replay settles', async () => {
    prepare();
    dispatch.mockImplementation(async () => {
      inboundExecution.getStore()?.assertHeld();
    });
    expect(await new BotInboundService(db).sweep()).toMatchObject({ processed: 1, deferred: 0 });
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(BotInboundModel.prototype.finish).mock.invocationCallOrder[0],
    );
  });
  it('quarantines a dispatch error instead of automatically executing tools again', async () => {
    const fail = prepare();
    dispatch.mockRejectedValueOnce(new Error('lost after agent startup'));
    expect(await new BotInboundService(db).sweep()).toMatchObject({ processed: 0, deferred: 1 });
    expect(fail).toHaveBeenCalledWith(job, true, 'inbound_failed');
    expect(BotInboundModel.prototype.finish).not.toHaveBeenCalled();
  });
  it('defers competing startup without classifying it as uncertain execution', async () => {
    const fail = prepare();
    dispatch.mockRejectedValueOnce(new InboundSessionBusy());
    await new BotInboundService(db).sweep();
    expect(fail).toHaveBeenCalledWith(job, false, 'session_busy');
  });
  it('does not dispatch after ownership is lost and supports a dedicated control lane', async () => {
    const fail = prepare();
    vi.mocked(BotInboundModel.prototype.beginDispatch).mockResolvedValueOnce(false);
    await new BotInboundService(db).sweep({ controlsOnly: true });
    expect(BotInboundModel.prototype.claim).toHaveBeenCalledWith(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(job, false, 'inbound_failed');
  });
});

describe('session scope and stop classification', () => {
  it.each(['answer token A', 'confirm token', 'reject token', 'status'])(
    'dispatches /%s through the control lane while a run is paused',
    (command) => {
      expect(
        isInboundStopCommand('wechat', { item_list: [{ text_item: { text: `/${command}` } }] }),
      ).toBe(true);
      expect(
        isInboundStopCommand('wechat', {
          item_list: [{ text_item: { text: `Explain /${command}` } }],
        }),
      ).toBe(false);
    },
  );
  it('binds account, application, installation and platform to the same thread', () => {
    const context = { platform: 'qq', applicationId: 'app', platformThreadId: 'thread' };
    const key = botSessionKey('u', context);
    for (const other of [
      { ...context, applicationId: 'other' },
      { ...context, platform: 'wechat' },
      { ...context, messengerInstallationKey: 'qq:tenant' },
    ])
      expect(botSessionKey('u', other)).not.toBe(key);
    expect(botSessionKey('other-user', context)).not.toBe(key);
  });
  it('promotes only exact stop commands, leaving sender authorization to the router', () => {
    expect(isInboundStopCommand('qq', { d: { content: '<@!bot> /stop' } })).toBe(true);
    expect(isInboundStopCommand('wechat', { item_list: [{ text_item: { text: '/stop' } }] })).toBe(
      true,
    );
    expect(
      isInboundStopCommand('feishu', { event: { message: { content: '{"text":"/stop"}' } } }),
    ).toBe(true);
    expect(isInboundStopCommand('qq', { d: { content: 'Explain /stop' } })).toBe(false);
    expect(isInboundStopCommand('feishu', { event: { message: { content: 'invalid' } } })).toBe(
      false,
    );
  });
});
