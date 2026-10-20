import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useAiInfraStore } from '@/store/aiInfra';
import { type AiInfraStore } from '@/store/aiInfra/store';
import { AiProviderSourceEnum, type EnabledProviderWithModels } from '@/types/aiProvider';

import { useEnabledChatModels } from './useEnabledChatModels';

vi.mock('@/store/aiInfra', () => ({ useAiInfraStore: vi.fn() }));

describe('useEnabledChatModels', () => {
  it('uses the user catalogue, including custom providers and model capabilities', () => {
    const enabledChatModelList: EnabledProviderWithModels[] = [
      {
        children: [{ abilities: { vision: true }, id: 'user-enabled-model' }],
        id: 'user-provider',
        name: 'My provider',
        source: AiProviderSourceEnum.Custom,
      },
    ];
    vi.mocked(useAiInfraStore).mockImplementation((selector) =>
      selector({ enabledChatModelList } as AiInfraStore),
    );
    const { result } = renderHook(() => useEnabledChatModels());
    expect(result.current).toBe(enabledChatModelList);
  });

  it('does not inject a fixed model into an empty or uninitialized catalogue', () => {
    let enabledChatModelList: EnabledProviderWithModels[] | undefined = undefined;
    vi.mocked(useAiInfraStore).mockImplementation((selector) =>
      selector({ enabledChatModelList } as AiInfraStore),
    );
    const { result, rerender } = renderHook(() => useEnabledChatModels());
    expect(result.current).toEqual([]);
    const initial = result.current;
    rerender();
    expect(result.current).toBe(initial);
    enabledChatModelList = [];
    rerender();
    expect(result.current).toBe(enabledChatModelList);
  });
});
