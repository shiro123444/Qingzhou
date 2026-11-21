import { create } from 'zustand';

import { formatUiAttention, type UiAttention } from '@/types/uiAttention';

interface AttentionState {
  agentId?: string;
  enabled: boolean;
  ownerId?: string;
  signal?: UiAttention;
}

/** Ephemeral, account-scoped. No persistence and no raw pointer/input data. */
export const useUiAttentionStore = create<AttentionState>(() => ({ enabled: true }));

export function readUiAttention(ownerId?: string, agentId?: string): UiAttention | undefined {
  const state = useUiAttentionStore.getState();
  if (
    !ownerId ||
    !agentId ||
    !state.enabled ||
    ownerId !== state.ownerId ||
    agentId !== state.agentId ||
    !formatUiAttention(state.signal)
  )
    return;
  return state.signal;
}
