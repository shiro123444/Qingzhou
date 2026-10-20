import { Context } from '@lobechat/cordis-foundation';

import type { InstallationCredentials } from '../installations/types';
import type { MessengerPlatformBinder } from '../types';
import {
  awaitPlatformGeneration,
  createPlatformGeneration,
  createRegistryClosedError,
  createSerialQueue,
  disposePlatformGeneration,
  MESSENGER_REGISTRY_CATALOG_SERVICE,
  type MessengerPlatformGeneration,
  readPlatformDefinition,
} from './cordis';
import type { MessengerPlatformDefinition, SerializedMessengerPlatformDefinition } from './types';

export interface MessengerPlatformRegistryOptions {
  /** Injected for tests; defaults to a fresh native Cordis root context. */
  context?: Context;
}

/**
 * Selection entry.
 *
 * `blueprint` is the read-only registration config used to (re)build a
 * generation; it is NOT the active definition source. The active definition only
 * ever comes from the selected generation's own native root service.
 */
interface IndexedGeneration {
  blueprint: MessengerPlatformDefinition;
  /** Undefined while the platform is unmounted (its generation was reclaimed). */
  generation?: MessengerPlatformGeneration;
  mounted: boolean;
}

/**
 * Messenger platform registry — assembles platform definitions onto real Cordis.
 *
 * Every registered platform gets its own generation: an independent native
 * `Context` whose root `provide` holds the definition (published synchronously,
 * so `register()` keeps its sync read-after-write contract without any
 * fire-and-forget mount) plus a generation plugin fiber used as the activation
 * and cleanup owner.
 *
 * The index stores only the blueprint plus the generation handle (native ctx,
 * readiness, cleanup). Active reads always resolve through the selected
 * generation's native service — never through the blueprint.
 */
export class MessengerPlatformRegistry {
  readonly native: Context;

  private readonly index = new Map<string, IndexedGeneration>();
  private readonly serial = createSerialQueue();
  private closed = false;
  private disposal?: Promise<void>;

  constructor(options: MessengerPlatformRegistryOptions = {}) {
    this.native = options.context ?? new Context();
    // Registry-level metadata facade only (ids) — definitions live per generation.
    this.native.provide(MESSENGER_REGISTRY_CATALOG_SERVICE, {
      listPlatformIds: () => {
        this.assertOpen();
        return [...this.index.keys()];
      },
    });
  }

  /** Register a platform definition. Throws if the platform ID is already registered. */
  register(definition: MessengerPlatformDefinition): this {
    this.assertOpen();
    if (this.index.has(definition?.id)) {
      throw new Error(`Messenger platform "${definition.id}" is already registered`);
    }
    // Synchronous assembly of the generation root service; throws as-is on failure.
    const generation = createPlatformGeneration(definition);
    this.index.set(definition.id, { blueprint: definition, generation, mounted: true });
    return this;
  }

  /** Get a platform definition by ID. */
  getPlatform(platform: string): MessengerPlatformDefinition | undefined {
    this.assertOpen();
    const entry = this.index.get(platform);
    if (!entry || !entry.mounted || !entry.generation) return undefined;
    this.surfaceGenerationFailure(entry.generation);
    return readPlatformDefinition(entry.generation);
  }

  /** List all selected platform definitions. */
  listPlatforms(): MessengerPlatformDefinition[] {
    this.assertOpen();
    const definitions: MessengerPlatformDefinition[] = [];
    for (const entry of this.index.values()) {
      if (!entry.mounted || !entry.generation) continue;
      this.surfaceGenerationFailure(entry.generation);
      const definition = readPlatformDefinition(entry.generation);
      if (definition) definitions.push(definition);
    }
    return definitions;
  }

  /**
   * List platform definitions serialized for the frontend — drops the
   * factory and gate fields that aren't safe to ship over TRPC.
   */
  listSerializedPlatforms(): SerializedMessengerPlatformDefinition[] {
    return this.listPlatforms().map(
      ({ createBinder: _createBinder, oauth: _oauth, webhookGate: _webhookGate, ...rest }) => rest,
    );
  }

