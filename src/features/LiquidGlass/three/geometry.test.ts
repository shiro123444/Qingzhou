import { describe, expect, it } from 'vitest';

import {
  add3,
  evaluateGlassSurface,
  intersectGlass,
  length3,
  orthographicRay,
  type RoundedGlassGeometry,
  scale3,
  signedGlassDistance,
  validateGlassGeometry,
} from './geometry';

const geometry: RoundedGlassGeometry = {
  bevel: 4,
  center: [0, 0, 0],
  radius: 14,
  size: [100, 60, 12],
};

describe('closed beveled glass geometry', () => {
  it('has distinct front, back and side boundaries with outward unit normals', () => {
    for (const [point, normal] of [
      [
        [0, 0, 6],
        [0, 0, 1],
      ],
      [
        [0, 0, -6],
        [0, 0, -1],
      ],
      [
        [50, 0, 0],
        [1, 0, 0],
      ],
      [
        [0, -30, 0],
        [0, -1, 0],
      ],
    ] as const) {
      const surface = evaluateGlassSurface(point, geometry);
      expect(surface.distance).toBeCloseTo(0, 10);
      expect(surface.normal).toEqual(normal);
    }
    expect(signedGlassDistance([0, 0, 0], geometry)).toBeLessThan(0);
    expect(signedGlassDistance([0, 0, 7], geometry)).toBeGreaterThan(0);
    expect(signedGlassDistance([50, 30, 0], geometry)).toBeGreaterThan(0);
  });

  it('matches the analytic circle at the bevel and finds both real intersections', () => {
    const component = 4 / Math.sqrt(2);
    const x = 46 + component;
    const z = 2 + component;
    const surface = evaluateGlassSurface([x, 0, z], geometry);
    expect(surface.distance).toBeCloseTo(0, 10);
    expect(surface.normal[0]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(surface.normal[2]).toBeCloseTo(Math.SQRT1_2, 10);
    const entry = intersectGlass(orthographicRay(x, 0, 40), geometry)!;
    expect(entry.entering).toBe(true);
    expect(entry.point[2]).toBeCloseTo(z, 3);
    const exit = intersectGlass(
      { direction: [0, 0, -1], origin: add3(entry.point, [0, 0, -0.001]) },
      geometry,
    )!;
    expect(exit.entering).toBe(false);
    expect(exit.point[2]).toBeCloseTo(-z, 3);
    expect(exit.normal[2]).toBeLessThan(0);
    expect(exit.distance).toBeCloseTo(2 * z - 0.001, 3);
  });

  it('preserves true circular XY corners when the rectangle becomes wide', () => {
    const square = { ...geometry, size: [60, 60, 12] as const };
    const wide = { ...geometry, size: [380, 60, 12] as const };
    const offset = 14 / Math.sqrt(2);
    expect(signedGlassDistance([16 + offset, 16 + offset, 0], square)).toBeCloseTo(0, 10);
    expect(signedGlassDistance([176 + offset, 16 + offset, 0], wide)).toBeCloseTo(0, 10);
    const wideNormal = evaluateGlassSurface([176 + offset, 16 + offset, 0], wide).normal;
    const squareNormal = evaluateGlassSurface([16 + offset, 16 + offset, 0], square).normal;
    wideNormal.forEach((value, axis) => expect(value).toBeCloseTo(squareNormal[axis], 12));
  });

  it('supports fully rounded depth, translated shapes, and inside-origin rays', () => {
    const capsule = {
      bevel: 6,
      center: [20, 30, 40] as const,
      radius: 38,
      size: [380, 76, 12] as const,
    };
    const hit = intersectGlass({ direction: [0, 0, 3], origin: capsule.center }, capsule)!;
    expect(hit.entering).toBe(false);
    expect(hit.point).toEqual([20, 30, 46]);
    expect(hit.distance).toBeCloseTo(6, 12);
    expect(intersectGlass(orthographicRay(500, 30, 100), capsule)).toBeNull();
    expect(intersectGlass({ direction: [1, 0, 0], origin: [500, 30, 100] }, capsule)).toBeNull();
  });

  it('has finite normalized analytic normals agreeing with independent finite differences', () => {
    for (const point of [
      [48, 3, 4],
      [42, 24, 3],
      [-48, -3, -4],
      [3, 8, 6],
    ] as const) {
      const surface = evaluateGlassSurface(point, geometry);
      const step = 1e-5;
      const gradient = [0, 1, 2].map((axis) => {
        const delta = [0, 0, 0] as [number, number, number];
        delta[axis] = step;
        return (
          (signedGlassDistance(add3(point, delta), geometry) -
            signedGlassDistance(add3(point, scale3(delta, -1)), geometry)) /
          (2 * step)
        );
      });
      expect(length3(surface.normal)).toBeCloseTo(1, 10);
      surface.normal.forEach((value, axis) => expect(value).toBeCloseTo(gradient[axis], 5));
    }
  });

  it('validates finite geometry and honors ray distance limits', () => {
    expect(intersectGlass(orthographicRay(0, 0, 40), geometry, { maxDistance: 20 })).toBeNull();
    for (const override of [
      { bevel: -1 },
      { radius: Number.NaN },
      { size: [100, 0, 12] as const },
      { center: [0, 0, Number.POSITIVE_INFINITY] as const },
    ]) {
      expect(() => validateGlassGeometry({ ...geometry, ...override })).toThrow(RangeError);
    }
  });
});
