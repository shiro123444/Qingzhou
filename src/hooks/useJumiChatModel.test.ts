import { DEFAULT_PROVIDER } from '@lobechat/business-const';
import { DEFAULT_MODEL, INBOX_SESSION_ID } from '@lobechat/const';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '@/store/agent';
import { type AgentStore } from '@/store/agent/store';

import { useJumiChatModel } from './useJumiChatModel';

vi.mock('@/store/agent', () => ({ useAgentStore: vi.fn() }));

const updateAgentConfigById = vi.fn();
let state: AgentStore;

beforeEach(() => {
  vi.clearAllMocks();
  state = {
    agentMap: {
      inbox: { model: 'saved-inbox-model', provider: 'custom-inbox-provider' },
      other: { model: 'saved-agent-model', provider: 'custom-agent-provider' },
    },
    builtinAgentIdMap: { [INBOX_SESSION_ID]: 'inbox' },
    updateAgentConfigById,
  } as unknown as AgentStore;
  vi.mocked(useAgentStore).mockImplementation((selector) => selector(state));
});

describe('useJumiChatModel saved provider selection', () => {
  it('reads each real agent without changing its saved provider/model', () => {
    const { result, rerender } = renderHook(({ id }) => useJumiChatModel(id), {
      initialProps: { id: 'other' },
    });
    expect(result.current).toEqual({
      model: 'saved-agent-model',
      provider: 'custom-agent-provider',
      selectionAgentId: 'other',
    });
    rerender({ id: 'inbox' });
    expect(result.current.model).toBe('saved-inbox-model');
    expect(updateAgentConfigById).not.toHaveBeenCalled();
  });

  it('maps PPT to the real inbox selection rather than a virtual agent', () => {
    const { result, rerender } = renderHook(() => useJumiChatModel('ppt-agent'));
    expect(result.current).toEqual({
      model: 'saved-inbox-model',
      provider: 'custom-inbox-provider',
      selectionAgentId: 'inbox',
    });
    state.agentMap.inbox = {
      ...state.agentMap.inbox,
      model: 'new-inbox-model',
      provider: 'new-inbox-provider',
    };
    rerender();
    expect(result.current.model).toBe('new-inbox-model');
    expect(result.current.provider).toBe('new-inbox-provider');
    expect(updateAgentConfigById).not.toHaveBeenCalled();
  });

  it('does not invent an inbox id before initialization', () => {
    state.builtinAgentIdMap = {};
    const { result, rerender } = renderHook(() => useJumiChatModel('ppt-agent'));
    expect(result.current).toEqual({
      model: DEFAULT_MODEL,
      provider: DEFAULT_PROVIDER,
      selectionAgentId: '',
    });
    // StoreInitialization loads the inbox even when entering PPT directly.
    state.builtinAgentIdMap = { [INBOX_SESSION_ID]: 'inbox' };
    rerender();
    expect(result.current).toEqual({
      model: 'saved-inbox-model',
      provider: 'custom-inbox-provider',
      selectionAgentId: 'inbox',
    });
    expect(updateAgentConfigById).not.toHaveBeenCalled();
  });
});
