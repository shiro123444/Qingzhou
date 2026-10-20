// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HumanInterventionHandler } from '../HumanInterventionHandler';

const buildHandler = (
  pluginQuery: ReturnType<typeof vi.fn>,
  messageModel: { updateMessagePlugin: any; updateToolMessage: any },
) => {
  const serverDB = { query: { messagePlugins: { findFirst: pluginQuery } } } as any;
  return new HumanInterventionHandler(serverDB, messageModel as any);
};

describe('HumanInterventionHandler.process', () => {
  let mockMessageModel: { updateMessagePlugin: any; updateToolMessage: any };
  let mockDBPluginQuery: ReturnType<typeof vi.fn>;
  let handler: HumanInterventionHandler;

  const makeState = (overrides: Record<string, any> = {}): any => ({
    lastModified: new Date().toISOString(),
    pendingToolsCalling: [
      { apiName: 'search', arguments: '{}', id: 'tool-call-1', identifier: 'web-search' },
      { apiName: 'write', arguments: '{}', id: 'tool-call-2', identifier: 'local-system' },
    ],
    status: 'waiting_for_human',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockDBPluginQuery = vi.fn().mockResolvedValue({ toolCallId: 'tool-call-1' });
    mockMessageModel = {
      updateMessagePlugin: vi.fn().mockResolvedValue(undefined),
      updateToolMessage: vi.fn().mockResolvedValue({ success: true }),
    };
    handler = buildHandler(mockDBPluginQuery, mockMessageModel);
  });

  describe('approve path', () => {
    it('persists intervention=approved on the tool message', async () => {
      const state = makeState();

      await handler.process(state, {
        approvedToolCall: { id: 'tool-call-1' },
        toolMessageId: 'tool-msg-1',
      });

      expect(mockMessageModel.updateMessagePlugin).toHaveBeenCalledWith('tool-msg-1', {
        intervention: { status: 'approved' },
      });
    });

    it('returns nextContext with phase=human_approved_tool and skipCreateToolMessage=true', async () => {
      const state = makeState();

      const result = await handler.process(state, {
        approvedToolCall: { id: 'tool-call-1' },
        toolMessageId: 'tool-msg-1',
      });

      expect(result.nextContext).toEqual({
        payload: {
          approvedToolCall: { id: 'tool-call-1' },
          parentMessageId: 'tool-msg-1',
          skipCreateToolMessage: true,
        },
        phase: 'human_approved_tool',
      });
    });

    it('removes the approved tool from pendingToolsCalling', async () => {
      const state = makeState();

      const result = await handler.process(state, {
        approvedToolCall: { id: 'tool-call-1' },
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState.pendingToolsCalling).toHaveLength(1);
      expect(result.newState.pendingToolsCalling[0].id).toBe('tool-call-2');
    });

    it('keeps state waiting_for_human while other tools still pending', async () => {
      const state = makeState();

      const result = await handler.process(state, {
        approvedToolCall: { id: 'tool-call-1' },
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState.status).toBe('waiting_for_human');
    });

    it('transitions to running when last pending tool is approved', async () => {
      const state = makeState({
        pendingToolsCalling: [
          { apiName: 'search', arguments: '{}', id: 'tool-call-1', identifier: 'web-search' },
        ],
      });

      const result = await handler.process(state, {
        approvedToolCall: { id: 'tool-call-1' },
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState.status).toBe('running');
    });

    it('no-ops when toolMessageId is missing', async () => {
      const state = makeState();

      const result = await handler.process(state, {
        approvedToolCall: { id: 'tool-call-1' },
      });

      expect(mockMessageModel.updateMessagePlugin).not.toHaveBeenCalled();
      expect(result.nextContext).toBeUndefined();
    });
  });

  describe('reject path (pure)', () => {
    it('persists intervention=rejected with reason and updates content', async () => {
      const state = makeState();

      await handler.process(state, {
        rejectionReason: 'privacy concern',
        toolMessageId: 'tool-msg-1',
      });

      expect(mockMessageModel.updateToolMessage).toHaveBeenCalledWith('tool-msg-1', {
        content: 'User reject this tool calling with reason: privacy concern',
      });
      expect(mockMessageModel.updateMessagePlugin).toHaveBeenCalledWith('tool-msg-1', {
        intervention: { rejectedReason: 'privacy concern', status: 'rejected' },
      });
    });

    it('does not enter the reject branch when rejectionReason is falsy', async () => {
      const state = makeState();

      await handler.process(state, {
        rejectionReason: '',
        toolMessageId: 'tool-msg-1',
      });

      expect(mockMessageModel.updateToolMessage).not.toHaveBeenCalled();
    });

    it('writes "with reason" content for any non-empty reason', async () => {
      const state = makeState();

      await handler.process(state, {
        rejectionReason: 'r',
        toolMessageId: 'tool-msg-1',
      });

      expect(mockMessageModel.updateToolMessage).toHaveBeenCalledWith(
        'tool-msg-1',
        expect.objectContaining({
          content: 'User reject this tool calling with reason: r',
        }),
      );
    });

    it('removes the rejected tool from pendingToolsCalling by tool_call_id lookup', async () => {
      const state = makeState();
      mockDBPluginQuery.mockResolvedValueOnce({ toolCallId: 'tool-call-2' });

      const result = await handler.process(state, {
        rejectionReason: 'nope',
        toolMessageId: 'tool-msg-2',
      });

      expect(result.newState.pendingToolsCalling).toHaveLength(1);
      expect(result.newState.pendingToolsCalling[0].id).toBe('tool-call-1');
    });

    it('transitions to interrupted + reason=human_rejected (pure reject, no continue)', async () => {
      const state = makeState();

      const result = await handler.process(state, {
        rejectionReason: 'nope',
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState.status).toBe('interrupted');
      expect(result.newState.interruption).toEqual(
        expect.objectContaining({
          canResume: false,
          reason: 'human_rejected',
        }),
      );
      expect(result.nextContext).toBeUndefined();
    });
  });

  describe('reject_continue path', () => {
    it('stays paused (nextContext=undefined) when other tools are still pending', async () => {
      // makeState() has 2 pending; pluginQuery resolves tool-call-1 → 1 left.
      // Returning a `phase: 'user_input'` context here would resume the LLM
      // before the remaining pending tools are decided (LOBE-7151 review P1).
      const state = makeState();
      mockDBPluginQuery.mockResolvedValueOnce({ toolCallId: 'tool-call-1' });

      const result = await handler.process(state, {
        rejectAndContinue: true,
        rejectionReason: 'nope',
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState.status).toBe('waiting_for_human');
      expect(result.nextContext).toBeUndefined();
    });

    it('returns nextContext with phase=user_input only when this is the last pending tool', async () => {
      const state = makeState({
        pendingToolsCalling: [
          { apiName: 'search', arguments: '{}', id: 'tool-call-1', identifier: 'web-search' },
        ],
      });
      mockDBPluginQuery.mockResolvedValueOnce({ toolCallId: 'tool-call-1' });

      const result = await handler.process(state, {
        rejectAndContinue: true,
        rejectionReason: 'nope',
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState.status).toBe('running');
      expect(result.nextContext).toEqual({ phase: 'user_input' });
    });

    it('still persists intervention=rejected on the tool message', async () => {
      const state = makeState();

      await handler.process(state, {
        rejectAndContinue: true,
        rejectionReason: 'privacy',
        toolMessageId: 'tool-msg-1',
      });

      expect(mockMessageModel.updateMessagePlugin).toHaveBeenCalledWith('tool-msg-1', {
        intervention: { rejectedReason: 'privacy', status: 'rejected' },
      });
    });
  });

  describe('no-op paths', () => {
    it('returns state unchanged when status is not waiting_for_human (approve)', async () => {
      const state = makeState({ status: 'running' });

      const result = await handler.process(state, {
        approvedToolCall: { id: 'tool-call-1' },
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState).toBe(state);
      expect(result.nextContext).toBeUndefined();
      expect(mockMessageModel.updateMessagePlugin).not.toHaveBeenCalled();
    });

    it('returns state unchanged when status is not waiting_for_human (reject)', async () => {
      const state = makeState({ status: 'running' });

      const result = await handler.process(state, {
        rejectionReason: 'nope',
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState).toBe(state);
      expect(result.nextContext).toBeUndefined();
    });

    it('rejects input that does not correspond to a pending question', async () => {
      const state = makeState();

      await expect(
        handler.process(state, {
          humanInput: { response: 'hi' },
          toolMessageId: 'tool-msg-1',
        }),
      ).rejects.toThrow('pending question');
      expect(mockMessageModel.updateToolMessage).not.toHaveBeenCalled();
    });
  });

  describe('question response', () => {
    const question = {
      id: 'question-1',
      identifier: 'qingzhou-system-capabilities',
      apiName: 'ask',
    };
    function prepare(extra: any[] = []) {
      mockDBPluginQuery.mockResolvedValue({
        ...question,
        toolCallId: question.id,
        state: { botDecision: { token: 't' } },
      });
      return makeState({
        metadata: { userId: 'user-1' },
        pendingToolsCalling: [question, ...extra],
        messages: [{ id: 'tool-msg-1', role: 'tool', pluginIntervention: { status: 'pending' } }],
      });
    }
    it('persists a real answer and resumes from the tool result without re-executing ask', async () => {
      const state = prepare();
      const result = await handler.process(state, {
        toolMessageId: 'tool-msg-1',
        humanInput: { toolCallId: question.id, response: { text: 'A' } },
      });
      expect(result.newState.status).toBe('running');
      expect(result.newState.pendingToolsCalling).toEqual([]);
      expect(result.newState.messages[0]).toMatchObject({
        content: 'User submitted: {"text":"A"}',
        pluginIntervention: { status: 'approved' },
      });
      expect(result.nextContext).toEqual({
        phase: 'tool_result',
        payload: { parentMessageId: 'tool-msg-1' },
      });
      expect(mockMessageModel.updateMessagePlugin).toHaveBeenCalledWith(
        'tool-msg-1',
        expect.objectContaining({
          state: expect.objectContaining({ botDecision: { token: 't' }, response: { text: 'A' } }),
        }),
      );
      expect(state.messages[0].pluginIntervention.status).toBe('pending');
    });
    it('keeps waiting while another tool is undecided', async () => {
      const result = await handler.process(prepare([{ id: 'other' }]), {
        toolMessageId: 'tool-msg-1',
        humanInput: { toolCallId: question.id, response: { text: 'A' } },
      });
      expect(result.newState.status).toBe('waiting_for_human');
      expect(result.nextContext).toBeUndefined();
    });
    it('appends the answer when approval only created a database row and no in-memory placeholder', async () => {
      const state = prepare();
      state.messages = [{ id: 'assistant', role: 'assistant', tools: [question] }];
      const result = await handler.process(state, {
        toolMessageId: 'tool-msg-1',
        humanInput: { toolCallId: question.id, response: { text: 'A' } },
      });
      expect(result.newState.messages).toHaveLength(2);
      expect(result.newState.messages[1]).toMatchObject({
        role: 'tool',
        tool_call_id: question.id,
        content: 'User submitted: {"text":"A"}',
      });
      expect(result.nextContext?.phase).toBe('tool_result');
    });
    it('rejects a mismatched persisted tool call before writing a response', async () => {
      const state = prepare();
      mockDBPluginQuery.mockResolvedValue({ toolCallId: 'other' });
      await expect(
        handler.process(state, {
          toolMessageId: 'tool-msg-1',
          humanInput: { toolCallId: question.id, response: { text: 'A' } },
        }),
      ).rejects.toThrow('does not match');
      expect(mockMessageModel.updateToolMessage).not.toHaveBeenCalled();
    });
  });
});