  /**
   * Build the per-platform binder for a resolved install. Returns null if the
   * platform isn't selected (so callers can `404` cleanly without throwing).
   */
  createBinder(creds: InstallationCredentials): MessengerPlatformBinder | null {
    const definition = this.getPlatform(creds.platform);
    return definition ? definition.createBinder(creds) : null;
  }

  /** Wait until every selected generation has settled. */
  async ready(): Promise<void> {
    this.assertOpen();
    for (const entry of this.index.values()) {
      if (entry.generation) await awaitPlatformGeneration(entry.generation);
    }
  }

  /**
   * Build a fresh generation from the platform blueprint and select it once the
   * native plugin settled. Serialized per platform.
   */
  async mountPlatform(platformId: string): Promise<void> {
    return this.serial.run(platformId, async () => {
      this.assertOpen();
      const entry = this.requireEntry(platformId);
      if (entry.mounted && entry.generation) {
        await awaitPlatformGeneration(entry.generation);
        return;
      }

      const candidate = createPlatformGeneration(entry.blueprint);
      try {
        await awaitPlatformGeneration(candidate);
      } catch (error) {
        await disposePlatformGeneration(candidate).catch(() => undefined);
        throw error;
      }
      // A concurrent dispose may have closed the registry while we awaited.
      if (this.closed) {
        await disposePlatformGeneration(candidate).catch(() => undefined);
        throw createRegistryClosedError();
      }

      entry.generation = candidate;
      entry.mounted = true;
    });
  }

  /** Reclaim the platform's generation so it leaves the readable set. Serialized per platform. */
  async unmountPlatform(platformId: string): Promise<void> {
    return this.serial.run(platformId, async () => {
      this.assertOpen();
      const entry = this.requireEntry(platformId);
      const current = entry.generation;
      entry.generation = undefined;
      entry.mounted = false;
      if (current) await disposePlatformGeneration(current);
    });
  }

  /**
   * Replace the platform's generation. The candidate runs in its own native
   * context and must settle before the selection pointer moves; a failed
   * candidate is reclaimed and the previous blueprint/definition stays selected.
   */
  async reloadPlatform(
    platformId: string,
    updatedDefinition?: MessengerPlatformDefinition,
  ): Promise<void> {
    return this.serial.run(platformId, async () => {
      this.assertOpen();
      const entry = this.requireEntry(platformId);
      if (updatedDefinition && updatedDefinition.id !== platformId) {
        throw new Error(
          `Reload definition id mismatch: "${updatedDefinition.id}" !== "${platformId}"`,
        );
      }

      const nextBlueprint = updatedDefinition ?? entry.blueprint;
      const candidate = createPlatformGeneration(nextBlueprint);
      try {
        await awaitPlatformGeneration(candidate);
      } catch (error) {
        await disposePlatformGeneration(candidate).catch(() => undefined);
        throw error;
      }
      if (this.closed) {
        await disposePlatformGeneration(candidate).catch(() => undefined);
        throw createRegistryClosedError();
      }

      const previous = entry.generation;
      entry.blueprint = nextBlueprint;
      entry.generation = candidate;
      entry.mounted = true;
      if (previous) await disposePlatformGeneration(previous);
    });
  }

  /** Idempotently close the registry, reclaiming every generation. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.disposal = (async () => {
      await this.serial.settle();
      const generations = [...this.index.values()]
        .map((entry) => entry.generation)
        .filter((generation): generation is MessengerPlatformGeneration => Boolean(generation));
      await Promise.allSettled(
        generations.map((generation) => disposePlatformGeneration(generation)),
      );
      await this.native.fiber.dispose();
    })();
    return this.disposal;
  }

  private requireEntry(platformId: string): IndexedGeneration {
    const entry = this.index.get(platformId);
    if (!entry) throw new Error(`Messenger platform "${platformId}" is not registered`);
    return entry;
  }

  /** A failed generation must be visible, never a silent ghost selection. */
  private surfaceGenerationFailure(generation: MessengerPlatformGeneration): void {
    if (generation.failed) throw generation.error;
  }

  private assertOpen(): void {
    if (this.closed) throw createRegistryClosedError();
  }
}
