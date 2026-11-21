import { describe, expect, it } from 'vitest';
import { arrangePages, fitCamera, zoomCamera } from './viewport';

describe('multi-page canvas camera', () => {
  it('fits every page including mixed dimensions without changing any source coordinates', () => {
    const pages = Array.from({ length: 7 }, (_, index) => ({
      id: String(index + 1),
      label: String(index + 1),
      width: 1920,
      height: index === 1 ? 1440 : 1080,
    }));
    const original = structuredClone(pages);
    const board = arrangePages(pages);
    const available = { x: 20, y: 65, width: 800, height: 400 };
    const camera = fitCamera(board.bounds, available);
    for (const frame of board.frames) {
      expect(frame.x * camera.scale + camera.x).toBeGreaterThanOrEqual(available.x - 0.001);
      expect((frame.y + frame.height) * camera.scale + camera.y).toBeLessThanOrEqual(
        available.y + available.height + 0.001,
      );
      expect(frame.width / frame.height).toBeCloseTo(
        original[Number(frame.id) - 1].width / original[Number(frame.id) - 1].height,
      );
    }
    expect(pages).toEqual(original);
  });
  it('keeps the same document point under a distant cursor and a moving pinch midpoint', () => {
    const camera = { x: -110000, y: 48100, scale: 0.46 };
    const cursor = { x: 430, y: 215 };
    const moved = { x: 472, y: 180 };
    const before = {
      x: (cursor.x - camera.x) / camera.scale,
      y: (cursor.y - camera.y) / camera.scale,
    };
    for (const next of [cursor, moved]) {
      const zoomed = zoomCamera(camera, cursor, next, 1.9);
      expect(before.x * zoomed.scale + zoomed.x).toBeCloseTo(next.x);
      expect(before.y * zoomed.scale + zoomed.y).toBeCloseTo(next.y);
    }
  });
});
