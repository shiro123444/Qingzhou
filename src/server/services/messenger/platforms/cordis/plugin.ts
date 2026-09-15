import type { Context } from '@lobechat/cordis-foundation';

import type { MessengerPlatformDefinition } from '../types';

/** Generation-root service holding that generation's definition (the real source). */
export const MESSENGER_PLATFORM_DEFINITION_SERVICE = 'messenger.platform.definition' as const;
/** Service published by the optional generation plugin inside the generation context. */
export const MESSENGER_PLATFORM_GENERATION_SERVICE = 'messenger.platform.generation' as const;
/** Registry-level metadata facade (selected platform ids only — never definitions). */
export const MESSENGER_REGISTRY_CATALOG_SERVICE = 'messenger.registry.catalog' as const;

export interface MessengerPlatformGenerationMarker {
  generation: symbol;
  platformId: string;
}

export interface MessengerRegistryCatalog {
  listPlatformIds: () => string[];
}

/**
 * Typed service map, so readers use `ctx.get(name)` without post-hoc assertions.
 * These are the only native keys this module owns.
 */
declare module '@lobechat/cordis-foundation' {
  interface Context {
    'messenger.platform.definition': MessengerPlatformDefinition;
    'messenger.platform.generation': MessengerPlatformGenerationMarker;
    'messenger.registry.catalog': MessengerRegistryCatalog;
  }
}

/** The only validation the registry performs synchronously, before assembling a generation. */
export const validateMessengerPlatformDefinition = (
  definition: MessengerPlatformDefinition,
): void => {
  if (!definition || typeof definition !== 'object' || !definition.id) {
    throw new Error('Messenger platform definition requires an id');
  }
};

/**
 * Optional generation plugin (name + synchronous apply) running inside the
 * generation context. It does not hold the definition: it strictly binds the
 * generation root's definition service to this child fiber, so unloading the
 * generation reclaims the service without relying on a manual map delete.
 *
 * The plugin activates asynchronously (real Cordis), so callers must never claim
 * this fiber is already active when `register()` returns.
 */
export const createMessengerPlatformPlugin = (
  platformId: string,
  generation: symbol,
  removeDefinition: () => void,
) => ({
  name: `messenger.platform.${platformId}`,
  apply(ctx: Context) {
    ctx.effect(() => removeDefinition);
    ctx.provide(MESSENGER_PLATFORM_GENERATION_SERVICE, {
      generation,
      platformId,
    });
  },
});
