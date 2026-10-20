import { useAiInfraStore } from '@/store/aiInfra';
import { type EnabledProviderWithModels } from '@/types/aiProvider';

const EMPTY_MODELS: EnabledProviderWithModels[] = [];

/** Use the authenticated user's enabled provider/model catalogue. */
export const useEnabledChatModels = (): EnabledProviderWithModels[] =>
  useAiInfraStore((s) => s.enabledChatModelList ?? EMPTY_MODELS);
