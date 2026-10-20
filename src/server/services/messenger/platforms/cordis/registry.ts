import { Context } from '@lobechat/cordis-foundation';

import type { MessengerPlatformDefinition } from '../types';
import {
  createMessengerPlatformPlugin,
  MESSENGER_PLATFORM_DEFINITION_SERVICE,
  MESSENGER_PLATFORM_GENERATION_SERVICE,
  validateMessengerPlatformDefinition,
} from './plugin';

/**
 * One platform generation.
 *
 * The generation owns its own native Cordis root context. The definition is held
 * by that root's `provide` (published synchronously), so it is readable in the
 * same tick; the optional plugin fiber is only the activation/ownership gate.
 * Selection state (ctx + readiness + cleanup) lives here — never the definition.
 */
export interface MessengerPlatformGeneration {
  /** Generation root context owning the definition service. */
  context: Context;
  /** Captured startup failure (may be any falsy thrown value, so a flag guards it). */
  error?: unknown;
  /** Explicit failure flag: `error` may legitimately be `undefined`/`null`. */
  failed: boolean;
  generation: symbol;
  platformId: string;
  /** Resolves once the generation plugin fiber has settled. */
  ready: Promise<void>;
  /** Native disposer for the definition service (also owned by the plugin fiber). */
  removeDefinition: () => void;
}

/**
 * Assemble one generation synchronously.
 *
 * `new Context()` gives the generation its own native root; the root fiber is
 * already ACTIVE, so `root.provide(definitionService, definition)` is readable
 * immediately. A synchronous publication failure propagates as-is, so a caller
 * can never register a ghost entry.
 */
export const createPlatformGeneration = (
  definition: MessengerPlatformDefinition,
  validate: (definition: MessengerPlatformDefinition) => void = validateMessengerPlatformDefinition,
): MessengerPlatformGeneration => {
  validate(definition);

  const context = new Context();
  let removeDefinition: (() => void) | undefined;
  try {
    removeDefinition = context.provide(MESSENGER_PLATFORM_DEFINITION_SERVICE, definition);
  } catch (error) {
    void context.fiber.dispose().catch(() => undefined);
    throw error;
  }

  const generation = Symbol(`messenger.platform.${definition.id}`);
  const platformId = definition.id;

  try {
    const fiber = context.plugin(
      createMessengerPlatformPlugin(platformId, generation, removeDefinition),
    );
    const record: MessengerPlatformGeneration = {
      context,
      failed: false,
      generation,
      platformId,
      removeDefinition,
      ready: Promise.resolve(fiber).then(
        () => undefined,
        (error: unknown) => {
          record.failed = true;
          record.error = error;
        },
      ),
    };
    return record;
  } catch (error) {
    removeDefinition();
    void context.fiber.dispose().catch(() => undefined);
    throw error;
  }
};

/** Read the generation's definition from its root native service (strict read is correct). */
export const readPlatformDefinition = (
  generation: MessengerPlatformGeneration,
): MessengerPlatformDefinition | undefined =>
  generation.context.get(MESSENGER_PLATFORM_DEFINITION_SERVICE);

/** Read the marker published by the generation plugin, once it activated. */
export const readPlatformGenerationMarker = (generation: MessengerPlatformGeneration) =>
  generation.context.get(MESSENGER_PLATFORM_GENERATION_SERVICE);

/** Wait until the generation plugin fiber settled, surfacing any startup failure. */
export const awaitPlatformGeneration = async (
  generation: MessengerPlatformGeneration,
): Promise<void> => {
  await generation.ready;
  // Throw the original value even when it is falsy (undefined/null/0/'').
  if (generation.failed) throw generation.error;
};

/**
 * Reclaim one generation by unloading its native root context. The child plugin
 * fiber unloads first (its effect removes the definition service) and the root's
 * own provide effect is cleared with the root, so ownership is native-owned.
 * The explicit disposer stays as an idempotent safety net.
 */
export const disposePlatformGeneration = async (
  generation: MessengerPlatformGeneration,
): Promise<void> => {
  try {
    await generation.context.fiber.dispose();
  } finally {
    if (readPlatformDefinition(generation)) generation.removeDefinition();
  }
};

export interface SerialQueue {
  run: <T>(key: string, task: () => Promise<T>) => Promise<T>;
  /** Resolves once every queued task for every key has settled. */
  settle: () => Promise<void>;
}

/**
 * Serialize lifecycle changes per key so two changes to the same platform never
 * interleave, while unrelated platforms stay independent.
 *
 * Each entry removes itself once its own promise settles, and only when the key
 * still points at that same promise — a newer chain queued for the same key is
 * never deleted by an older one.
 */
export const createSerialQueue = (): SerialQueue => {
  const chains = new Map<string, Promise<void>>();
  const settle = async (): Promise<void> => {
    while (chains.size > 0) {
      await Promise.allSettled(chains.values());
    }
  };
  return {
    run: <T>(key: string, task: () => Promise<T>): Promise<T> => {
      const previous = chains.get(key) ?? Promise.resolve();
      // Run regardless of the previous outcome.
      const next = previous.then(task, task);
      // Observe both outcomes so a rejection is never unhandled; `tracked` always resolves.
      const tracked = next.then(
        () => undefined,
        () => undefined,
      );
      chains.set(key, tracked);
      void tracked.then(() => {
        if (chains.get(key) === tracked) chains.delete(key);
      });
      return next;
    },
    settle,
  };
};

export const createRegistryClosedError = (): Error & { code: string } =>
  Object.assign(new Error('Messenger platform registry is disposed'), {
    code: 'CORDIS_REGISTRY_CLOSED',
  });
