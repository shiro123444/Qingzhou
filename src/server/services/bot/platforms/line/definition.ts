import { LazyClientFactory } from '../lazyClientFactory';
import type { PlatformDefinition } from '../types';
import { schema } from './schema';

export const line: PlatformDefinition = {
  id: 'line',
  name: 'LINE',
  connectionMode: 'webhook',
  description: 'Connect a LINE Messaging API bot for direct and group chats.',
  documentation: {
    portalUrl: 'https://developers.line.biz/console/',
    setupGuideUrl: 'https://lobehub.com/docs/usage/channels/line',
  },
  schema,
  showWebhookUrl: true,
  supportsMarkdown: false,
  supportsMessageEdit: false,
  clientFactory: new LazyClientFactory(async () => {
    const { LineClientFactory } = await import('./client');
    return new LineClientFactory();
  }),
};
