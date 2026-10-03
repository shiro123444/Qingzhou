// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BotInboundModel } from '@/database/models/botInbound';

import { BotInteractionService } from '../BotInteractionService';

const resume = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: 'scheduled' }));
vi.mock('@/server/services/agentRuntime/AgentRuntimeService', () => ({
  AgentRuntimeService: class {
    processHumanIntervention = resume;
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  resume.mockClear();
});
const scope = { platform: 'wechat', applicationId: 'bot', platformThreadId: 'wechat:sender' };

describe('channel human interaction authorization', () => {
  function prepare(overrides: any = {}) {
    resume.mockResolvedValue({ messageId: 'scheduled' });
    const returning = vi.fn().mockResolvedValue([{ id: 'tool-msg' }]);
    const where = vi.fn().mockReturnValue({ returning });
    const update = vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where }) });
    const service = new BotInteractionService({ update } as any, 'account');
    vi.spyOn(BotInboundModel.prototype, 'getSession').mockResolvedValue({
      operationId: 'op',
    } as any);
    const pending = {
      token: 'token',
      row: { updatedAt: new Date('2026-10-01T02:00:00Z') },
      isQuestion: true,
      args: { question: 'Choose?' },
      messageId: 'tool-msg',
      tool: { id: 'tool-call', identifier: 'qingzhou-system-capabilities', apiName: 'ask' },
      state: {
        stepCount: 3,
        metadata: { botContext: { ...scope, senderExternalUserId: 'sender', isOwner: true } },
      },
      ...overrides,
    };
    vi.spyOn(service, 'pending').mockResolvedValue(pending as any);
    return { service, update, returning, pending };
  }
  it.each([
    ['intruder', scope, 'token A'],
    ['sender', { ...scope, applicationId: 'other' }, 'token A'],
    ['sender', { ...scope, platformThreadId: 'wechat:other' }, 'token A'],
    ['sender', scope, 'stale A'],
  ])(
    'rejects wrong sender, destination or stale token before scheduling',
    async (sender, target, input) => {
      const { service, update } = prepare();
      await expect(service.respond(target, sender, 'answer', input)).rejects.toThrow();
      expect(update).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    },
  );
  it('answers only the server-stored pending tool and schedules the same operation', async () => {
    const { service, pending } = prepare();
    await expect(service.respond(scope, 'sender', 'answer', 'token A')).resolves.toBe('op');
    expect(resume).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operationId: 'op',
        stepIndex: 3,
        action: 'input',
        toolMessageId: 'tool-msg',
        humanInput: { response: { text: 'A' }, toolCallId: pending.tool.id },
      }),
    );
  });
  it('blocks replay after another command has claimed the decision', async () => {
    const { service, returning } = prepare();
    returning.mockResolvedValue([]);
    await expect(service.respond(scope, 'sender', 'answer', 'token A')).rejects.toThrow('已提交');
    expect(resume).not.toHaveBeenCalled();
  });
  it('accepts the original sender’s natural answer received after the question was paused', async () => {
    const { service } = prepare();
    await expect(
      service.respondToMessage(scope, 'sender', 'A', new Date('2026-10-01T02:00:01Z')),
    ).resolves.toBe('op');
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ humanInput: { response: { text: 'A' }, toolCallId: 'tool-call' } }),
    );
  });
  it.each([
    ['sender', 'A', new Date('2026-10-01T01:59:59Z'), true],
    ['sender', 'A', undefined, true],
    ['intruder', 'A', new Date('2026-10-01T02:00:01Z'), true],
    ['sender', 'yes', new Date('2026-10-01T02:00:01Z'), false],
    ['sender', '/stop', new Date('2026-10-01T02:00:01Z'), true],
  ])(
    'does not treat old, unbound, other-sender or approval messages as natural answers',
    async (author, text, time, isQuestion) => {
      const { service, update } = prepare({ isQuestion });
      await expect(service.respondToMessage(scope, author, text, time)).resolves.toBeUndefined();
      expect(update).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    },
  );
  it.each(['confirm', 'reject'] as const)(
    'uses the original pending tool for an owner’s %s decision',
    async (action) => {
      const { service, pending } = prepare({ isQuestion: false });
      await service.respond(scope, 'sender', action, 'token');
      expect(resume).toHaveBeenCalledWith(
        expect.objectContaining({
          action: action === 'confirm' ? 'approve' : 'reject',
          approvedToolCall: action === 'confirm' ? pending.tool : undefined,
          rejectionReason: action === 'reject' ? '用户在渠道拒绝此次工具调用' : undefined,
        }),
      );
    },
  );
  it('does not let a paired non-owner approve tools', async () => {
    const { service, pending, update } = prepare({ isQuestion: false });
    pending.state.metadata.botContext.isOwner = false;
    await expect(service.respond(scope, 'sender', 'confirm', 'token')).rejects.toThrow('负责人');
    expect(update).not.toHaveBeenCalled();
  });
  it('shows the target of an approval while hiding credentials and URL authorization', async () => {
    const { service } = prepare({
      isQuestion: false,
      args: {
        path: '/tmp/report.txt',
        credentials: { password: 'private-pass' },
        url: 'https://name:pass@example.com/file?token=private-query',
        input: 'Bearer private-bearer',
      },
    });
    const notice = await service.describe('op');
    expect(notice).toContain('/tmp/report.txt');
    for (const secret of ['private-pass', 'name:pass', 'private-query', 'private-bearer'])
      expect(notice).not.toContain(secret);
    expect(notice).toContain('/confirm token');
  });
  it('validates form field values before persisting a decision', async () => {
    const { service, update } = prepare({
      args: {
        question: {
          fields: [{ key: 'choice', kind: 'select', required: true, options: [{ value: 'A' }] }],
        },
      },
    });
    await expect(
      service.respond(scope, 'sender', 'answer', 'token {"choice":"B"}'),
    ).rejects.toThrow('选项无效');
    expect(update).not.toHaveBeenCalled();
    await service.respond(scope, 'sender', 'answer', 'token {"choice":"A"}');
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({
        humanInput: { response: { choice: 'A' }, toolCallId: 'tool-call' },
      }),
    );
  });
});
