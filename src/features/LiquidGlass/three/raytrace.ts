import {
  add3,
  dot3,
  intersectGlass,
  normalize3,
  type Ray,
  RAY_EPSILON,
  type RoundedGlassGeometry,
  scale3,
  signedGlassDistance,
  type SurfaceHit,
  validateGlassGeometry,
  type Vec2,
  type Vec3,
} from './geometry';

export interface GlassVolume extends RoundedGlassGeometry {
  /** Linear RGB extinction per world unit; zero is perfectly clear. */
  absorption: Vec3;
  id: string;
  ior: number;
}

/** Finite, double-sided opaque plane parallel to XY. UV=(0,0) is its top-left. */
export interface ScenePlane {
  center: Vec3;
  id: string;
  size: Vec2;
}

export interface GlassScene {
  planes: readonly ScenePlane[];
  /** Volumes may be disjoint or completely nested; intersecting materials are undefined. */
  volumes: readonly GlassVolume[];
}

export interface TraceOptions {
  epsilon?: number;
  maxDistance?: number;
  /** Bounded reference path, at most four boundary interactions per branch. */
  maxInterfaces?: number;
  maxReflectionBounces?: number;
  /** Drop branches whose maximum RGB weight is below this threshold. */
  minWeight?: number;
}

export interface RaySample {
  approximate: boolean;
  direction: Vec3;
  /** Distance actually traversed inside material, used by Beer-Lambert absorption. */
  glassPathLength: number;
  interfaces: number;
  kind: 'plane' | 'environment';
  /** Surface hit for a plane, last trace position for an environment lookup. */
  origin: Vec3;
  pathLength: number;
  reason?: 'interface-budget' | 'reflection-budget' | 'distance-budget';
  reflections: number;
  sourceId?: string;
  uv?: Vec2;
  weight: Vec3;
}

export interface TraceStats {
  absorbedWeight: Vec3;
  interfaceHits: number;
  maxInterfaces: number;
  maxReflections: number;
  prunedPaths: number;
  prunedWeight: Vec3;
  reflectionBranches: number;
  totalInternalReflections: number;
  truncatedPaths: number;
}

export interface TraceResult {
  samples: RaySample[];
  stats: TraceStats;
}

export interface DielectricInteraction {
  fresnel: number;
  reflected: Vec3;
  totalInternalReflection: boolean;
  transmitted: Vec3 | null;
}

/**
 * Outward geometric normal is oriented against the incident direction here.
 * etaFrom/etaTo come from the tracked media, including glass-to-air exits.
 * Exact unpolarized Fresnel and vector Snell law, independently implemented from
 * https://pbr-book.org/4ed/Reflection_Models/Specular_Reflection_and_Transmission
 */
export const interactDielectric = (
  incident: Vec3,
  outwardNormal: Vec3,
  etaFrom: number,
  etaTo: number,
): DielectricInteraction => {
  if (!Number.isFinite(etaFrom) || etaFrom <= 0 || !Number.isFinite(etaTo) || etaTo <= 0) {
    throw new RangeError('Refractive indices must be finite and positive.');
  }
  const direction = normalize3(incident);
  const outward = normalize3(outwardNormal);
  const normal = dot3(direction, outward) < 0 ? outward : scale3(outward, -1);
  const cosIncident = Math.min(1, Math.max(0, -dot3(direction, normal)));
  const reflected = normalize3(add3(direction, scale3(normal, 2 * cosIncident)));
  if (etaFrom === etaTo)
    return { fresnel: 0, reflected, totalInternalReflection: false, transmitted: direction };
  const ratio = etaFrom / etaTo;
  const sinTransmittedSquared = ratio * ratio * (1 - cosIncident * cosIncident);
  if (sinTransmittedSquared >= 1) {
    return { fresnel: 1, reflected, totalInternalReflection: true, transmitted: null };
  }
  const cosTransmitted = Math.sqrt(1 - sinTransmittedSquared);
  const transmitted = normalize3(
    add3(scale3(direction, ratio), scale3(normal, ratio * cosIncident - cosTransmitted)),
  );
  const perpendicular =
    (etaFrom * cosIncident - etaTo * cosTransmitted) /
    (etaFrom * cosIncident + etaTo * cosTransmitted);
  const parallel =
    (etaTo * cosIncident - etaFrom * cosTransmitted) /
    (etaTo * cosIncident + etaFrom * cosTransmitted);
  const fresnel = Math.min(1, (perpendicular * perpendicular + parallel * parallel) / 2);
  return { fresnel, reflected, totalInternalReflection: false, transmitted };
};

/** Homogeneous extinction; distance is a measured segment, not a thickness texture. */
export const beerLambert = (absorption: Vec3, distance: number): Vec3 => {
  if (
    !Number.isFinite(distance) ||
    distance < 0 ||
    !absorption.every((v) => Number.isFinite(v) && v >= 0)
  ) {
    throw new RangeError('Absorption and distance must be finite and nonnegative.');
  }
  return [
    Math.exp(-absorption[0] * distance),
    Math.exp(-absorption[1] * distance),
    Math.exp(-absorption[2] * distance),
  ];
};

