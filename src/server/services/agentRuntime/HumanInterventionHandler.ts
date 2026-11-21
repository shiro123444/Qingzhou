import { isDeepStrictEqual } from 'node:util';

import type { AgentRuntimeContext } from '@lobechat/agent-runtime';
import debug from 'debug';

import type { MessageModel } from '@/database/models/message';
import type { LobeChatDatabase } from '@/database/type';

import { hookDispatcher } from './hooks';

const log = debug('lobe-server:human-intervention-handler');

/** The persisted pending call is authoritative; a client can reference it, never substitute a tool. */
export function resolvePendingApproval(state: any, submitted: any) {
  const pending = state.pendingToolsCalling?.find((tool: any) => tool.id === submitted?.id);
  if (!pending) throw new Error('Approval does not match a pending tool');
  for (const field of ['identifier', 'apiName'])
    if (submitted[field] !== undefined && submitted[field] !== pending[field])
      throw new Error('Approval tool identity changed');
  if (submitted.arguments !== undefined && submitted.arguments !== pending.arguments) {
    let same = false;
    try {
      same = isDeepStrictEqual(
        JSON.parse(submitted.arguments),
        JSON.parse(pending.arguments ?? '{}'),
      );
    } catch {
      // Invalid JSON is a changed/unreviewed argument, never an approval fallback.
    }
    if (!same) throw new Error('Approval arguments changed; review the current tool call');
  }
  return structuredClone(pending);
}

export interface InterventionInput {
  approvedToolCall?: any;
  humanInput?: any;
  rejectAndContinue?: boolean;
  rejectionReason?: string;
  toolMessageId?: string;
}

export interface InterventionResult {
  newState: any;
  nextContext: AgentRuntimeContext | undefined;
}

/**
 * Owns the three branches of human intervention on a `waiting_for_human`
 * operation, mirroring `conversationControl.ts` on the client side:
 *
 * - `approveToolCalling` → write `intervention.status='approved'`, resume via
 *   `phase: 'human_approved_tool'` so the runtime short-circuits into
 *   `call_tool` with `skipCreateToolMessage: true`.
 * - `rejectAndContinueToolCalling` → write `intervention.status='rejected'`
 *   and resume via `phase: 'user_input'` once the rest of the batch is
 *   resolved, so the next LLM call treats the rejection as user feedback.
 * - `rejectToolCalling` (halt) → write `intervention.status='rejected'` and
 *   move to `status='interrupted'` with `interruption.reason='human_rejected'`.
 *
 * Each branch is a self-contained method so the routing in `process()` reads
 * top-to-bottom: detect approval, rejection, then a pending question response.
 */
export class HumanInterventionHandler {
  constructor(
    private readonly serverDB: LobeChatDatabase,
    private readonly messageModel: MessageModel,
  ) {}

  /** Read-only admission check before a durable approval command is accepted. */
  async validate(state: any, input: InterventionInput): Promise<InterventionInput> {
    if (state.status !== 'waiting_for_human' || !input.toolMessageId)
      throw new Error('Intervention is not a current pending review');
    const pending = await this.pendingToolMessage(state, input.toolMessageId);
    if (input.approvedToolCall) {
      const approvedToolCall = resolvePendingApproval(state, input.approvedToolCall);
      if (approvedToolCall.id !== pending.id)
        throw new Error('Approval tool message does not match');
      return { ...input, approvedToolCall };
    }
    if (input.humanInput) {
      const response = input.humanInput.response ?? input.humanInput.selection;
      const question =
        (pending.identifier === 'qingzhou-system-capabilities' && pending.apiName === 'ask') ||
        (pending.identifier === 'lobe-user-interaction' && pending.apiName === 'askUserQuestion');
      if (
        !question ||
        (input.humanInput.toolCallId !== undefined && input.humanInput.toolCallId !== pending.id) ||
        !response ||
        typeof response !== 'object' ||
        Array.isArray(response)
      )
        throw new Error('Human input does not match a pending question');
      return {
        ...input,
        humanInput: { response: structuredClone(response), toolCallId: pending.id },
      };
    } else if (!input.rejectionReason) throw new Error('Intervention decision is missing');
    return input;
  }

  async process(state: any, intervention: InterventionInput): Promise<InterventionResult> {
    const { humanInput, approvedToolCall, rejectAndContinue, rejectionReason, toolMessageId } =
      intervention;

    if (approvedToolCall && state.status === 'waiting_for_human') {
      return this.approve(state, approvedToolCall, toolMessageId);
    }

    if (rejectionReason && state.status === 'waiting_for_human') {
      return this.reject(state, { rejectAndContinue, rejectionReason, toolMessageId });
    }

    if (humanInput && state.status === 'waiting_for_human') {
      return this.answer(state, humanInput, toolMessageId);
    }

    return { newState: state, nextContext: undefined };
  }

