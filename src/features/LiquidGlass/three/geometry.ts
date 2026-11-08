export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export interface Ray {
  direction: Vec3;
  origin: Vec3;
}

/** World axes: x right, y down, z toward the viewer. One unit is one CSS pixel. */
export interface RoundedGlassGeometry {
  /** Radius of the rounded front/back edge, limited by radius and half-depth. */
  bevel: number;
  center: Vec3;
  /** Outer XY corner radius. */
  radius: number;
  /** Full width, height and depth of a closed volume. */
  size: Vec3;
}

export interface SurfaceHit {
  distance: number;
  entering: boolean;
  normal: Vec3;
  point: Vec3;
  steps: number;
}

export interface IntersectionOptions {
  epsilon?: number;
  maxDistance?: number;
  maxSteps?: number;
  minDistance?: number;
}

export const RAY_EPSILON = 1e-4;
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const subtract3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (v: Vec3, scale: number): Vec3 => [v[0] * scale, v[1] * scale, v[2] * scale];
export const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length3 = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
export const normalize3 = (v: Vec3): Vec3 => {
  const length = length3(v);
  if (!Number.isFinite(length) || length === 0)
    throw new RangeError('Ray direction must be finite and nonzero.');
  return scale3(v, 1 / length);
};

export const validateGlassGeometry = (geometry: RoundedGlassGeometry) => {
  if (
    !geometry.center.every(Number.isFinite) ||
    !geometry.size.every((value) => Number.isFinite(value) && value > 0) ||
    !Number.isFinite(geometry.radius) ||
    geometry.radius < 0 ||
    !Number.isFinite(geometry.bevel) ||
    geometry.bevel < 0
  )
    throw new RangeError(
      'Glass geometry must have finite coordinates, positive dimensions and nonnegative radii.',
    );
};

/**
 * Exact distance to a rounded rectangle extruded along z and expanded by a ball.
 * The core is inset by bevel on every axis, preserving the supplied outer bounds.
 * Unlike a height map this has a front, back and side wall, all with outward normals.
 */
export const evaluateGlassSurface = (point: Vec3, geometry: RoundedGlassGeometry) => {
  const p = subtract3(point, geometry.center);
  const half = scale3(geometry.size, 0.5);
  const outerRadius = Math.min(geometry.radius, half[0], half[1]);
  const bevel = Math.min(geometry.bevel, outerRadius, half[2]);
  const radius = outerRadius - bevel;
  const qx = Math.abs(p[0]) - (half[0] - bevel - radius);
  const qy = Math.abs(p[1]) - (half[1] - bevel - radius);
  const cornerX = Math.max(qx, 0);
  const cornerY = Math.max(qy, 0);
  const cornerLength = Math.hypot(cornerX, cornerY);
  const xyDistance = cornerLength + Math.min(Math.max(qx, qy), 0) - radius;
  const zDistance = Math.abs(p[2]) - (half[2] - bevel);
  const xyOutside = Math.max(xyDistance, 0);
  const zOutside = Math.max(zDistance, 0);
  const outsideLength = Math.hypot(xyOutside, zOutside);
  const distance = outsideLength + Math.min(Math.max(xyDistance, zDistance), 0) - bevel;
  const signX = p[0] < 0 ? -1 : 1;
  const signY = p[1] < 0 ? -1 : 1;
  const signZ = p[2] < 0 ? -1 : 1;
  let normalXY: Vec2;
  if (cornerLength > 0)
    normalXY = [(signX * cornerX) / cornerLength, (signY * cornerY) / cornerLength];
  else normalXY = qx > qy ? [signX, 0] : [0, signY];

  let normal: Vec3;
  if (outsideLength > 0) {
    const xyWeight = xyOutside / outsideLength;
    normal = [normalXY[0] * xyWeight, normalXY[1] * xyWeight, (signZ * zOutside) / outsideLength];
  } else {
    normal = xyDistance > zDistance ? [normalXY[0], normalXY[1], 0] : [0, 0, signZ];
  }
  return { distance, normal };
};

export const signedGlassDistance = (point: Vec3, geometry: RoundedGlassGeometry) =>
  evaluateGlassSurface(point, geometry).distance;

const intersectBounds = (ray: Ray, geometry: RoundedGlassGeometry): Vec2 | null => {
  let near = Number.NEGATIVE_INFINITY;
  let far = Number.POSITIVE_INFINITY;
  for (let axis = 0; axis < 3; axis++) {
    const minimum = geometry.center[axis] - geometry.size[axis] / 2;
    const maximum = geometry.center[axis] + geometry.size[axis] / 2;
    if (Math.abs(ray.direction[axis]) < 1e-12) {
      if (ray.origin[axis] < minimum || ray.origin[axis] > maximum) return null;
      continue;
    }
    const a = (minimum - ray.origin[axis]) / ray.direction[axis];
    const b = (maximum - ray.origin[axis]) / ray.direction[axis];
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return null;
  }
  return [near, far];
};

/** Sphere tracing uses |SDF| inside as well as outside, so exits are actual intersections. */
export const intersectGlass = (
  inputRay: Ray,
  geometry: RoundedGlassGeometry,
  {
    epsilon = RAY_EPSILON,
    maxDistance = 100_000,
    maxSteps = 192,
    minDistance = epsilon,
  }: IntersectionOptions = {},
): SurfaceHit | null => {
  const ray = { direction: normalize3(inputRay.direction), origin: inputRay.origin };
  const bounds = intersectBounds(ray, geometry);
  if (!bounds) return null;
  let distance = Math.max(minDistance, bounds[0]);
  const end = Math.min(maxDistance, bounds[1] + epsilon);
  if (distance > end) return null;
  for (let step = 0; step < maxSteps && distance <= end; step++) {
    let point = add3(ray.origin, scale3(ray.direction, distance));
    let surface = evaluateGlassSurface(point, geometry);
    if (Math.abs(surface.distance) <= epsilon) {
      // Polish the sphere-traced root using the analytic derivative along the ray.
      // This keeps measured glass path lengths accurate at oblique incidence.
      for (let refinement = 0; refinement < 2; refinement++) {
        const derivative = dot3(ray.direction, surface.normal);
        if (Math.abs(derivative) < 1e-6) break;
        const refinedDistance = distance - surface.distance / derivative;
        if (refinedDistance < minDistance || refinedDistance > end) break;
        const refinedPoint = add3(ray.origin, scale3(ray.direction, refinedDistance));
        const refinedSurface = evaluateGlassSurface(refinedPoint, geometry);
        if (Math.abs(refinedSurface.distance) > Math.abs(surface.distance)) break;
        distance = refinedDistance;
        point = refinedPoint;
        surface = refinedSurface;
      }
      return {
        distance,
        entering: dot3(ray.direction, surface.normal) < 0,
        normal: surface.normal,
        point,
        steps: step + 1,
      };
    }
    distance += Math.max(Math.abs(surface.distance), epsilon / 2);
  }
  return null;
};

export const orthographicRay = (x: number, y: number, cameraZ: number): Ray => ({
  direction: [0, 0, -1],
  origin: [x, y, cameraZ],
});
