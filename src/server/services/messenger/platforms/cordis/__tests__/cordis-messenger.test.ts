// @vitest-environment node
import { Context } from '@lobechat/cordis-foundation';
import { afterEach, describe, expect, it } from 'vitest';

import type { MessengerPlatformDefinition } from '../../types';
import {
  awaitPlatformGeneration,
  createPlatformGeneration,
  createSerialQueue,
  disposePlatformGeneration,
  MESSENGER_PLATFORM_DEFINITION_SERVICE,
  readPlatformDefinition,
  readPlatformGenerationMarker,
} from '..';

const buildDefinition = (
  overrides: Partial<MessengerPlatformDefinition> = {},
): MessengerPlatformDefinition =>
  ({
    connectionMode: 'webhook',
    createBinder: () => ({ id: 'binder' }),
    id: 'slack',
    name: 'Slack',
    ...overrides,
  }) as MessengerPlatformDefinition;

describe('cordis messenger platform generation', () => {
  const generations: ReturnType<typeof createPlatformGeneration>[] = [];

  const track = <T extends ReturnType<typeof createPlatformGeneration>>(generation: T): T => {
    generations.push(generation);
    return generation;
  };

  afterEach(async () => {
    for (const generation of generations.splice(0)) {
      try {
        await disposePlatformGeneration(generation);
      } catch {
        // Teardown failures must not mask the test result.
      }
    }
  });

  it('holds the definition on an independent native generation root, readable in the same tick', async () => {
    const generation = track(createPlatformGeneration(buildDefinition()));

    expect(Context.is(generation.context)).toBe(true);
    // Root-context provide is synchronous: readable (strict) before any await.
    expect(readPlatformDefinition(generation)?.id).toBe('slack');
    // The generation plugin activates asynchronously — never claim it is active here.
    expect(readPlatformGenerationMarker(generation)).toBeUndefined();

    await awaitPlatformGeneration(generation);
    expect(readPlatformGenerationMarker(generation)?.platformId).toBe('slack');
  });

  it('keeps each generation isolated in its own native context', async () => {
    const first = track(createPlatformGeneration(buildDefinition({ name: 'v1' })));
    const second = track(createPlatformGeneration(buildDefinition({ name: 'v2' })));

    expect(first.context).not.toBe(second.context);
    expect(readPlatformDefinition(first)?.name).toBe('v1');
    expect(readPlatformDefinition(second)?.name).toBe('v2');

    await awaitPlatformGeneration(first);
    await awaitPlatformGeneration(second);
    expect(readPlatformGenerationMarker(first)?.generation).not.toBe(
      readPlatformGenerationMarker(second)?.generation,
    );
  });

  it('surfaces a synchronous definition failure without assembling a generation', () => {
    const invalidDefinition = buildDefinition();
    Reflect.set(invalidDefinition, 'id', '');
    expect(() => createPlatformGeneration(invalidDefinition)).toThrow(/requires an id/);
    expect(() =>
      createPlatformGeneration(undefined as unknown as MessengerPlatformDefinition),
    ).toThrow(/requires an id/);
  });

  it('reclaims the definition service through the native generation root on dispose', async () => {
    const generation = createPlatformGeneration(buildDefinition({ id: 'telegram' }));
    await awaitPlatformGeneration(generation);
    expect(readPlatformDefinition(generation)).toBeDefined();

    await disposePlatformGeneration(generation);

    // Root unload clears the provide effect, so no manual map delete is needed.
    expect(readPlatformDefinition(generation)).toBeUndefined();
    expect(readPlatformGenerationMarker(generation)).toBeUndefined();
    expect(generation.context.get(MESSENGER_PLATFORM_DEFINITION_SERVICE)).toBeUndefined();
  });

  it('serializes changes per key and settles every queued task', async () => {
    const queue = createSerialQueue();
    const order: string[] = [];

    const first = queue.run('slack', async () => {
      await Promise.resolve();
      order.push('first');
      return 1;
    });
    const second = queue.run('slack', async () => {
      order.push('second');
      return 2;
    });
    const other = queue.run('telegram', async () => {
      order.push('telegram');
      return 3;
    });

    await expect(Promise.all([first, second, other])).resolves.toEqual([1, 2, 3]);
    // Serialization is per key: slack's tasks keep submission order, telegram is independent.
    expect(order.filter((step) => step !== 'telegram')).toEqual(['first', 'second']);
    expect(order).toContain('telegram');

    // settle() must terminate (entries remove themselves once their own promise
    // settles) and must not delete a newer chain queued for the same key.
    await queue.settle();
    expect(order.filter((step) => step !== 'telegram')).toEqual(['first', 'second']);

    await expect(queue.run('slack', async () => 'after')).resolves.toBe('after');
    await queue.settle();
  });
});
