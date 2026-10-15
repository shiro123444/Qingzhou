import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PresentationConversationCapability,
  PresentationConversationCommand,
} from './conversation-capability';
import { FilePresentationStorage } from './file-storage';
import { PresentationPlanningSessions } from './planning-session';

const roots: string[] = [];
const managers: PresentationPlanningSessions[] = [];
const scope = { userId: 'owner', sessionId: 'workspace' };
const command: PresentationConversationCommand = {
  operation: 'turn',
  threadId: 'creation-1',
  messages: [{ role: 'user', content: '沿用资料做18页报告' }],
  tools: { search: false, skillIds: [] },
};
const completed = {
  phase: 'outline' as const,
  brief: { topic: '报告', research: '已读取的资料' },
  message: '大纲已保存',
  slides: [{ id: 'slide-1', title: '招生与科研', keyPoints: ['保留真实数据'] }],
};
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.dispose()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function storage() {
  const root = await mkdtemp(join(tmpdir(), 'qingzhou-planning-'));
  roots.push(root);
  return new FilePresentationStorage(root);
}
function create(
  repo: FilePresentationStorage,
  execute: PresentationConversationCapability['execute'],
  timeout?: number,
) {
  const manager = new PresentationPlanningSessions(
    repo,
    { id: 'presentation.conversation', execute },
    async () => ({ context: {} }),
    undefined,
    timeout,
  );
  managers.push(manager);
  return manager;
}
async function waitForState(manager: PresentationPlanningSessions, state: string) {
  await vi.waitFor(
    async () => expect((await manager.read(scope, command.threadId, false))?.state).toBe(state),
    { timeout: 10_000 },
  );
  return (await manager.read(scope, command.threadId, false))!;
}

