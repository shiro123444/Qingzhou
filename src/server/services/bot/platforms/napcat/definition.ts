import {
  allowFromField,
  makeDmPolicyField,
  makeGroupPolicyFields,
  makeUserIdField,
  watchKeywordsField,
} from '../const';
import { LazyClientFactory } from '../lazyClientFactory';
import type { PlatformDefinition } from '../types';

export const napcat: PlatformDefinition = {
  id: 'napcat',
  name: 'QQ / NapCat',
  connectionMode: 'websocket',
  supportsMarkdown: false,
  supportsMessageEdit: false,
  documentation: { setupGuideUrl: 'https://napneko.github.io/config/basic' },
  clientFactory: new LazyClientFactory(async () => {
    const { NapCatClientFactory } = await import('./client');
    return new NapCatClientFactory();
  }),
  schema: [
    {
      key: 'applicationId',
      label: 'channel.napcatAccount',
      description: 'channel.napcatAccountHint',
      type: 'string',
      required: true,
    },
    {
      key: 'credentials',
      label: 'channel.credentials',
      type: 'object',
      properties: [
        {
          key: 'accessToken',
          label: 'channel.napcatToken',
          description: 'channel.napcatTokenHint',
          type: 'password',
          required: true,
        },
      ],
    },
    {
      key: 'settings',
      label: 'channel.settings',
      type: 'object',
      properties: [
        {
          key: 'websocketUrl',
          label: 'channel.napcatUrl',
          description: 'channel.napcatUrlHint',
          type: 'string',
          required: true,
          default: 'ws://127.0.0.1:3001/',
        },
        makeUserIdField(),
        {
          key: 'charLimit',
          label: 'channel.charLimit',
          type: 'number',
          default: 2000,
          minimum: 100,
          maximum: 2000,
        },
        makeDmPolicyField({ policy: 'disabled' }),
        ...makeGroupPolicyFields({ policy: 'allowlist' }),
        allowFromField,
        watchKeywordsField,
      ],
    },
  ],
};
