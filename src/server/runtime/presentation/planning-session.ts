import { createHash, randomUUID } from 'node:crypto';

import type {
  PresentationDecisionAnswer,
  PresentationPlanningSession,
  PresentationPresenceInput,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import {
  createPresentationDecision,
  decidePresentationCollaboration,
  type PresentationCollaborationHook,
} from './collaboration-plugin';
import type {
  PresentationConversationCapability,
  PresentationConversationCommand,
  PresentationConversationContext,
  PresentationConversationResult,
} from './conversation-capability';
import type { PresentationExecutionLease } from './execution-lease';
import type { PresentationPlanningRepository } from './file-storage';

export type PlanningContextFactory = (scope: RuntimeScope) => Promise<{
  context: Omit<PresentationConversationContext, 'scope'>;
  dispose?: () => Promise<void>;
}>;
const fail = (message: string, code = 'PRESENTATION_INVALID') =>
  Object.assign(new Error(message), { code });
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[\w:-]{1,128}$/.test(value))
    throw fail('Invalid planning identifier');
  return value;
};
const key = (scope: RuntimeScope, threadId: string) =>
  JSON.stringify([scope.userId, scope.sessionId, threadId]);
type Session = PresentationPlanningSession & { requests?: { id: string; hash: string }[] };

const untilAborted = async <T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> => {
  signal.throwIfAborted();
  let abort: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([execute(), interrupted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
};

/** One durable actor per creation thread. Streaming is an observer, never its lifetime. */
export class PresentationPlanningSessions {
  private readonly active = new Map<string, { task: Promise<void>; controller: AbortController }>();
  private readonly presence = new Map<string, Map<string, { active: boolean; seenAt: number }>>();
  private disposed = false;
  constructor(
    private readonly repository: PresentationPlanningRepository,
    private readonly capability: PresentationConversationCapability,
    private readonly contextFactory: PlanningContextFactory,
    private readonly hook: PresentationCollaborationHook = async (input) =>
      decidePresentationCollaboration(input),
    private readonly timeoutMs = 15 * 60_000,
  ) {}

  private async lease(scope: RuntimeScope, threadId: string) {
    return this.repository.acquireLease(scope, `planning:${id(threadId)}`);
  }
  private save(scope: RuntimeScope, session: Session) {
    session.updatedAt = new Date().toISOString();
    return this.repository.savePlanningSession(scope, structuredClone(session));
  }
  async read(scope: RuntimeScope, threadId: string, recover = true): Promise<Session | null> {
    const session = await this.repository.getPlanningSession(scope, id(threadId));
    if (session && recover && (session.state === 'running' || session.state === 'queued'))
      await this.recover(scope, session.threadId);
    return this.repository.getPlanningSession(scope, threadId);
  }
  async start(
    scope: RuntimeScope,
    command: PresentationConversationCommand,
    requestId: string,
  ): Promise<Session> {
    if (this.disposed) throw fail('Planning service is restarting', 'PROVIDER_UNAVAILABLE');
    id(command.threadId);
    id(requestId);
    if (
      command.operation !== 'turn' ||
      !Array.isArray(command.messages) ||
      !command.messages.length ||
      command.messages.length > 200 ||
      command.messages.some(
        (m) =>
          !['user', 'assistant'].includes(m.role) ||
          typeof m.content !== 'string' ||
          !m.content.trim() ||
          m.content.length > 32_000,
      ) ||
      JSON.stringify(command).length > 2_000_000
    )
      throw fail('Invalid planning conversation');
    const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const lease = await this.lease(scope, command.threadId);
    if (!lease) {
      const existing = (await this.repository.getPlanningSession(
        scope,
        command.threadId,
      )) as Session | null;
      const receipt = existing?.requests?.find((item) => item.id === requestId);
      if (existing && receipt?.hash === hash) return existing;
      throw fail(
        '当前需求正在处理，已保留进度，请等待当前步骤或刷新后继续',
        'PRESENTATION_CONFLICT',
      );
    }
    let session: Session;
    try {
      const previous = (await this.repository.getPlanningSession(
        scope,
        command.threadId,
      )) as Session | null;
      const receipt = previous?.requests?.find((item) => item.id === requestId);
      if (receipt) {
        if (receipt.hash !== hash)
          throw fail('A request id cannot change its instruction', 'PRESENTATION_CONFLICT');
        return previous!;
      }
      const now = new Date().toISOString();
      const brief = {
        ...(previous?.checkpoint?.brief ?? (previous?.result?.brief as object)),
        ...command.brief,
      };
      session = {
        threadId: command.threadId,
        requestId,
        state: 'queued',
        command: { ...command, brief } as unknown as Record<string, unknown>,
        collaboration: previous?.collaboration ?? {
          mode: 'adaptive',
          automaticAttempts: 0,
          decisions: [],
        },
        heartbeatAt: now,
        updatedAt: now,
        recoveryAttempts: 0,
        requests: [...(previous?.requests ?? []).slice(-99), { id: requestId, hash }],
      };
      for (const question of session.collaboration.decisions)
        if (question.status !== 'answered') {
          question.status = 'answered';
          question.answer = {
            action: 'revise',
            content: command.messages.at(-1)?.content,
            requestId,
            answeredAt: now,
          };
        }
      session.collaboration.automaticAttempts = 0;
      await this.save(scope, session);
    } finally {
      await lease.release();
    }
    await this.recover(scope, command.threadId, false);
    return (await this.read(scope, command.threadId, false))!;
  }
  async presenceUpdate(scope: RuntimeScope, threadId: string, input: PresentationPresenceInput) {
    id(threadId);
    id(input.tabId);
    if (
      typeof input.visible !== 'boolean' ||
      typeof input.focused !== 'boolean' ||
      (input.mode && !['adaptive', 'ask', 'auto'].includes(input.mode))
    )
      throw fail('Invalid planning presence');
    const tabs = this.presence.get(key(scope, threadId)) ?? new Map();
    for (const [tabId, tab] of tabs) if (Date.now() - tab.seenAt > 45_000) tabs.delete(tabId);
    if (tabs.size >= 16 && !tabs.has(input.tabId)) tabs.delete(tabs.keys().next().value!);
    tabs.set(input.tabId, { active: input.visible && input.focused, seenAt: Date.now() });
    this.presence.set(key(scope, threadId), tabs);
    if (input.mode) {
      const lease = await this.lease(scope, threadId);
      if (!lease) throw fail('当前步骤进行中，请在本轮结束后修改协作偏好', 'PRESENTATION_CONFLICT');
      try {
        const session = await this.read(scope, threadId, false);
        if (!session) throw fail('Planning session not found', 'PRESENTATION_NOT_FOUND');
        session.collaboration.mode = input.mode;
        await this.save(scope, session);
      } finally {
        await lease.release();
      }
    }
  }
  async answer(scope: RuntimeScope, threadId: string, input: PresentationDecisionAnswer) {
    id(threadId);
    id(input.requestId);
    if (
      typeof input.decisionId !== 'string' ||
      !input.decisionId.trim() ||
      input.decisionId.length > 128
    )
      throw fail('Invalid planning question');
    if (
      !['retry', 'revise', 'defer'].includes(input.action) ||
      (input.content !== undefined &&
        (typeof input.content !== 'string' || input.content.length > 3000)) ||
      (input.action === 'revise' && !input.content?.trim())
    )
      throw fail('请填写有效的补充要求');
    const lease = await this.lease(scope, threadId);
    if (!lease) throw fail('当前步骤已在继续，请刷新进度', 'PRESENTATION_CONFLICT');
    let resume = false;
    try {
      const session = await this.read(scope, threadId, false);
      if (!session) throw fail('Planning session not found', 'PRESENTATION_NOT_FOUND');
      const question = session.collaboration.decisions.find((item) => item.id === input.decisionId);
      if (!question) throw fail('Question no longer exists', 'PRESENTATION_NOT_FOUND');
      if (question.answer?.requestId === input.requestId) {
        if (
          question.answer.action !== input.action ||
          question.answer.content !== input.content?.trim()
        )
          throw fail('Answer id cannot change', 'PRESENTATION_CONFLICT');
        return session;
      }
      if (session.state !== 'waiting_input' || question.status === 'answered')
        throw fail('问题已更新，请查看当前待决定事项', 'PRESENTATION_CONFLICT');
      if (input.action === 'defer') question.status = 'deferred';
      else {
        question.status = 'answered';
        question.answer = {
          action: input.action,
          content: input.content?.trim(),
          requestId: input.requestId,
          answeredAt: new Date().toISOString(),
        };
        if (input.action === 'revise') {
          const command = session.command as unknown as PresentationConversationCommand;
          session.command = {
            ...command,
            messages: [
              ...command.messages,
              ...(typeof session.result?.message === 'string'
                ? [{ role: 'assistant', content: session.result.message }]
                : []),
              { role: 'user', content: input.content!.trim() },
            ],
          } as unknown as Record<string, unknown>;
        }
        session.requestId = `decision:${input.requestId}`;
        session.state = 'queued';
        session.recoveryAttempts = 0;
        session.collaboration.automaticAttempts = 0;
        delete session.result;
        resume = true;
      }
      await this.save(scope, session);
    } finally {
      await lease.release();
    }
    if (resume) await this.recover(scope, threadId, false);
    return this.read(scope, threadId, false);
  }
  async recover(scope: RuntimeScope, threadId: string, restarted = true) {
    const identity = key(scope, threadId);
    if (this.disposed || this.active.has(identity)) return;
    const lease = await this.lease(scope, threadId);
    if (!lease) return;
    const session = await this.read(scope, threadId, false);
    if (!session || !['queued', 'running'].includes(session.state)) {
      await lease.release();
      return;
    }
    if (restarted) session.recoveryAttempts++;
    const controller = new AbortController();
    const task = this.run(scope, session, lease, controller)
      .catch((error) =>
        console.error('[presentation.planning] unable to save recovery state', {
          code: error?.code ?? 'PRESENTATION_PERSIST_FAILED',
        }),
      )
      .finally(() => this.active.delete(identity));
    this.active.set(identity, { task, controller });
  }
  private async run(
    scope: RuntimeScope,
    session: Session,
    lease: PresentationExecutionLease,
    controller: AbortController,
  ) {
    const lost = () => controller.abort(lease.signal.reason);
    lease.signal.addEventListener('abort', lost, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let persistence = Promise.resolve();
    const save = () => {
      const snapshot = structuredClone(session);
      persistence = persistence.then(() => {
        lease.signal.throwIfAborted();
        return this.save(scope, snapshot);
      });
      return persistence;
    };
    try {
      if (session.recoveryAttempts > 3)
        throw fail('多次服务重启，请决定如何继续', 'PRESENTATION_CONFLICT');
      session.state = 'running';
      session.activity = session.recoveryAttempts
        ? '服务已恢复，正从保存的需求与资料继续'
        : '正在理解需求';
      await save();
      heartbeat = setInterval(() => {
        session.heartbeatAt = new Date().toISOString();
        void save().catch(() =>
          controller.abort(fail('无法保存需求进度', 'PRESENTATION_PERSIST_FAILED')),
        );
      }, 15_000);
      while (!controller.signal.aborted) {
        let context: Awaited<ReturnType<PlanningContextFactory>> | undefined;
        try {
          timer = setTimeout(
            () => controller.abort(fail('本轮规划超时', 'CHAT_TIMEOUT')),
            this.timeoutMs,
          );
          context = await this.contextFactory(scope);
          controller.signal.throwIfAborted();
          const boundContext = context.context;
          const command = session.command as unknown as PresentationConversationCommand;
          const result = await untilAborted(controller.signal, () =>
            this.capability.execute(
              {
                ...command,
                brief: (session.checkpoint?.brief as typeof command.brief) ?? command.brief,
              },
              {
                ...boundContext,
                scope,
                signal: controller.signal,
                onActivity: (activity) => {
                  if (!controller.signal.aborted && !lease.signal.aborted)
                    session.activity = activity.text;
                },
                onCheckpoint: async (checkpoint) => {
                  lease.signal.throwIfAborted();
                  controller.signal.throwIfAborted();
                  session.checkpoint = structuredClone(checkpoint) as typeof session.checkpoint;
                  await save();
                },
              },
            ),
          );
          lease.signal.throwIfAborted();
          session.result = result as unknown as Record<string, unknown>;
          session.checkpoint = {
            brief: result.brief as Record<string, unknown>,
            slides: result.slides,
          };
          session.collaboration.automaticAttempts = 0;
          delete session.collaboration.lastErrorCode;
          if (result.question || result.questionId) {
            session.state = 'waiting_input';
            const question = createPresentationDecision(
              'input',
              typeof result.questionId === 'string' && result.questionId.trim()
                ? result.questionId.slice(0, 128)
                : randomUUID(),
              new Date().toISOString(),
            );
            if (result.question?.choices)
              question.choices = result.question.choices
                .slice(0, 8)
                .map((choice) => ({ ...choice }));
            question.title = result.question?.title ?? '继续前请确认';
            question.detail = result.question?.prompt ?? result.message;
            session.collaboration.decisions = [
              ...session.collaboration.decisions.slice(-19),
              question,
            ];
          } else session.state = 'completed';
          await save();
          return;
        } catch (error) {
          if (lease.signal.aborted) return;
          if (this.disposed) {
            session.state = 'queued';
            await save();
            return;
          }
          const code = controller.signal.aborted
            ? (controller.signal.reason?.code ?? 'CHAT_INTERRUPTED')
            : ((error as { code?: string })?.code ?? 'CHAT_INTERRUPTED');
          const foreground = [
            ...(this.presence.get(key(scope, session.threadId))?.values() ?? []),
          ].some((tab) => tab.active && Date.now() - tab.seenAt < 45_000);
          const resolution = await this.hook(
            {
              code,
              foreground,
              mode: session.collaboration.mode,
              automaticAttempts: session.collaboration.automaticAttempts,
            },
            { scope, jobId: session.threadId },
          );
          session.collaboration.lastErrorCode = code;
          if (resolution.action === 'retry' && !controller.signal.aborted) {
            session.collaboration.automaticAttempts++;
            session.activity = `正在从保存的步骤恢复（${session.collaboration.automaticAttempts}/2）`;
            await save();
          } else {
            session.state = 'waiting_input';
            session.collaboration.decisions = [
              ...session.collaboration.decisions.slice(-19),
              createPresentationDecision(
                resolution.category,
                randomUUID(),
                new Date().toISOString(),
              ),
            ];
            await save();
            return;
          }
        } finally {
          clearTimeout(timer);
          await context?.dispose?.().catch((error) =>
            console.error('[presentation.planning] context disposal failed', {
              code: error?.code ?? 'PRESENTATION_CONTEXT_DISPOSE_FAILED',
            }),
          );
        }
      }
    } catch (error) {
      if (!lease.signal.aborted) {
        session.state = 'waiting_input';
        session.collaboration.lastErrorCode =
          (error as { code?: string }).code ?? 'CHAT_INTERRUPTED';
        session.collaboration.decisions = [
          ...session.collaboration.decisions.slice(-19),
          createPresentationDecision('conflict', randomUUID(), new Date().toISOString()),
        ];
        await save();
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timer);
      lease.signal.removeEventListener('abort', lost);
      await persistence.catch(() => undefined);
      await lease.release();
    }
  }
  async wait(
    scope: RuntimeScope,
    threadId: string,
    signal: AbortSignal,
    onActivity: NonNullable<PresentationConversationContext['onActivity']>,
    onCheckpoint: NonNullable<PresentationConversationContext['onCheckpoint']>,
  ): Promise<PresentationConversationResult & { session: PresentationPlanningSession }> {
    let version = '';
    while (!signal.aborted) {
      const session = await this.read(scope, threadId);
      if (!session) throw fail('Planning session not found', 'PRESENTATION_NOT_FOUND');
      if (version !== session.updatedAt) {
        version = session.updatedAt;
        if (session.activity)
          onActivity({
            operation: 'presentation.conversation',
            state: 'started',
            text: session.activity,
          });
        if (session.checkpoint)
          await onCheckpoint(
            session.checkpoint as unknown as Pick<
              PresentationConversationResult,
              'brief' | 'slides'
            >,
          );
      }
      if (!['running', 'queued'].includes(session.state)) {
        const question = session.collaboration.decisions.findLast(
          (item) => item.status !== 'answered',
        );
        return {
          ...((session.result as unknown as PresentationConversationResult) ?? {
            phase: 'intake',
            brief: session.checkpoint?.brief ?? {},
            message: question?.detail ?? '已保存进度，请选择如何继续',
          }),
          session,
        };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 500);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        }
        signal.addEventListener('abort', done, { once: true });
      });
    }
    throw signal.reason ?? fail('Observation ended', 'CHAT_CANCELLED');
  }
  async dispose() {
    this.disposed = true;
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.allSettled([...this.active.values()].map((entry) => entry.task));
  }
}
