import { describe, expect, it } from 'vitest';

import { resolveProfile } from './profile';

describe('profile composition', () => {
  it('expands shared bundles once, applies ID patches in order and snapshots config', () => {
    const config = { theme: { color: 'blue' } };
    const bundles = {
      assets: { entries: [{ config, id: 'image', use: 'image.v1' }] },
      presentation: { entries: [{ id: 'planner', use: 'planner' }], includes: ['assets'] },
    };
    const result = resolveProfile(
      {
        bundles: ['presentation', 'assets'],
        patches: [
          { entry: { id: 'planner', use: 'planner.v2' }, op: 'replace' },
          { entry: { id: 'vision', use: 'vision' }, op: 'add' },
        ],
      },
      bundles,
    );
    config.theme.color = 'red';
    expect(result).toEqual([
      { config: { theme: { color: 'blue' } }, id: 'image', use: 'image.v1' },
      { id: 'planner', use: 'planner.v2' },
      { id: 'vision', use: 'vision' },
    ]);
    expect(bundles.presentation.entries[0].use).toBe('planner');
  });

  it('rejects cycles, duplicates, missing patch targets and inherited module names', () => {
    expect(() =>
      resolveProfile(
        { bundles: ['a'] },
        {
          a: { entries: [], includes: ['b'] },
          b: { entries: [], includes: ['a'] },
        },
      ),
    ).toThrow('CORDIS_PROFILE_CYCLE');
    expect(() =>
      resolveProfile(
        { bundles: ['a'] },
        {
          a: {
            entries: [
              { id: 'x', use: 'one' },
              { id: 'x', use: 'two' },
            ],
          },
        },
      ),
    ).toThrow('CORDIS_PROFILE_DUPLICATE');
    expect(() => resolveProfile({ bundles: [], patches: [{ id: 'x', op: 'remove' }] }, {})).toThrow(
      'CORDIS_PROFILE_MISSING',
    );
    expect(() => resolveProfile({ bundles: ['__proto__'] }, {})).toThrow(
      'CORDIS_PROFILE_BUNDLE_NOT_FOUND',
    );
  });
});
