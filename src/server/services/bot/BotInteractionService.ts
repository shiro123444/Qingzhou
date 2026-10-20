import { and, eq, sql } from 'drizzle-orm';

import { BotInboundModel } from '@/database/models/botInbound';
import { agentOperations, messagePlugins, messages } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { AgentRuntimeCoordinator } from '@/server/modules/AgentRuntime/AgentRuntimeCoordinator';
import { SystemCapabilityIdentifier } from '@/server/services/toolExecution/systemCapabilityManifest';

import { callbackHash } from './callbackLedger';
import { botSessionKey } from './sessionScope';

export interface BotInteractionScope {
  applicationId: string;
  platform: string;
  platformThreadId: string;
}

export class BotInteractionError extends Error {}

const approvalPreview = (input: unknown, depth = 0): unknown => {
  if (depth > 5) return '[省略]';
  if (typeof input === 'string') {
    if (/^https?:\/\//u.test(input)) {
      try {
        const url = new URL(input);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        return '[无效地址]';
      }
    }
    return input.replaceAll(/\b(?:sk-[\w-]+|Bearer\s+\S+)/giu, '[隐藏密钥]').slice(0, 300);
  }
  if (Array.isArray(input))
    return input.slice(0, 8).map((value) => approvalPreview(value, depth + 1));
  if (input && typeof input === 'object')
    return Object.fromEntries(
      Object.entries(input)
        .slice(0, 20)
        .map(([key, value]) => [
          key,
          /password|passphrase|api.?key|token|secret|authorization|cookie|credential/iu.test(key)
            ? '[隐藏]'
            : approvalPreview(value, depth + 1),
        ]),
    );
  return input;
};

