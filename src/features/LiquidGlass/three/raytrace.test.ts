import { describe, expect, it } from 'vitest';

import { length3, normalize3, orthographicRay, type Vec3 } from './geometry';
import {
  beerLambert,
  type GlassVolume,
  interactDielectric,
  traceGlassScene,
  type TraceResult,
} from './raytrace';

const glass: GlassVolume = {
  absorption: [0, 0, 0],
  bevel: 2,
  center: [0, 0, 15],
  id: 'glass',
  ior: 1.5,
  radius: 10,
  size: [200, 120, 10],
};
const background = { center: [0, 0, 0] as const, id: 'background', size: [500, 400] as const };
const totalWeight = (result: TraceResult, channel: number) =>
  result.samples.reduce((sum, sample) => sum + sample.weight[channel], 0) +
  result.stats.absorbedWeight[channel] +
  result.stats.prunedWeight[channel];

describe('dielectric interactions', () => {
  it('matches normal-incidence Fresnel and independent Snell angles', () => {
    const normal = interactDielectric([0, 0, -1], [0, 0, 1], 1, 1.5);
    expect(normal.fresnel).toBeCloseTo(((1.5 - 1) / (1.5 + 1)) ** 2, 12);
    expect(normal.transmitted).toEqual([0, 0, -1]);
    const angle = Math.PI / 6;
    const oblique = interactDielectric([Math.sin(angle), 0, -Math.cos(angle)], [0, 0, 1], 1, 1.5);
    const expectedAngle = Math.asin(Math.sin(angle) / 1.5);
    expect(Math.atan2(oblique.transmitted![0], -oblique.transmitted![2])).toBeCloseTo(
      expectedAngle,
      12,
    );
    expect(length3(oblique.reflected)).toBeCloseTo(1, 12);
    const exited = interactDielectric(oblique.transmitted!, [0, 0, -1], 1.5, 1);
    expect(exited.transmitted![0]).toBeCloseTo(Math.sin(angle), 12);
    expect(exited.transmitted![2]).toBeCloseTo(-Math.cos(angle), 12);
  });

  it('returns total internal reflection above the critical angle and identity for equal media', () => {
    const interaction = interactDielectric([Math.sqrt(3) / 2, 0, 0.5], [0, 0, 1], 1.5, 1);
    expect(interaction.totalInternalReflection).toBe(true);
    expect(interaction.transmitted).toBeNull();
    expect(interaction.fresnel).toBe(1);
    expect(interaction.reflected[2]).toBeCloseTo(-0.5, 12);
    const identity = interactDielectric([1, 0, 0], [0, 0, 1], 1.45, 1.45);
    expect(identity.transmitted).toEqual([1, 0, 0]);
    expect(identity.fresnel).toBe(0);
    expect(identity.totalInternalReflection).toBe(false);
  });

  it('implements Beer-Lambert multiplicative attenuation and rejects invalid material data', () => {
    expect(beerLambert([Math.log(2), 0, Math.log(4)], 1)).toEqual([0.5, 1, 0.25]);
    const short = beerLambert([0.1, 0.2, 0.3], 2);
    const long = beerLambert([0.1, 0.2, 0.3], 4);
    short.forEach((value, index) => expect(long[index]).toBeCloseTo(value * value, 12));
    expect(() => beerLambert([-1, 0, 0], 1)).toThrow(RangeError);
    expect(() => interactDielectric([0, 0, -1], [0, 0, 1], 0, 1)).toThrow(RangeError);
  });
});

