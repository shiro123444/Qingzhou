import { expect, it } from 'vitest';
import { alignmentEdges, alignSelection, selectionBounds } from './selection';

it('aligns each edge or center against the complete selection across different sizes', () => {
  const items = [
    { id: 'title', x: 11, y: 184, width: 60, height: 15 },
    { id: 'photo', x: 121, y: 83, width: 176, height: 88 },
    { id: 'table', x: 5, y: 13, width: 280, height: 67 },
  ];
  const b = selectionBounds(items);
  expect(b).toEqual({ x: 5, y: 13, width: 292, height: 186 });
  for (const edge of alignmentEdges) {
    const offsets = alignSelection(items, edge);
    const values = items.map((o, i) => {
      const { object, dx, dy } = offsets[i];
      expect(object).toBe(o.id);
      if (['left', 'right', 'center'].includes(edge)) {
        expect(dy).toBe(0);
        return o.x + dx + (edge === 'left' ? 0 : edge === 'right' ? o.width : o.width / 2);
      }
      expect(dx).toBe(0);
      return o.y + dy + (edge === 'top' ? 0 : edge === 'bottom' ? o.height : o.height / 2);
    });
    expect(new Set(values).size).toBe(1);
  }
});

it('places differently sized shapes at equal edge distances even when their centers and left edges sort differently', async () => {
  const { distributeSelection, snapAxis } = await import('./selection');
  const items = [
    { id: 'title', x: 48, y: 34, width: 182, height: 36 },
    { id: 'table', x: 64, y: 105, width: 582, height: 218 },
    { id: 'image', x: 185, y: 365, width: 128, height: 64 },
  ];
  for (const vertical of [false, true]) {
    const moves = distributeSelection(items, vertical);
    const axis = vertical ? 'y' : 'x',
      size = vertical ? 'height' : 'width';
    const ordered = moves.map((m) => {
      const o = items.find((o) => o.id === m.object)!;
      return { start: o[axis] + (vertical ? m.dy : m.dx), size: o[size] };
    });
    expect(ordered[1].start - ordered[0].start - ordered[0].size).toBeCloseTo(
      ordered[2].start - ordered[1].start - ordered[1].size,
    );
    expect(moves[0].dx || moves[0].dy).toBe(0);
    expect(moves[2].dx || moves[2].dy).toBe(0);
  }
  expect(snapAxis(11, 20, [32], 2)).toEqual({ delta: 1, guide: 32 });
  expect(snapAxis(11, 20, [40], 2)).toEqual({ delta: 0, guide: undefined });
});