  private async answer(
    state: any,
    input: any,
    toolMessageId?: string,
  ): Promise<InterventionResult> {
    const tool = state.pendingToolsCalling?.find((item: any) => item.id === input.toolCallId);
    const question =
      tool &&
      ((tool.identifier === 'qingzhou-system-capabilities' && tool.apiName === 'ask') ||
        (tool.identifier === 'lobe-user-interaction' && tool.apiName === 'askUserQuestion'));
    if (
      !question ||
      !toolMessageId ||
      !input.response ||
      typeof input.response !== 'object' ||
      Array.isArray(input.response)
    )
      throw new Error('Human input does not match a pending question');
    const plugin = await this.serverDB.query.messagePlugins.findFirst({
      where: (mp: any, { and, eq }: any) =>
        and(eq(mp.id, toolMessageId), eq(mp.userId, state.metadata.userId)),
    });
    if (
      !plugin ||
      plugin.toolCallId !== tool.id ||
      plugin.identifier !== tool.identifier ||
      plugin.apiName !== tool.apiName
    )
      throw new Error('Human input tool message does not match');
    const content = `User submitted: ${JSON.stringify(input.response)}`;
    const pluginState = {
      ...(plugin.state && typeof plugin.state === 'object' ? plugin.state : {}),
      response: input.response,
      status: 'submitted',
    };
    await this.messageModel.updateToolMessage(toolMessageId, { content });
    await this.messageModel.updateMessagePlugin(toolMessageId, {
      intervention: { status: 'approved' },
      state: pluginState,
    });
    const newState = structuredClone(state);
    newState.lastModified = new Date().toISOString();
    const previous = newState.messages.find(
      (message: any) => message.id === toolMessageId || message.tool_call_id === tool.id,
    );
    // The approval executor persists an empty DB row without adding it to state.messages.
    // Append the real result when absent, otherwise the next LLM call sees a missing tool result.
    newState.messages = newState.messages.filter(
      (message: any) => message.id !== toolMessageId && message.tool_call_id !== tool.id,
    );
    newState.messages.push({
      ...previous,
      id: toolMessageId,
      role: 'tool',
      content,
      tool_call_id: tool.id,
      plugin: tool,
      pluginState,
      pluginError: undefined,
      pluginIntervention: { status: 'approved' },
    });
    newState.pendingToolsCalling = newState.pendingToolsCalling.filter(
      (item: any) => item.id !== tool.id,
    );
    newState.status = newState.pendingToolsCalling.length ? 'waiting_for_human' : 'running';
    return {
      newState,
      nextContext: newState.pendingToolsCalling.length
        ? undefined
        : {
            phase: 'tool_result',
            payload: { parentMessageId: toolMessageId },
          },
    };
  }

  private async approve(
    state: any,
    approvedToolCall: any,
    toolMessageId: string | undefined,
  ): Promise<InterventionResult> {
    if (!toolMessageId) {
      log('approve requires toolMessageId, got undefined');
      return { newState: state, nextContext: undefined };
    }

    approvedToolCall = resolvePendingApproval(state, approvedToolCall);
    const persisted = await this.pendingToolMessage(state, toolMessageId);
    if (persisted.id !== approvedToolCall.id)
      throw new Error('Approval tool message does not match');

    await this.messageModel.updateMessagePlugin(toolMessageId, {
      intervention: { status: 'approved' },
    });

    const newState = structuredClone(state);
    newState.lastModified = new Date().toISOString();
    newState.pendingToolsCalling = (state.pendingToolsCalling ?? []).filter(
      (t: any) => t.id !== approvedToolCall.id,
    );
    // Keep waiting_for_human while other tools remain pending; resume to
    // running when this was the last one.
    newState.status = newState.pendingToolsCalling.length > 0 ? 'waiting_for_human' : 'running';

    hookDispatcher
      .dispatch(
        state.metadata?.operationId ?? '',
        'afterHumanIntervention',
        {
          action: 'approve',
          operationId: state.metadata?.operationId ?? '',
          toolCallId: approvedToolCall.id,
          userId: state.metadata?.userId,
        },
        state.metadata?._hooks,
      )
      .catch(() => {});

    return {
      newState,
      nextContext: {
        payload: {
          approvedToolCall,
          parentMessageId: toolMessageId,
          skipCreateToolMessage: true,
        },
        phase: 'human_approved_tool',
      },
    };
  }

