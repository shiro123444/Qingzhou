import { INBOX_SESSION_ID } from '@lobechat/const';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEnabledChatModels } from '@/hooks/useEnabledChatModels';
import { useAgentStore } from '@/store/agent';
import { type AgentStore } from '@/store/agent/store';
import { AiProviderSourceEnum } from '@/types/aiProvider';

import { useAgentId } from '../../hooks/useAgentId';
import ModelSwitch from '../Model';
import ModelLabel from './index';

vi.mock('@lobehub/ui', () => ({
  Center: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Flexbox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@lobehub/icons', () => ({ ModelIcon: () => null }));
vi.mock('@/store/agent', () => ({ useAgentStore: vi.fn() }));
vi.mock('@/hooks/useEnabledChatModels', () => ({ useEnabledChatModels: vi.fn() }));
vi.mock('../../hooks/useAgentId', () => ({ useAgentId: vi.fn() }));
vi.mock('../context', () => ({ useActionBarContext: () => ({ dropdownPlacement: 'topLeft' }) }));
vi.mock('@/features/ModelSwitchPanel', () => ({
  default: ({
    children,
    onModelChange,
    open,
  }: {
    children: ReactNode;
    open?: boolean;
    onModelChange: (selection: { model: string; provider: string }) => Promise<void>;
  }) => (
    <div>
      {children}
      <button
        disabled={open === false}
        onClick={() => void onModelChange({ model: 'selected-model', provider: 'custom' })}
      >
        Select model
      </button>
    </div>
  ),
}));

const updateAgentConfigById = vi.fn().mockResolvedValue(undefined);
let state: AgentStore;

beforeEach(() => {
  vi.clearAllMocks();
  state = {
    agentMap: {
      inbox: { model: 'shared-model', provider: 'custom' },
      other: { model: 'other-model', provider: 'other-provider' },
    },
    builtinAgentIdMap: { [INBOX_SESSION_ID]: 'inbox' },
    updateAgentConfigById,
  } as unknown as AgentStore;
  vi.mocked(useAgentStore).mockImplementation((selector) => selector(state));
  vi.mocked(useAgentId).mockReturnValue('ppt-agent');
  vi.mocked(useEnabledChatModels).mockReturnValue([
    {
      children: [{ abilities: {}, displayName: 'Wrong provider label', id: 'shared-model' }],
      id: 'other-provider',
      name: 'Other',
      source: AiProviderSourceEnum.Custom,
    },
    {
      children: [
        { abilities: { vision: true }, displayName: 'My visual model', id: 'shared-model' },
      ],
      id: 'custom',
      name: 'Custom',
      source: AiProviderSourceEnum.Custom,
    },
  ]);
});

describe('chat input saved provider selectors', () => {
  it.each([
    ['icon', ModelSwitch],
    ['label', ModelLabel],
  ] as const)('%s selector saves PPT changes to the real inbox agent', async (_, Component) => {
    render(<Component />);
    expect(updateAgentConfigById).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Select model' }));
    await waitFor(() =>
      expect(updateAgentConfigById).toHaveBeenCalledWith('inbox', {
        model: 'selected-model',
        provider: 'custom',
      }),
    );
  });

  it('displays the selected provider model label rather than a fixed brand model', () => {
    render(<ModelLabel />);
    expect(screen.getByText('My visual model')).toBeTruthy();
    expect(screen.queryByText('Wrong provider label')).toBeNull();
  });

  it('preserves the real agent target outside PPT', async () => {
    vi.mocked(useAgentId).mockReturnValue('other');
    render(<ModelLabel />);
    expect(screen.getByText('other-model')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select model' }));
    await waitFor(() =>
      expect(updateAgentConfigById).toHaveBeenCalledWith('other', {
        model: 'selected-model',
        provider: 'custom',
      }),
    );
  });

  it('never persists a virtual PPT agent while inbox is loading', () => {
    state.builtinAgentIdMap = {};
    render(<ModelLabel />);
    expect(screen.getByRole('button', { name: 'Select model' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Select model' }));
    expect(updateAgentConfigById).not.toHaveBeenCalled();
  });
});