describe('bounded 3D glass ray tree', () => {
  it('traces real entry and exit points and recovers the parallel-slab ray direction', () => {
    const angle = Math.PI / 6;
    const ray = {
      direction: [Math.sin(angle), 0, -Math.cos(angle)] as Vec3,
      origin: [0, 0, 40] as Vec3,
    };
    const result = traceGlassScene(
      ray,
      { planes: [background], volumes: [glass] },
      { minWeight: 0 },
    );
    const transmitted = result.samples.find(
      (sample) => sample.kind === 'plane' && sample.reflections === 0,
    )!;
    const internalAngle = Math.asin(Math.sin(angle) / glass.ior);
    // 20 units of air before entry, 10 of glass, 10 of air after the actual exit.
    const expectedX = 30 * Math.tan(angle) + 10 * Math.tan(internalAngle);
    expect(transmitted.interfaces).toBe(2);
    expect(transmitted.origin[0]).toBeCloseTo(expectedX, 3);
    expect(transmitted.direction[0]).toBeCloseTo(ray.direction[0], 10);
    expect(transmitted.direction[2]).toBeCloseTo(ray.direction[2], 10);
    expect(transmitted.glassPathLength).toBeCloseTo(10 / Math.cos(internalAngle), 3);
    expect(transmitted.uv![0]).toBeCloseTo(expectedX / 500 + 0.5, 5);
    for (const channel of [0, 1, 2]) expect(totalWeight(result, channel)).toBeCloseTo(1, 10);
  });

  it('traces two depth-separated glass volumes through all four interfaces regardless of array order', () => {
    const upper = { ...glass, center: [0, 0, 30] as const, id: 'upper' };
    const lower = {
      ...glass,
      center: [0, 0, 12] as const,
      id: 'lower',
      size: [200, 120, 8] as const,
    };
    const scene = { planes: [background], volumes: [lower, upper] };
    const result = traceGlassScene(orthographicRay(0, 0, 50), scene, { minWeight: 0 });
    const direct = result.samples.find(
      (sample) => sample.kind === 'plane' && sample.reflections === 0,
    )!;
    expect(direct.interfaces).toBe(4);
    expect(direct.glassPathLength).toBeCloseTo(18, 2);
    expect(direct.weight[0]).toBeCloseTo(0.96 ** 4, 10);
    expect(direct.approximate).toBe(false);
    const reordered = traceGlassScene(
      orthographicRay(0, 0, 50),
      { ...scene, volumes: [upper, lower] },
      { minWeight: 0 },
    );
    expect(reordered).toEqual(result);
    expect(result.stats.maxInterfaces).toBe(4);
    for (const channel of [0, 1, 2]) expect(totalWeight(result, channel)).toBeCloseTo(1, 10);
  });

  it('changes exit direction through a curved entry and a separately intersected flat rear', () => {
    const result = traceGlassScene(
      orthographicRay(99, 0, 40),
      { planes: [background], volumes: [glass] },
      { minWeight: 0 },
    );
    const direct = result.samples.find(
      (sample) => sample.kind === 'plane' && sample.reflections === 0,
    )!;
    // At x=99 the 2px bevel is one unit past its center: N.x=1/2.
    const entryZ = 18 + Math.sqrt(3);
    const insideAngle = Math.PI / 6 - Math.asin(0.5 / 1.5);
    const exitAngle = Math.asin(1.5 * Math.sin(insideAngle));
    const exitX = 99 - (entryZ - 10) * Math.tan(insideAngle);
    expect(exitX).toBeLessThan(98); // The independently found rear hit is on its flat part.
    expect(direct.interfaces).toBe(2);
    expect(direct.direction[0]).toBeCloseTo(-Math.sin(exitAngle), 5);
    expect(direct.origin[0]).toBeCloseTo(exitX - 10 * Math.tan(exitAngle), 3);
  });

  it('preserves the real background through three to eight stacked panes without spending reflection work on the direct ray', () => {
    for (const count of [3, 8]) {
      const volumes = Array.from({ length: count }, (_, index) => ({
        ...glass,
        center: [0, 0, 12 + index * 18] as const,
        id: `pane-${index}`,
      }));
      const result = traceGlassScene(orthographicRay(0, 0, 200), {
        planes: [background],
        volumes,
      });
      const direct = result.samples.find(
        (sample) => sample.kind === 'plane' && sample.reflections === 0,
      )!;
      expect(direct.sourceId).toBe('background');
      expect(direct.interfaces).toBe(count * 2);
      expect(direct.weight[0]).toBeCloseTo(0.96 ** (count * 2), 10);
      expect(direct.approximate).toBe(false);
      expect(result.stats.maxReflections).toBeLessThanOrEqual(2);
      for (const channel of [0, 1, 2]) expect(totalWeight(result, channel)).toBeCloseTo(1, 10);
    }
  });

  it('reflects a registered plane above the glass, and terminates at closer opaque occluders', () => {
    const upperPlane = { ...background, center: [0, 0, 50] as const, id: 'upper-content' };
    const result = traceGlassScene(
      orthographicRay(0, 0, 40),
      { planes: [background, upperPlane], volumes: [glass] },
      { minWeight: 0 },
    );
    const reflection = result.samples.find(
      (sample) => sample.sourceId === 'upper-content' && sample.interfaces === 1,
    )!;
    expect(reflection.reflections).toBe(1);
    expect(reflection.direction).toEqual([0, 0, 1]);
    expect(reflection.origin).toEqual([0, 0, 50]);
    expect(reflection.weight[0]).toBeCloseTo(0.04, 12);
    expect(reflection.approximate).toBe(false);
    const occluder = { ...upperPlane, center: [0, 0, 30] as const };
    const occluded = traceGlassScene(orthographicRay(0, 0, 40), {
      planes: [background, occluder],
      volumes: [glass],
    });
    expect(occluded.samples).toHaveLength(1);
    expect(occluded.samples[0].sourceId).toBe(occluder.id);
    expect(occluded.stats.interfaceHits).toBe(0);
  });

  it('uses measured interior path lengths for RGB absorption, including oblique rays', () => {
    const material = { ...glass, absorption: [0.1, 0.02, 0] as const, ior: 1 };
    const direction = normalize3([1, 0, -1]);
    const result = traceGlassScene(
      { direction, origin: [0, 0, 40] },
      { planes: [background], volumes: [material] },
    );
    expect(result.samples).toHaveLength(1);
    const direct = result.samples[0];
    const distance = 10 * Math.sqrt(2);
    expect(direct.glassPathLength).toBeCloseTo(distance, 3);
    expect(direct.weight[0]).toBeCloseTo(Math.exp(-0.1 * distance), 4);
    expect(direct.weight[1]).toBeCloseTo(Math.exp(-0.02 * distance), 4);
    expect(direct.weight[2]).toBe(1);
    expect(direct.origin[0]).toBeCloseTo(40, 3);
    for (const channel of [0, 1, 2]) expect(totalWeight(result, channel)).toBeCloseTo(1, 12);
  });

  it('retains internal TIR energy and explicitly labels the bounded reflection approximation', () => {
    const volume = { ...glass, center: [0, 0, 0] as const };
    const result = traceGlassScene(
      { direction: [Math.sqrt(3) / 2, 0, 0.5], origin: [0, 0, 0] },
      { planes: [], volumes: [volume] },
      { minWeight: 0 },
    );
    expect(result.stats.totalInternalReflections).toBe(3);
    expect(result.stats.maxReflections).toBe(2);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0].reason).toBe('reflection-budget');
    expect(result.samples[0].approximate).toBe(true);
    expect(result.samples[0].weight).toEqual([1, 1, 1]);
    expect(result.samples[0].glassPathLength).toBeGreaterThan(49.9);
  });

  it('tracks nested media instead of treating every interface as air-to-glass', () => {
    const outer = {
      ...glass,
      center: [0, 0, 20] as const,
      id: 'outer',
      ior: 1.2,
      size: [220, 140, 30] as const,
    };
    const inner = { ...glass, center: [0, 0, 20] as const, id: 'inner', ior: 1.5 };
    const result = traceGlassScene(
      orthographicRay(0, 0, 50),
      { planes: [background], volumes: [inner, outer] },
      { minWeight: 0 },
    );
    const direct = result.samples.find(
      (sample) => sample.kind === 'plane' && sample.reflections === 0,
    )!;
    const outerF = ((1.2 - 1) / (1.2 + 1)) ** 2;
    const innerF = ((1.5 - 1.2) / (1.5 + 1.2)) ** 2;
    expect(direct.interfaces).toBe(4);
    expect(direct.weight[0]).toBeCloseTo((1 - outerF) ** 2 * (1 - innerF) ** 2, 10);
    expect(direct.glassPathLength).toBeCloseTo(30, 2);
  });

  it('bounds every branch, accounts for pruned energy, and preserves neutral empty scenes', () => {
    const result = traceGlassScene(
      orthographicRay(0, 0, 40),
      { planes: [background], volumes: [glass] },
      { maxInterfaces: 1, maxReflectionBounces: 0 },
    );
    expect(result.samples.some((sample) => sample.reason === 'interface-budget')).toBe(true);
    expect(
      result.samples.every((sample) => sample.interfaces <= 1 && sample.reflections === 0),
    ).toBe(true);
    const pruned = traceGlassScene(
      orthographicRay(0, 0, 40),
      { planes: [background], volumes: [glass] },
      { minWeight: 0.1 },
    );
    expect(pruned.stats.prunedPaths).toBeGreaterThan(0);
    for (const channel of [0, 1, 2]) expect(totalWeight(pruned, channel)).toBeCloseTo(1, 12);
    const empty = traceGlassScene(orthographicRay(0, 0, 40), { planes: [], volumes: [] });
    expect(empty.samples[0].weight).toEqual([1, 1, 1]);
    expect(empty.samples[0].kind).toBe('environment');
    expect(empty.samples[0].approximate).toBe(false);
    expect(() =>
      traceGlassScene(orthographicRay(0, 0, 40), { planes: [], volumes: [glass, glass] }),
    ).toThrow(RangeError);
  });

  it('labels a distance-limited interior ray and absorbs only the distance actually travelled', () => {
    const volume = { ...glass, absorption: [0.1, 0.2, 0] as const };
    const result = traceGlassScene(
      orthographicRay(0, 0, 15),
      { planes: [background], volumes: [volume] },
      { maxDistance: 2 },
    );
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0].reason).toBe('distance-budget');
    expect(result.samples[0].origin).toEqual([0, 0, 13]);
    expect(result.samples[0].glassPathLength).toBe(2);
    expect(result.samples[0].weight[0]).toBeCloseTo(Math.exp(-0.2), 12);
    expect(result.samples[0].interfaces).toBe(0);
    expect(totalWeight(result, 0)).toBeCloseTo(1, 12);
  });
});