describe('durable planning collaboration', () => {
  it('stores a checkpoint before asking, defers without execution and continues with the user answer', async () => {
    const repo = await storage();
    const execute = vi.fn<PresentationConversationCapability['execute']>(
      async (_command, context) => {
        await context.onCheckpoint?.({
          brief: { topic: '已确认主题', research: '已读取资料与模板' },
        });
        throw Object.assign(new Error('private provider response'), {
          code: 'CHAT_EMPTY_RESPONSE',
        });
      },
    );
    const manager = create(repo, execute);
    await manager.presenceUpdate(scope, command.threadId, {
      tabId: 'tab',
      visible: true,
      focused: true,
    });
    await manager.start(scope, command, 'turn-1');
    const paused = await waitForState(manager, 'waiting_input');
    expect(execute).toHaveBeenCalledOnce();
    expect(paused.checkpoint?.brief.research).toBe('已读取资料与模板');
    expect(JSON.stringify(paused)).not.toContain('private provider response');
    const question = paused.collaboration.decisions[0];
    await manager.answer(scope, command.threadId, {
      decisionId: question.id,
      requestId: 'later',
      action: 'defer',
    });
    expect(execute).toHaveBeenCalledOnce();
    execute.mockImplementation(async (input) => {
      expect(input.brief?.research).toBe('已读取资料与模板');
      expect(input.messages.at(-1)?.content).toBe('需要两张同风格原创插画');
      return completed;
    });
    const answer = {
      decisionId: question.id,
      requestId: 'answer-1',
      action: 'revise' as const,
      content: '需要两张同风格原创插画',
    };
    await manager.answer(scope, command.threadId, answer);
    await waitForState(manager, 'completed');
    await manager.answer(scope, command.threadId, answer);
    expect(execute).toHaveBeenCalledTimes(2);
    await expect(
      manager.answer(scope, command.threadId, { ...answer, content: 'different' }),
    ).rejects.toMatchObject({ code: 'PRESENTATION_CONFLICT' });
    expect(
      await manager.read({ userId: 'someone-else', sessionId: 'workspace' }, command.threadId),
    ).toBeNull();
  }, 20_000);

  it('does not let a second runtime take over a living worker or replace its command', async () => {
    const repo = await storage();
    const execute = vi.fn<PresentationConversationCapability['execute']>(
      async (_input, context) =>
        new Promise((resolve, reject) => {
          context.signal!.addEventListener('abort', () => reject(context.signal!.reason), {
            once: true,
          });
        }),
    );
    const first = create(repo, execute);
    const second = create(repo, execute);
    await first.start(scope, command, 'same-id');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect((await second.read(scope, command.threadId))?.state).toBe('running');
    await second.start(scope, command, 'same-id');
    await expect(
      second.start(
        scope,
        { ...command, messages: [{ role: 'user', content: '另一个要求' }] },
        'new-id',
      ),
    ).rejects.toMatchObject({ code: 'PRESENTATION_CONFLICT' });
    expect(execute).toHaveBeenCalledOnce();
    expect((await repo.getPlanningSession(scope, command.threadId))?.command.messages).toEqual(
      command.messages,
    );
  }, 20_000);

  it('resumes from the persisted checkpoint after service disposal without a browser turn', async () => {
    const repo = await storage();
    const old = create(repo, async (_input, context) => {
      await context.onCheckpoint?.({ brief: { topic: '保存主题', research: 'read-document-7' } });
      return new Promise((_resolve, reject) =>
        context.signal!.addEventListener('abort', () => reject(context.signal!.reason), {
          once: true,
        }),
      );
    });
    await old.start(scope, command, 'turn-before-restart');
    await vi.waitFor(async () =>
      expect((await old.read(scope, command.threadId, false))?.checkpoint?.brief.research).toBe(
        'read-document-7',
      ),
    );
    await old.dispose();
    expect((await repo.getPlanningSession(scope, command.threadId))?.state).toBe('queued');
    const resumed = vi.fn<PresentationConversationCapability['execute']>(async (input) => {
      expect(input.brief?.research).toBe('read-document-7');
      return completed;
    });
    const next = create(repo, resumed);
    for (const candidate of await repo.listPlanningRecoveryCandidates())
      await next.recover(candidate.scope, candidate.threadId);
    expect((await waitForState(next, 'completed')).recoveryAttempts).toBe(1);
    expect(resumed).toHaveBeenCalledOnce();
  }, 20_000);

  it('keeps an unanswered model question across reload and rejects blank or stale answers', async () => {
    const repo = await storage();
    const manager = create(repo, async () => ({
      phase: 'intake',
      brief: { topic: '报告' },
      message: '面向谁汇报？',
      questionId: 'audience-1',
      question: { prompt: '请选择受众' },
    }));
    await manager.start(scope, command, 'ask-audience');
    const session = await waitForState(manager, 'waiting_input');
    const next = create(repo, async () => completed);
    expect((await next.read(scope, command.threadId))?.collaboration.decisions[0].detail).toBe(
      '请选择受众',
    );
    await expect(
      next.answer(scope, command.threadId, {
        decisionId: 'audience-1',
        requestId: 'blank',
        action: 'revise',
        content: ' ',
      }),
    ).rejects.toMatchObject({ code: 'PRESENTATION_INVALID' });
    await expect(
      next.answer(scope, command.threadId, {
        decisionId: 'old-question',
        requestId: 'stale',
        action: 'retry',
      }),
    ).rejects.toMatchObject({ code: 'PRESENTATION_NOT_FOUND' });
    expect(session.collaboration.decisions[0].status).toBe('pending');
  }, 20_000);

  it('bounds background empty-response retries and converts timeout into an actionable question', async () => {
    const repo = await storage();
    const failing = vi.fn<PresentationConversationCapability['execute']>(async () => {
      throw Object.assign(new Error('empty'), { code: 'CHAT_EMPTY_RESPONSE' });
    });
    const manager = create(repo, failing);
    await manager.start(scope, command, 'empty-turn');
    expect((await waitForState(manager, 'waiting_input')).collaboration.automaticAttempts).toBe(2);
    expect(failing).toHaveBeenCalledTimes(3);
    const timeoutCommand = { ...command, threadId: 'timeout-thread' };
    const timed = create(
      repo,
      async (_input, context) =>
        new Promise((_resolve, reject) =>
          context.signal!.addEventListener('abort', () => reject(context.signal!.reason), {
            once: true,
          }),
        ),
      50,
    );
    await timed.start(scope, timeoutCommand, 'timeout-turn');
    await vi.waitFor(
      async () =>
        expect((await timed.read(scope, timeoutCommand.threadId, false))?.state).toBe(
          'waiting_input',
        ),
      { timeout: 10_000 },
    );
    expect(
      (await timed.read(scope, timeoutCommand.threadId, false))?.collaboration.lastErrorCode,
    ).toBe('CHAT_TIMEOUT');
  }, 20_000);
});