  private async reject(
    state: any,
    params: {
      rejectAndContinue?: boolean;
      rejectionReason: string;
      toolMessageId: string | undefined;
    },
  ): Promise<InterventionResult> {
    const { rejectAndContinue, rejectionReason, toolMessageId } = params;

    if (!toolMessageId) {
      log('reject requires toolMessageId, got undefined');
      return { newState: state, nextContext: undefined };
    }
    const rejectedToolCallId = (await this.pendingToolMessage(state, toolMessageId)).id;

    const rejectionContent = rejectionReason
      ? `User reject this tool calling with reason: ${rejectionReason}`
      : 'User reject this tool calling without reason';

    await this.messageModel.updateToolMessage(toolMessageId, { content: rejectionContent });
    await this.messageModel.updateMessagePlugin(toolMessageId, {
      intervention: { rejectedReason: rejectionReason, status: 'rejected' },
    });

    // Find the tool_call_id for this tool message so we can drop it from
    // pendingToolsCalling. pendingToolsCalling holds ChatToolPayload[] whose
    // id === tool_call_id; the mapping lives in messagePlugins (plugin id
    // === message id, toolCallId is a separate column).

    const newState = structuredClone(state);
    newState.lastModified = new Date().toISOString();
    newState.pendingToolsCalling = rejectedToolCallId
      ? (state.pendingToolsCalling ?? []).filter((t: any) => t.id !== rejectedToolCallId)
      : (state.pendingToolsCalling ?? []);

    if (rejectAndContinue) {
      return this.rejectAndContinue(state, newState, rejectionReason, rejectedToolCallId);
    }

    return this.rejectAndHalt(state, newState, rejectionReason, rejectedToolCallId);
  }

  /**
   * Persist the rejection, then either (a) wait for the remaining pending
   * tools to be resolved or (b) resume LLM once this is the last one.
   * Returning a `phase: 'user_input'` nextContext while pendingToolsCalling
   * is non-empty would cause executeStep to run runtime.step immediately,
   * resuming the LLM with an unresolved batch — see LOBE-7151 review P1.
   */
  private rejectAndContinue(
    state: any,
    newState: any,
    rejectionReason: string,
    rejectedToolCallId: string | undefined,
  ): InterventionResult {
    hookDispatcher
      .dispatch(
        state.metadata?.operationId ?? '',
        'afterHumanIntervention',
        {
          action: 'rejectAndContinue',
          operationId: state.metadata?.operationId ?? '',
          rejectionReason,
          toolCallId: rejectedToolCallId,
          userId: state.metadata?.userId,
        },
        state.metadata?._hooks,
      )
      .catch(() => {});

    if (newState.pendingToolsCalling.length > 0) {
      newState.status = 'waiting_for_human';
      return { newState, nextContext: undefined };
    }

    newState.status = 'running';
    return { newState, nextContext: { phase: 'user_input' } };
  }

  /**
   * Halt: use `interrupted` + `reason='human_rejected'` to reuse the existing
   * terminal-state plumbing (early-exit, completion hooks, etc).
   */
  private rejectAndHalt(
    state: any,
    newState: any,
    rejectionReason: string,
    rejectedToolCallId: string | undefined,
  ): InterventionResult {
    hookDispatcher
      .dispatch(
        state.metadata?.operationId ?? '',
        'onStopByHumanIntervention',
        {
          operationId: state.metadata?.operationId ?? '',
          rejectionReason,
          toolCallId: rejectedToolCallId,
          userId: state.metadata?.userId,
        },
        state.metadata?._hooks,
      )
      .catch(() => {});

    newState.status = 'interrupted';
    newState.interruption = {
      canResume: false,
      interruptedAt: new Date().toISOString(),
      reason: 'human_rejected',
    };
    return { newState, nextContext: undefined };
  }

  private async pendingToolMessage(state: any, toolMessageId: string) {
    if (!state.metadata?.userId) throw new Error('Approval owner is missing');
    const plugin = await this.serverDB.query.messagePlugins.findFirst({
      where: (mp: any, { and, eq }: any) =>
        and(eq(mp.id, toolMessageId), eq(mp.userId, state.metadata.userId)),
    });
    const pending = state.pendingToolsCalling?.find((tool: any) => tool.id === plugin?.toolCallId);
    if (
      !pending ||
      plugin?.identifier !== pending.identifier ||
      plugin?.apiName !== pending.apiName
    )
      throw new Error('Intervention tool message does not match a pending tool');
    return pending;
  }
}
