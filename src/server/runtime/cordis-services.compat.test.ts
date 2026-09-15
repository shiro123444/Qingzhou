/**
 * QZ-CORDIS-E — real Cordis service-contract regression.
 *
 * Uses the vendored upstream foundation (`packages/cordis-foundation`,
 * re-exporting `@deepseek-ai/cordis` 4.0.2) directly — not the legacy kernel
 * Context. Behaviour below was read off `vendor/cordis/src/{fiber,reflect,registry}.ts`
 * and each assertion checks a real state, a service value, or a cleanup count.
 *
 * Verified boundaries:
 *  - `provide()` only makes a service visible while the providing fiber is
 *    ACTIVE (`ReflectService._getImpl(name, strict=true)`).
 *  - Losing a dependency moves the consumer to PENDING; re-providing the name
 *    restarts it through `Fiber._setEpoch -> _reload`.
 *  - A provider's unload awaits notified dependents (`provide`'s disposer does
 *    `Promise.allSettled(fibers.map(fiber => fiber.await()))`), so async
 *    dependent cleanup is included, not fire-and-forget.
 *  - `isolate(name, label)` isolates only the *named* service; other names fall
 *    back to the root default scope. `Context.extend()` is not isolation.
 *  - Native `provide` is not staged/transactional: a duplicate in the same
 *    isolation domain throws immediately and mutates nothing.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { Context } from '../../../packages/cordis-foundation/src';

const roots: Context[] = [];

/** Every test registers its root here so teardown always runs. */
const createRoot = (): Context => {
  const root = new Context();
  roots.push(root);
  return root;
};

afterEach(async () => {
  const pending = roots.splice(0);
  for (const root of pending) {
    try {
      await root.fiber.dispose();
    } catch {
      // A teardown failure must not mask the test result.
    }
  }
});

/**
 * Ordinal mirror of the vendored `FiberState`
 * (`vendor/cordis/src/fiber.ts`: PENDING, LOADING, ACTIVE, FAILED, DISPOSED,
 * UNLOADING). The enum is a `const enum`, so its members are not imported.
 */
const FIBER_STATE_NAMES: Record<number, string> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
  5: 'unloading',
};

const stateName = (fiber: { state: unknown }): string =>
  FIBER_STATE_NAMES[fiber.state as number] ?? 'unknown';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

/** Drain microtasks without sleeping or asserting on wall-clock time. */
const flushMicrotasks = async (turns = 20): Promise<void> => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};

const providerPlugin = (name: string, value: unknown) => ({
  apply: (ctx: Context) => {
    ctx.provide(name, value);
  },
});

const consumerPlugin = (name: string, onActivate: (ctx: Context) => void) => ({
  inject: [name],
  apply: (ctx: Context) => {
    onActivate(ctx);
  },
});