interface Path {
  glassPathLength: number;
  interfaces: number;
  media: readonly GlassVolume[];
  pathLength: number;
  ray: Ray;
  reflections: number;
  weight: Vec3;
}

const multiply3 = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const maxChannel = (v: Vec3) => Math.max(v[0], v[1], v[2]);

const intersectPlane = (ray: Ray, plane: ScenePlane, epsilon: number, maximum: number) => {
  if (Math.abs(ray.direction[2]) < 1e-12) return null;
  const distance = (plane.center[2] - ray.origin[2]) / ray.direction[2];
  if (distance < epsilon || distance > maximum) return null;
  const point = add3(ray.origin, scale3(ray.direction, distance));
  const uv: Vec2 = [
    (point[0] - plane.center[0]) / plane.size[0] + 0.5,
    (point[1] - plane.center[1]) / plane.size[1] + 0.5,
  ];
  if (uv[0] < 0 || uv[0] > 1 || uv[1] < 0 || uv[1] > 1) return null;
  return { distance, point, uv };
};

const validateScene = (scene: GlassScene) => {
  const ids = new Set<string>();
  for (const item of [...scene.volumes, ...scene.planes]) {
    if (!item.id || ids.has(item.id))
      throw new RangeError('Scene IDs must be nonempty and unique.');
    ids.add(item.id);
  }
  for (const volume of scene.volumes) {
    validateGlassGeometry(volume);
    if (
      !Number.isFinite(volume.ior) ||
      volume.ior < 1 ||
      !volume.absorption.every((v) => Number.isFinite(v) && v >= 0)
    ) {
      throw new RangeError('Glass IOR must be at least 1 and absorption finite and nonnegative.');
    }
  }
  for (const plane of scene.planes) {
    if (
      !plane.center.every(Number.isFinite) ||
      !plane.size.every((v) => Number.isFinite(v) && v > 0)
    ) {
      throw new RangeError('Opaque planes require finite coordinates and positive dimensions.');
    }
  }
};

/**
 * Deterministic bounded ray tree. Every reflected ray queries the same scene as
 * every transmitted ray, including opaque planes above the glass and other glass.
 * The renderer samples returned plane UVs or environment directions in linear RGB.
 * Truncated branches retain their own weight as a labelled environment approximation;
 * their energy is never silently added to a transmitted branch. This CPU reference
 * deliberately does not sample DOM, simulate roughness, dispersion or caustics.
 */
