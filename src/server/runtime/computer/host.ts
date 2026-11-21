import { CordisProfileLoader } from '@lobechat/cordis-runtime';

import type { ComputerProvider, ComputerProviderRegistration } from './provider';

declare module '@lobechat/cordis-foundation' {
  interface Context {
    'qingzhou.computer.provider': ComputerProvider;
  }
}

/** Reading configuration never activates a provider; a generation lives for one accepted call. */
export async function withComputerProvider<T>(
  registration: ComputerProviderRegistration,
  run: (provider: ComputerProvider) => Promise<T>,
): Promise<T> {
  const host = new CordisProfileLoader({
    profile: { bundles: ['computer'] },
    bundles: { computer: { entries: [{ id: registration.id, use: 'provider' }] } },
    modules: {
      provider: {
        manifest: { id: registration.id, version: '1.0.0' },
        load: async () => {
          const provider = await registration.load();
          return {
            apply(ctx) {
              ctx.provide('qingzhou.computer.provider', provider);
            },
          };
        },
      },
    },
  });
  try {
    return await host.run(async (ctx) => {
      const provider = ctx.get('qingzhou.computer.provider');
      if (!provider) throw new Error('COMPUTER_PROVIDER_UNAVAILABLE');
      return run(provider);
    });
  } finally {
    await host.dispose();
  }
}
