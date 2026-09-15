import { Context, type Plugin } from '@lobechat/cordis-foundation';

import { type PluginBundle, type PluginProfile, resolveProfile } from './profile';

export interface ProfileModule {
  /** A trusted plugin implementation; no path imports or evaluation from configuration. */
  plugin: Plugin;
}

export interface ProfileDefinition {
  bundles: Readonly<Record<string, PluginBundle>>;
  modules: Readonly<Record<string, ProfileModule>>;
  profile: PluginProfile;
}

/** One isolated native plugin generation, pinned until its accepted calls have drained. */
export class LoadedProfile {
  readonly native: Context;
  readonly ready: Promise<void>;
  private closed = false;
  private disposal?: Promise<void>;
  private readonly calls = new Set<Promise<unknown>>();

  constructor(definition: ProfileDefinition) {
    // Resolve getters/config snapshots before allocating any native resources.
    const entries = resolveProfile(definition.profile, definition.bundles).map((entry) => {
      const module = Object.hasOwn(definition.modules, entry.use)
        ? definition.modules[entry.use]
        : undefined;
      if (!module) throw new Error(`CORDIS_PROFILE_MODULE_NOT_FOUND: ${entry.use}`);
      return { ...entry, plugin: module.plugin };
    });
    const native = new Context();
    this.native = native;
    try {
      const children: Array<{ id: string; fiber: ReturnType<Context['plugin']> }> = [];
      const fibers = entries.map(({ id, plugin, config }) =>
        // A unique wrapper gives each entry its own native plugin identity, even if
        // two entries use the same module with different configs.
        native.plugin({
          async apply(ctx) {
            const child = ctx.plugin(plugin, config);
            children.push({ fiber: child, id });
            await child;
          },
          name: id,
        }),
      );
      this.ready = Promise.all(fibers)
        .then(async () => {
          // A pending consumer can become active when a later provider finishes.
          // Validate only after the whole bundle has had the chance to activate.
          while (true) {
            const registered = () =>
              [...native.registry.values()].flatMap((runtime) => [...runtime.fibers]);
            // Modules may install asynchronous child providers without awaiting them.
            // Observe the native tree, including optional child failures handled by
            // their own module, then validate only required profile entries.
            await Promise.allSettled(registered().map((fiber) => fiber.await()));
            // Later providers can activate an earlier consumer after that consumer's
            // await() already returned PENDING. Drain the newly started native work.
            if (registered().some((fiber) => fiber.state === 1 || fiber.state === 5)) continue;
            await Promise.all(children.map(({ fiber }) => fiber.await()));
            const inactive = children.find(({ fiber }) => fiber.state !== 2);
            if (inactive) throw new Error(`CORDIS_PROFILE_PLUGIN_INACTIVE: ${inactive.id}`);
            break;
          }
        })
        .catch(async (error: unknown) => {
          await native.fiber.dispose().catch(() => {});
          throw error;
        });
      void this.ready.catch(() => {});
    } catch (error) {
      void native.fiber.dispose().catch(() => {});
      throw error;
    }
  }

  async run<T>(action: (context: Context) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('CORDIS_PROFILE_DISPOSED');
    // Register before action starts so reentrant retirement can join this call.
    const task = this.ready.then(() => action(this.native));
    this.calls.add(task);
    try {
      return await task;
    } finally {
      this.calls.delete(task);
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.disposal = (async () => {
      await this.ready.catch(() => {});
      await Promise.allSettled(this.calls);
      await this.native.fiber.dispose();
    })();
    return this.disposal;
  }
}

/** Whole-profile replacement. Native service registration is never called "staged". */
export class CordisProfileLoader {
  private current: LoadedProfile;
  private closed = false;
  private mutations: Promise<unknown> = Promise.resolve();
  private disposal?: Promise<void>;

  constructor(definition: ProfileDefinition) {
    this.current = new LoadedProfile(definition);
  }

  run<T>(action: (context: Context) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('CORDIS_PROFILE_LOADER_DISPOSED'));
    return this.current.run(action);
  }

  reload(definition: ProfileDefinition): Promise<void> {
    if (this.closed) return Promise.reject(new Error('CORDIS_PROFILE_LOADER_DISPOSED'));
    // Snapshot configuration now; callers cannot alter a queued reload.
    const snapshot: ProfileDefinition = {
      bundles: structuredClone(definition.bundles),
      modules: Object.fromEntries(
        Object.entries(definition.modules).map(([name, module]) => [
          name,
          { plugin: module.plugin },
        ]),
      ),
      profile: structuredClone(definition.profile),
    };
    const task = this.mutations
      .catch(() => {})
      .then(async () => {
        if (this.closed) throw new Error('CORDIS_PROFILE_LOADER_DISPOSED');
        const candidate = new LoadedProfile(snapshot);
        try {
          await candidate.ready;
          if (this.closed) throw new Error('CORDIS_PROFILE_LOADER_DISPOSED');
        } catch (error) {
          await candidate.dispose();
          throw error;
        }
        const previous = this.current;
        this.current = candidate;
        await previous.dispose();
      });
    this.mutations = task;
    return task;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.disposal = (async () => {
      await this.mutations.catch(() => {});
      await this.current.dispose();
    })();
    return this.disposal;
  }
}
