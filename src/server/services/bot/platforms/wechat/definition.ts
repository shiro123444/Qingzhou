import { LazyClientFactory } from '../lazyClientFactory';
import type { PlatformDefinition } from '../types';
import { schema } from './schema';

export const wechat: PlatformDefinition = {
  id: 'wechat',
  name: 'WeChat',
  connectionMode: 'polling',
  description: 'Connect a WeChat bot via iLink API',
  documentation: {
    setupGuideUrl: 'https://lobehub.com/docs/usage/channels/wechat',
  },
  schema,
  supportsMessageEdit: false,
  clientFactory: new LazyClientFactory(async () => {
    const { WechatClientFactory } = await import('./client');
    return new WechatClientFactory();
  }),
};
