import { describe, expect, it } from 'vitest';

import { type GlassVolume } from './raytrace';
import { resolveSceneDepths, type SceneDepthEntry } from './scene';

const entry = (
  id: string,
  front = 28,
  center: GlassVolume['center'] = [0, 0, 25],
  size: GlassVolume['size'] = [100, 60, 6],
): SceneDepthEntry => ({
  front,
  kind: 'panel',
  volume: { absorption: [0, 0, 0], bevel: 3, center, id, ior: 1.45, radius: 12, size },
});
const back = (item: SceneDepthEntry) => item.front - item.volume.size[2];

describe('resolveSceneDepths', () => {
  it('keeps non-shell glass strictly above the page content plane', () => {
    const [resolved] = resolveSceneDepths([entry('low', -20)]);
    expect(back(resolved)).toBeGreaterThan(8.2);
    expect(resolved.volume.center[2] + resolved.volume.size[2] / 2).toBe(resolved.front);
    const [shell] = resolveSceneDepths([
      { ...entry('shell', 4, [0, 0, 3], [100, 60, 2]), kind: 'shell' },
    ]);
    expect(shell.front).toBe(4);
    expect(back(shell)).toBe(2);
  });

  it('separates overlapping, coplanar and nested XY volumes in paint order', () => {
    const resolved = resolveSceneDepths([
      entry('base', 72, [0, 0, 67], [200, 120, 10]),
      entry('popover', 72, [0, 0, 67], [100, 60, 10]),
      entry('submenu', 72, [80, 0, 67], [100, 60, 10]),
    ]);
    expect(resolved.map(({ volume }) => volume.id)).toEqual(['base', 'popover', 'submenu']);
    expect(resolved[0].front).toBe(72);
    expect(back(resolved[1])).toBeGreaterThan(resolved[0].front + 0.2);
    expect(back(resolved[2])).toBeGreaterThan(resolved[1].front + 0.2);
  });

  it('lets a capsule painted above an editor override the presets original numeric order', () => {
    const editor = { ...entry('editor', 96, [0, 0, 91], [600, 400, 10]), kind: 'editor' };
    const capsule = { ...entry('capsule', 48, [0, 0, 42], [380, 76, 12]), kind: 'capsule' };
    const resolved = resolveSceneDepths([editor, capsule]);
    expect(resolved[0].front).toBe(96);
    expect(back(resolved[1])).toBeGreaterThan(96.2);
    expect(resolved[1].volume.size[2]).toBe(12);
  });

  it('treats explicit fronts as minima and does not reorder or mutate input records', () => {
    const first = { ...entry('explicit', 200), metadata: { title: 'kept' } };
    const second = { ...entry('following', 10), metadata: { title: 'also kept' } };
    const input = [first, second];
    const before = structuredClone(input);
    const resolved = resolveSceneDepths(input);
    expect(input).toEqual(before);
    expect(resolved[0].front).toBe(200);
    expect(back(resolved[1])).toBeGreaterThan(200.2);
    expect(resolved[0].metadata).toBe(first.metadata);
    expect(resolved[0]).not.toBe(first);
    expect(resolved[0].volume).not.toBe(first.volume);
  });

  it('does not push unrelated or edge-touching rectangles apart in depth', () => {
    const resolved = resolveSceneDepths([
      entry('left'),
      entry('right', 28, [100, 0, 25]),
      entry('below', 28, [0, 60, 25]),
      entry('distant', 28, [500, 500, 25]),
    ]);
    expect(resolved.every(({ front }) => front === 28)).toBe(true);
  });

  it('preserves disjoint depth intervals across a mixed stack of many surfaces', () => {
    const input = Array.from({ length: 12 }, (_, index) =>
      entry(
        `surface-${index}`,
        index % 3 ? 16 : 48,
        [(index % 4) * 35, Math.floor(index / 4) * 20, 10],
        [90, 50, 2 + index],
      ),
    );
    const resolved = resolveSceneDepths(input);
    for (const [index, upper] of resolved.entries()) {
      expect(back(upper)).toBeGreaterThan(8.2);
      expect(upper.front).toBeGreaterThanOrEqual(input[index].front);
      for (const lower of resolved.slice(0, index)) {
        const overlapX =
          Math.abs(upper.volume.center[0] - lower.volume.center[0]) <
          (upper.volume.size[0] + lower.volume.size[0]) / 2;
        const overlapY =
          Math.abs(upper.volume.center[1] - lower.volume.center[1]) <
          (upper.volume.size[1] + lower.volume.size[1]) / 2;
        if (overlapX && overlapY) expect(back(upper)).toBeGreaterThan(lower.front + 0.2);
      }
    }
  });

  it('supports scene clearance options and rejects invalid or ambiguous input', () => {
    const [resolved] = resolveSceneDepths([entry('raised', 0)], { backgroundZ: 20, gap: 2 });
    expect(back(resolved)).toBeGreaterThan(22);
    const [minimumGap] = resolveSceneDepths([entry('minimum', 0)], { gap: 0 });
    expect(back(minimumGap)).toBeGreaterThan(8.2);
    expect(resolveSceneDepths([])).toEqual([]);
    expect(() => resolveSceneDepths([entry('same'), entry('same')])).toThrow(RangeError);
    expect(() => resolveSceneDepths([entry('invalid', Number.NaN)])).toThrow(RangeError);
    expect(() => resolveSceneDepths([entry('invalid', 10, [0, 0, 0], [0, 60, 6])])).toThrow(
      RangeError,
    );
    expect(() => resolveSceneDepths([entry('valid')], { gap: -1 })).toThrow(RangeError);
    expect(() =>
      resolveSceneDepths([entry('valid')], { backgroundZ: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError);
  });
});
