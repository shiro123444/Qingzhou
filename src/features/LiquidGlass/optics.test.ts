import { describe, expect, it } from 'vitest';

import { generateGlassMaps, type GlassMaps } from './optics';

const options = { height: 76, radius: 38, width: 380 };
const offsetAt = (map: GlassMaps, x: number, y: number) => {
  const index = (y * map.width + x) * 4;
  return {
    x: ((map.displacement[index] - 128) / 254) * map.scale,
    y: ((map.displacement[index + 1] - 128) / 254) * map.scale,
  };
};
const alphaAt = (map: GlassMaps, x: number, y: number) =>
  map.highlight[(y * map.width + x) * 4 + 3];

describe('generateGlassMaps', () => {
  it('keeps the flat center and the rounded-rectangle exterior exactly neutral', () => {
    const map = generateGlassMaps(options);
    for (const [x, y] of [
      [190, 38],
      [100, 20],
      [0, 0],
      [379, 75],
    ]) {
      expect(offsetAt(map, x, y)).toEqual({ x: 0, y: 0 });
      expect(alphaAt(map, x, y)).toBe(0);
    }
    expect(map.scale).toBeGreaterThan(0);
  });

  it.each([{ ior: 1 }, { thickness: 0 }])('is identity for %o', (override) => {
    const map = generateGlassMaps({ ...options, ...override });
    expect(map.scale).toBe(0);
    for (let index = 0; index < map.displacement.length; index += 4) {
      expect(Array.from(map.displacement.subarray(index, index + 4))).toEqual([128, 128, 128, 255]);
      expect(map.highlight[index + 3]).toBe(0);
    }
  });

  it('agrees with an independent Snell-angle trace to the rear plane', () => {
    const map = generateGlassMaps(options);
    const depth = 3.5;
    const remaining = 1 - depth / 8;
    const frontHeight = 10 * Math.sqrt(1 - remaining ** 2);
    const incidence = Math.atan((10 * remaining) / (8 * Math.sqrt(1 - remaining ** 2)));
    const transmission = Math.asin(Math.sin(incidence) / 1.45);
    const expectedShift = frontHeight * Math.tan(incidence - transmission);
    const actual = offsetAt(map, 190, 3);
    expect(actual.x).toBe(0);
    expect(Math.abs(actual.y - expectedShift)).toBeLessThanOrEqual(map.scale / 508);
  });

  it('has mirror-symmetric refraction and bends all four sides inward', () => {
    const map = generateGlassMaps(options);
    const tolerance = map.scale / 254 + 1e-12;
    for (let y = 0; y < map.height; y += 3) {
      for (let x = 0; x < map.width; x += 5) {
        const sample = offsetAt(map, x, y);
        const mirrorX = offsetAt(map, map.width - 1 - x, y);
        const mirrorY = offsetAt(map, x, map.height - 1 - y);
        expect(Math.abs(sample.x + mirrorX.x)).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(sample.y - mirrorX.y)).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(sample.y + mirrorY.y)).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(sample.x - mirrorY.x)).toBeLessThanOrEqual(tolerance);
      }
    }
    expect(offsetAt(map, 2, 38).x).toBeGreaterThan(0);
    expect(offsetAt(map, 377, 38).x).toBeLessThan(0);
    expect(offsetAt(map, 190, 2).y).toBeGreaterThan(0);
    expect(offsetAt(map, 190, 73).y).toBeLessThan(0);
  });

  it('uses radial corner normals and real edge distance rather than a stretched oval', () => {
    const square = generateGlassMaps({ height: 80, radius: 20, width: 80 });
    const wide = generateGlassMaps({ height: 80, radius: 20, width: 380 });
    const diagonal = offsetAt(square, 8, 8);
    expect(diagonal.x).toBeGreaterThan(0);
    expect(diagonal.x).toBe(diagonal.y);
    expect(offsetAt(square, 40, 3)).toEqual(offsetAt(wide, 190, 3));
    expect(offsetAt(square, 3, 40)).toEqual(offsetAt(wide, 3, 40));
  });

  it('increases refraction with thickness and index of refraction', () => {
    const thin = generateGlassMaps({ ...options, thickness: 5 });
    const thick = generateGlassMaps({ ...options, thickness: 10 });
    const lowerIndex = generateGlassMaps({ ...options, ior: 1.1 });
    const higherIndex = generateGlassMaps({ ...options, ior: 1.6 });
    expect(offsetAt(thick, 190, 3).y).toBeGreaterThan(offsetAt(thin, 190, 3).y);
    expect(offsetAt(higherIndex, 190, 3).y).toBeGreaterThan(offsetAt(lowerIndex, 190, 3).y);
    expect(higherIndex.scale).toBeGreaterThan(lowerIndex.scale);
  });

  it('limits the curved band to the requested CSS width and highlights only that band', () => {
    const narrow = generateGlassMaps({ ...options, bezel: 6 });
    const wide = generateGlassMaps({ ...options, bezel: 12 });
    expect(offsetAt(narrow, 190, 8)).toEqual({ x: 0, y: 0 });
    expect(offsetAt(wide, 190, 8).y).toBeGreaterThan(0);
    expect(alphaAt(narrow, 190, 8)).toBe(0);
    expect(alphaAt(wide, 190, 1)).toBeGreaterThan(0);
  });

  it.each([
    { height: 1, radius: 0, width: 1 },
    { height: 0.5, radius: 100, width: 0.25 },
    { height: 60, radius: 30, width: 60 },
    { height: 800, radius: 40, width: 2400 },
    { height: 3000, radius: 24, width: 200 },
  ])('bounds texture size and produces finite RGBA data for %o', (geometry) => {
    const map = generateGlassMaps(geometry);
    expect(map.width).toBeGreaterThanOrEqual(1);
    expect(map.height).toBeGreaterThanOrEqual(1);
    expect(Math.max(map.width, map.height)).toBeLessThanOrEqual(512);
    expect(map.displacement.length).toBe(map.width * map.height * 4);
    expect(map.highlight.length).toBe(map.displacement.length);
    expect(Number.isFinite(map.scale)).toBe(true);
    for (let index = 0; index < map.displacement.length; index += 4) {
      expect(map.displacement[index]).toBeGreaterThanOrEqual(1);
      expect(map.displacement[index + 1]).toBeGreaterThanOrEqual(1);
      expect(map.displacement[index + 3]).toBe(255);
      expect(Math.abs(((map.displacement[index] - 128) / 254) * map.scale)).toBeLessThanOrEqual(
        map.scale / 2,
      );
    }
  });

  it('retains physical dimensions and circular corners when texture resolution is reduced', () => {
    const full = generateGlassMaps({ height: 80, radius: 20, width: 400 });
    const large = generateGlassMaps({ height: 160, radius: 40, thickness: 20, width: 800 });
    expect(large.width).toBe(512);
    expect(large.height).toBe(102);
    // Both samples are about 3.5 CSS pixels from their respective straight top edge.
    // Doubling thickness while keeping the physical 8px bezel strengthens refraction;
    // shrinking the texture must not shrink the lens or its sampling displacement.
    expect(offsetAt(large, 256, 2).y).toBeGreaterThan(offsetAt(full, 200, 3).y);
    expect(offsetAt(large, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('rejects invalid geometry and optical parameters before allocating maps', () => {
    for (const override of [
      { width: 0 },
      { height: -1 },
      { width: Number.NaN },
      { height: Number.POSITIVE_INFINITY },
      { radius: -1 },
      { radius: Number.NaN },
      { bezel: 0 },
      { bezel: Number.POSITIVE_INFINITY },
      { thickness: -1 },
      { thickness: Number.NaN },
      { ior: 0.9 },
      { ior: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => generateGlassMaps({ ...options, ...override })).toThrow(RangeError);
    }
  });
});