export const traceGlassScene = (
  inputRay: Ray,
  scene: GlassScene,
  options: TraceOptions = {},
): TraceResult => {
  validateScene(scene);
  const epsilon = options.epsilon ?? RAY_EPSILON;
  const maxDistance = options.maxDistance ?? 100_000;
  const minWeight = options.minWeight ?? 0.01;
  const maxInterfaces = Math.min(4, Math.max(0, Math.floor(options.maxInterfaces ?? 4)));
  const maxReflections = Math.min(2, Math.max(0, Math.floor(options.maxReflectionBounces ?? 2)));
  if (
    ![epsilon, maxDistance, minWeight, maxInterfaces, maxReflections].every(Number.isFinite) ||
    epsilon <= 0 ||
    maxDistance <= 0 ||
    minWeight < 0 ||
    !inputRay.origin.every(Number.isFinite)
  ) {
    throw new RangeError('Trace limits and ray origin must be finite and valid.');
  }
  const ray: Ray = { direction: normalize3(inputRay.direction), origin: inputRay.origin };
  const media = scene.volumes
    .filter((volume) => signedGlassDistance(ray.origin, volume) < -epsilon)
    .sort((a, b) => b.size[0] * b.size[1] * b.size[2] - a.size[0] * a.size[1] * a.size[2]);
  const pending: Path[] = [
    {
      glassPathLength: 0,
      interfaces: 0,
      media,
      pathLength: 0,
      ray,
      reflections: 0,
      weight: [1, 1, 1],
    },
  ];
  const samples: RaySample[] = [];
  const stats: TraceStats = {
    absorbedWeight: [0, 0, 0],
    interfaceHits: 0,
    maxInterfaces: 0,
    maxReflections: 0,
    prunedPaths: 0,
    prunedWeight: [0, 0, 0],
    reflectionBranches: 0,
    totalInternalReflections: 0,
    truncatedPaths: 0,
  };

  const environment = (path: Path, reason?: RaySample['reason']) => {
    if (reason) stats.truncatedPaths++;
    samples.push({
      approximate: !!reason,
      direction: path.ray.direction,
      glassPathLength: path.glassPathLength,
      interfaces: path.interfaces,
      kind: 'environment',
      origin: path.ray.origin,
      pathLength: path.pathLength,
      reason,
      reflections: path.reflections,
      weight: path.weight,
    });
  };
  const enqueue = (path: Path) => {
    const maximum = maxChannel(path.weight);
    if (maximum === 0) return;
    if (maximum < minWeight) {
      stats.prunedPaths++;
      stats.prunedWeight = add3(stats.prunedWeight, path.weight);
    } else pending.push(path);
  };
  const departSurface = (path: Path, direction: Vec3): Path => {
    const distance = epsilon * 4;
    const medium = path.media.at(-1);
    const weight = medium
      ? multiply3(path.weight, beerLambert(medium.absorption, distance))
      : path.weight;
    stats.absorbedWeight = add3(stats.absorbedWeight, [
      path.weight[0] - weight[0],
      path.weight[1] - weight[1],
      path.weight[2] - weight[2],
    ]);
    // The anti-self-intersection nudge is still part of the physical segment.
    return {
      ...path,
      glassPathLength: path.glassPathLength + (medium ? distance : 0),
      pathLength: path.pathLength + distance,
      ray: { direction, origin: add3(path.ray.origin, scale3(direction, distance)) },
      weight,
    };
  };

  while (pending.length > 0) {
    const path = pending.pop()!;
    const remainingDistance = maxDistance - path.pathLength;
    if (remainingDistance <= epsilon) {
      environment(path, 'distance-budget');
      continue;
    }
    let nearest = Number.POSITIVE_INFINITY;
    let glassHit: { hit: SurfaceHit; volume: GlassVolume } | null = null;
    let planeHit: { distance: number; plane: ScenePlane; point: Vec3; uv: Vec2 } | null = null;
    for (const plane of scene.planes) {
      const hit = intersectPlane(path.ray, plane, epsilon, nearest);
      if (hit) {
        nearest = hit.distance;
        planeHit = { ...hit, plane };
      }
    }
    for (const volume of scene.volumes) {
      const hit = intersectGlass(path.ray, volume, { epsilon, maxDistance: nearest });
      if (hit && hit.distance < nearest) {
        nearest = hit.distance;
        glassHit = { hit, volume };
        planeHit = null;
      }
    }
    if (!glassHit && !planeHit) {
      environment(path);
      continue;
    }

    const reachedDistanceLimit = nearest > remainingDistance;
    nearest = Math.min(nearest, remainingDistance);
    const medium = path.media.at(-1);
    const attenuation = medium ? beerLambert(medium.absorption, nearest) : ([1, 1, 1] as const);
    const weight = multiply3(path.weight, attenuation);
    stats.absorbedWeight = add3(stats.absorbedWeight, [
      path.weight[0] - weight[0],
      path.weight[1] - weight[1],
      path.weight[2] - weight[2],
    ]);
    const travelled: Path = {
      ...path,
      glassPathLength: path.glassPathLength + (medium ? nearest : 0),
      pathLength: path.pathLength + nearest,
      weight,
    };
    if (reachedDistanceLimit) {
      environment(
        {
          ...travelled,
          ray: { ...path.ray, origin: add3(path.ray.origin, scale3(path.ray.direction, nearest)) },
        },
        'distance-budget',
      );
      continue;
    }
    if (planeHit) {
      samples.push({
        approximate: false,
        direction: path.ray.direction,
        glassPathLength: travelled.glassPathLength,
        interfaces: path.interfaces,
        kind: 'plane',
        origin: planeHit.point,
        pathLength: travelled.pathLength,
        reflections: path.reflections,
        sourceId: planeHit.plane.id,
        uv: planeHit.uv,
        weight,
      });
      continue;
    }
    if (!glassHit) continue;
    const { hit, volume } = glassHit;
    const atSurface: Path = { ...travelled, ray: { ...path.ray, origin: hit.point } };
    if (path.interfaces >= maxInterfaces) {
      environment(atSurface, 'interface-budget');
      continue;
    }

    const nextMedia = hit.entering
      ? [...path.media, volume]
      : path.media.filter((item) => item.id !== volume.id);
    const interaction = interactDielectric(
      path.ray.direction,
      hit.normal,
      medium?.ior ?? 1,
      nextMedia.at(-1)?.ior ?? 1,
    );
    const interfaces = path.interfaces + 1;
    stats.interfaceHits++;
    stats.maxInterfaces = Math.max(stats.maxInterfaces, interfaces);
    if (interaction.totalInternalReflection) stats.totalInternalReflections++;
    if (interaction.fresnel > 0) {
      const reflected = departSurface(
        {
          ...atSurface,
          interfaces,
          weight: scale3(weight, interaction.fresnel),
        },
        interaction.reflected,
      );
      if (path.reflections >= maxReflections) environment(reflected, 'reflection-budget');
      else {
        reflected.reflections++;
        stats.reflectionBranches++;
        stats.maxReflections = Math.max(stats.maxReflections, reflected.reflections);
        enqueue(reflected);
      }
    }
    if (interaction.transmitted) {
      enqueue(
        departSurface(
          {
            ...atSurface,
            interfaces,
            media: nextMedia,
            weight: scale3(weight, 1 - interaction.fresnel),
          },
          interaction.transmitted,
        ),
      );
    }
  }
  return { samples, stats };
};
