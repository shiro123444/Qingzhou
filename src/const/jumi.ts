import type { EnabledProviderWithModels } from '@/types/aiProvider';
import { AiProviderSourceEnum } from '@/types/aiProvider';

export const JUMI_CHAT_MODEL = 'gemini-3.8-flash-high';
export const JUMI_CHAT_PROVIDER = 'nexus';
export const JUMI_CHAT_MODEL_NAME = 'Gemini 3.8 Flash';
export const JUMI_NAME = 'Jumi';
export const JUMI_AVATAR = '/brand/jumi/jumi-white-puppy.png';
export const JUMI_CHAT_MODELS: EnabledProviderWithModels[] = [
  {
    id: JUMI_CHAT_PROVIDER,
    name: JUMI_NAME,
    source: AiProviderSourceEnum.Builtin,
    children: [
      {
        id: JUMI_CHAT_MODEL,
        displayName: JUMI_CHAT_MODEL_NAME,
        abilities: { functionCall: true, vision: true, reasoning: true },
      },
    ],
  },
];
