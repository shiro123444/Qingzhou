import { LazyClientFactory } from '../../lazyClientFactory';

export const sharedClientFactory = new LazyClientFactory(async () => {
  const { FeishuClientFactory } = await import('../client');
  return new FeishuClientFactory();
});