describe('QZ-CORDIS-E real Cordis service contract', () => {
  it('[1] exposes a service only once its provider is active', async () => {
    const root = createRoot();
    const activations = { count: 0 };
    const seen: unknown[] = [];

    const provider = root.plugin({
      inject: ['upstream'],
      apply: (ctx: Context) => {
        ctx.provide('svc', 'ready');
      },
    });
    const consumer = root.plugin(
      consumerPlugin('svc', (ctx) => {
        activations.count += 1;
        seen.push(ctx.get('svc'));
      }),
    );

    await provider.await();
    await consumer.await();

    // Provider waits for its own dependency, so consumers must stay pending.
    expect(stateName(provider)).toBe('pending');
    expect(stateName(consumer)).toBe('pending');
    expect(root.get('svc')).toBeUndefined();
    expect(activations.count).toBe(0);

    const upstream = root.plugin(providerPlugin('upstream', { ready: true }));
    await upstream.await();
    await provider.await();
    await consumer.await();

    expect(stateName(provider)).toBe('active');
    expect(stateName(consumer)).toBe('active');
    expect(root.get('svc')).toBe('ready');
    expect(activations.count).toBe(1);
    expect(seen).toEqual(['ready']);
  });

  it('[2] reclaims dependents on unload and restarts them when the service returns', async () => {
    const root = createRoot();
    const activations = { count: 0 };
    const cleanups = { count: 0 };
    const seen: unknown[] = [];

    const provider = root.plugin(providerPlugin('svc', 'v1'));
    await provider.await();

    const consumer = root.plugin(
      consumerPlugin('svc', (ctx) => {
        activations.count += 1;
        seen.push(ctx.get('svc'));
        ctx.effect(() => () => {
          cleanups.count += 1;
        });
      }),
    );
    await consumer.await();

    expect(stateName(consumer)).toBe('active');
    expect(activations.count).toBe(1);
    expect(seen).toEqual(['v1']);

    await provider.dispose();

    expect(stateName(consumer)).toBe('pending');
    expect(cleanups.count).toBe(1);
    expect(root.get('svc')).toBeUndefined();

    const replacement = root.plugin(providerPlugin('svc', 'v2'));
    await replacement.await();
    await consumer.await();

    expect(stateName(consumer)).toBe('active');
    expect(activations.count).toBe(2);
    expect(seen).toEqual(['v1', 'v2']);
  });

  it('[3] does not revive an explicitly disposed consumer', async () => {
    const root = createRoot();
    const activations = { count: 0 };

    const provider = root.plugin(providerPlugin('svc', 'v1'));
    await provider.await();

    const consumer = root.plugin(
      consumerPlugin('svc', () => {
        activations.count += 1;
      }),
    );
    await consumer.await();
    expect(activations.count).toBe(1);

    await consumer.dispose();
    expect(stateName(consumer)).toBe('disposed');

    await provider.dispose();

    const replacement = root.plugin(providerPlugin('svc', 'v2'));
    await replacement.await();
    await flushMicrotasks();

    expect(activations.count).toBe(1);
    expect(stateName(consumer)).toBe('disposed');
  });

  it('[4] isolates the named service per scope while extend is not isolation', async () => {
    const root = createRoot();
    const scopeA = root.isolate('svc');
    const scopeB = root.isolate('svc');

    const aProvider = scopeA.plugin(providerPlugin('svc', 'A'));
    await aProvider.await();
    const bProvider = scopeB.plugin(providerPlugin('svc', 'B'));
    await bProvider.await();

    const aSeen: unknown[] = [];
    const bSeen: unknown[] = [];
    const aConsumer = scopeA.plugin(consumerPlugin('svc', (ctx) => aSeen.push(ctx.get('svc'))));
    const bConsumer = scopeB.plugin(consumerPlugin('svc', (ctx) => bSeen.push(ctx.get('svc'))));
    await aConsumer.await();
    await bConsumer.await();

    expect(scopeA.get('svc')).toBe('A');
    expect(scopeB.get('svc')).toBe('B');
    expect(root.get('svc')).toBeUndefined();
    expect(aSeen).toEqual(['A']);
    expect(bSeen).toEqual(['B']);

    await aProvider.dispose();

    expect(stateName(aConsumer)).toBe('pending');
    expect(stateName(bConsumer)).toBe('active');
    expect(bSeen).toEqual(['B']);
    expect(scopeB.get('svc')).toBe('B');

    // Context.extend() without isolate() shares the root default scope: a
    // service provided from it is readable from the root and sibling scopes.
    const alias = root.extend({});
    const aliasProvider = alias.plugin(providerPlugin('shared', 'shared'));
    await aliasProvider.await();

    const sharedSeen: unknown[] = [];
    const rootConsumer = root.plugin(
      consumerPlugin('shared', (ctx) => sharedSeen.push(ctx.get('shared'))),
    );
    await rootConsumer.await();

    expect(sharedSeen).toEqual(['shared']);
    expect(root.get('shared')).toBe('shared');
    expect(scopeA.get('shared')).toBe('shared');
  });

  it('[5] waits for dependent async cleanup before the provider unload settles', async () => {
    const root = createRoot();
    const gate = deferred();
    let cleanupStarted = false;
    let cleanupFinished = false;
    let disposing: Promise<void> | undefined;

    try {
      const provider = root.plugin(providerPlugin('svc', 'v1'));
      await provider.await();

      const consumer = root.plugin({
        inject: ['svc'],
        apply: (ctx: Context) => {
          ctx.effect(() => async () => {
            cleanupStarted = true;
            await gate.promise;
            cleanupFinished = true;
          });
        },
      });
      await consumer.await();
      expect(stateName(consumer)).toBe('active');

      disposing = provider.dispose();
      await flushMicrotasks();
      expect(cleanupStarted).toBe(true);

      let providerSettled = false;
      void disposing.then(() => {
        providerSettled = true;
      });
      await flushMicrotasks();

      // The provider's unload must be held open by the dependent's cleanup.
      expect(providerSettled).toBe(false);
      expect(cleanupFinished).toBe(false);

      gate.resolve();
      await disposing;

      expect(cleanupFinished).toBe(true);
      expect(stateName(consumer)).toBe('pending');
    } finally {
      // Release the gate even if an assertion above failed, so the pending
      // unload never dangles past this test.
      gate.resolve();
      await disposing?.catch(() => undefined);
    }
  });

  it('[6] rejects duplicate provide and keeps the active provider alive', async () => {
    const root = createRoot();

    const provider = root.plugin(providerPlugin('dup', 'v1'));
    await provider.await();
    expect(root.get('dup')).toBe('v1');

    // Same isolation domain: the candidate's provide throws immediately.
    const candidate = root.plugin(providerPlugin('dup', 'v2'));
    await expect(candidate.await()).rejects.toThrow(/has been registered/);

    expect(stateName(candidate)).toBe('failed');
    expect(stateName(provider)).toBe('active');
    expect(root.get('dup')).toBe('v1');

    // A second provide inside one fiber is rejected too, and the first wins.
    let secondError: unknown;
    const double = root.plugin({
      apply: (ctx: Context) => {
        ctx.provide('own', 'first');
        try {
          ctx.provide('own', 'second');
        } catch (error) {
          secondError = error;
        }
      },
    });
    await double.await();

    expect(String(secondError)).toMatch(/has been registered/);
    expect(root.get('own')).toBe('first');
  });
});