/** Resumes only the original sender's paused operation in this exact bot thread. */
export class BotInteractionService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
  ) {}

  async pending(operationId: string) {
    const [row] = await this.db
      .select()
      .from(agentOperations)
      .where(and(eq(agentOperations.id, operationId), eq(agentOperations.userId, this.userId)));
    if (!row || row.status !== 'waiting_for_human') return undefined;
    const state = await new AgentRuntimeCoordinator().loadAgentState(operationId);
    if (state?.status !== 'waiting_for_human' || state.metadata?.userId !== this.userId)
      return undefined;
    const tool = state.pendingToolsCalling?.[0];
    if (!tool) return undefined;
    const [message] = await this.db
      .select({ id: messages.id })
      .from(messagePlugins)
      .innerJoin(messages, eq(messages.id, messagePlugins.id))
      .where(
        and(
          eq(messagePlugins.userId, this.userId),
          eq(messages.userId, this.userId),
          eq(messagePlugins.toolCallId, tool.id),
          eq(messages.topicId, row.topicId!),
          eq(messages.role, 'tool'),
        ),
      );
    if (!message) return undefined;
    let args: any;
    try {
      args = JSON.parse(tool.arguments ?? '{}');
    } catch {
      return undefined;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
    const isQuestion =
      (tool.identifier === SystemCapabilityIdentifier && tool.apiName === 'ask') ||
      (tool.identifier === 'lobe-user-interaction' && tool.apiName === 'askUserQuestion');
    const question = typeof args.question === 'string' ? args.question : args.question?.prompt;
    const token = callbackHash([this.userId, operationId, state.stepCount, tool.id]).slice(0, 12);
    return { row, state, tool, messageId: message.id, args, isQuestion, question, token };
  }

  async describe(operationId: string) {
    const pending = await this.pending(operationId);
    if (!pending) return undefined;
    if (pending.isQuestion) {
      const fields = pending.args.question?.fields;
      const form = Array.isArray(fields)
        ? fields
            .map(
              (field: any) =>
                `${field.key}: ${field.label}${field.options?.length ? ' (' + field.options.map((option: any) => `${option.value}=${option.label}`).join(', ') + ')' : ''}`,
            )
            .join('\n')
        : '';
      return `${pending.question ?? '需要补充信息'}\n${form ? form + '\n表单回答请使用 JSON 对象。\n' : ''}\n请直接回复你的回答，也可使用：/answer ${pending.token} 你的回答\n可用 /stop 取消。`;
    }
    return `需要确认工具：${pending.tool.identifier}.${pending.tool.apiName}\n参数预览：${JSON.stringify(approvalPreview(pending.args), null, 2).slice(0, 1000)}\n完整参数可在清舟执行详情中查看。\n\n允许：/confirm ${pending.token}\n拒绝：/reject ${pending.token}\n可用 /stop 取消。`;
  }

  /** Only a message received after this pause can answer it; never infer tool approval. */
  async respondToMessage(
    scope: BotInteractionScope,
    authorUserId: string | undefined,
    text: string,
    receivedAt?: Date,
  ) {
    if (!receivedAt || !text.trim() || text.trim().startsWith('/')) return undefined;
    const active = await new BotInboundModel(this.db).getSession(
      this.userId,
      botSessionKey(this.userId, scope),
    );
    if (!active?.operationId) return undefined;
    const pending = await this.pending(active.operationId);
    const bot = pending?.state.metadata?.botContext;
    if (
      !pending?.isQuestion ||
      !authorUserId ||
      bot?.senderExternalUserId !== authorUserId ||
      bot.platformThreadId !== scope.platformThreadId ||
      bot.applicationId !== scope.applicationId ||
      bot.platform !== scope.platform ||
      !pending.row.updatedAt ||
      receivedAt.getTime() <= pending.row.updatedAt.getTime()
    )
      return undefined;
    return this.respond(scope, authorUserId, 'answer', `${pending.token} ${text}`);
  }

  async respond(
    scope: BotInteractionScope,
    authorUserId: string | undefined,
    action: 'confirm' | 'reject' | 'answer',
    input: string,
  ) {
    const active = await new BotInboundModel(this.db).getSession(
      this.userId,
      botSessionKey(this.userId, scope),
    );
    if (!active?.operationId) throw new BotInteractionError('当前会话没有等待响应的执行');
    const pending = await this.pending(active.operationId);
    if (!pending) throw new BotInteractionError('当前执行没有待处理的交互');
    const bot = pending.state.metadata?.botContext;
    if (
      !authorUserId ||
      bot?.senderExternalUserId !== authorUserId ||
      bot.platformThreadId !== scope.platformThreadId ||
      bot.applicationId !== scope.applicationId ||
      bot.platform !== scope.platform
    )
      throw new BotInteractionError('只有原会话的请求者可以响应这次交互');
    if (!pending.isQuestion && !bot.isOwner)
      throw new BotInteractionError('工具审批需要机器人负责人的身份');
    const [token, ...rest] = input.trim().split(/\s/u);
    if (token !== pending.token) throw new BotInteractionError('交互编号已失效，请使用最新的编号');
    if ((action === 'answer') !== pending.isQuestion)
      throw new BotInteractionError('请使用本次交互提示中的响应命令');
    const answer = rest.join(' ').trim();
    if (action === 'answer' && (!answer || answer.length > 10000))
      throw new BotInteractionError('请提供不超过 10000 字符的回答');
    let response: Record<string, unknown> | undefined;
    if (pending.isQuestion) {
      const fields = pending.args.question?.fields;
      if (Array.isArray(fields)) {
        try {
          response = JSON.parse(answer);
        } catch {
          throw new BotInteractionError('表单回答必须是有效 JSON 对象');
        }
        if (!response || typeof response !== 'object' || Array.isArray(response))
          throw new BotInteractionError('表单回答必须是 JSON 对象');
        if (Object.keys(response).some((key) => !fields.some((field: any) => field.key === key)))
          throw new BotInteractionError('回答包含未知字段');
        for (const field of fields) {
          const value = response[field.key];
          if (
            field.required &&
            (value === undefined || value === '' || (Array.isArray(value) && !value.length))
          )
            throw new BotInteractionError(`请填写 ${field.label}`);
          if (value === undefined) continue;
          const values = Array.isArray(value) ? value : [value];
          if (
            values.some((item) => typeof item !== 'string') ||
            (field.kind !== 'multiselect' && Array.isArray(value))
          )
            throw new BotInteractionError(`字段 ${field.key} 的格式无效`);
          if (
            field.options &&
            values.some((item) => !field.options.some((option: any) => option.value === item))
          )
            throw new BotInteractionError(`字段 ${field.key} 的选项无效`);
        }
      } else response = { text: answer };
    }
    const claimed = await this.db
      .update(messagePlugins)
      .set({
        state: sql`coalesce(${messagePlugins.state}, '{}'::jsonb) || jsonb_build_object('botDecision', ${JSON.stringify({ token, action })}::jsonb)`,
      })
      .where(
        and(
          eq(messagePlugins.id, pending.messageId),
          eq(messagePlugins.userId, this.userId),
          sql`${messagePlugins.state}->'botDecision' is null`,
        ),
      )
      .returning({ id: messagePlugins.id });
    if (!claimed.length) throw new BotInteractionError('这次交互已提交，请勿重复确认');
    const { AgentRuntimeService } =
      await import('@/server/services/agentRuntime/AgentRuntimeService');
    const result = await new AgentRuntimeService(this.db, this.userId).processHumanIntervention({
      operationId: active.operationId,
      stepIndex: pending.state.stepCount,
      action: action === 'confirm' ? 'approve' : action === 'reject' ? 'reject' : 'input',
      toolMessageId: pending.messageId,
      approvedToolCall: action === 'confirm' ? pending.tool : undefined,
      humanInput: response ? { response, toolCallId: pending.tool.id } : undefined,
      rejectionReason: action === 'reject' ? '用户在渠道拒绝此次工具调用' : undefined,
    });
    if (!result.messageId) throw new BotInteractionError('执行未调度，请检查运行环境');
    return active.operationId;
  }
}
