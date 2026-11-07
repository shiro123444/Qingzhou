export interface GlassMapOptions {
  /** Width of the curved edge in CSS pixels, clamped to 6–12 (or half the smaller side). */
  bezel?: number;
  height: number;
  /** Relative index of refraction: air is 1, glass defaults to 1.45. */
  ior?: number;
  radius: number;
  /** Distance from the flat front to the rear plane, in CSS pixels. */
  thickness?: number;
  width: number;
}

export interface GlassMaps {
  /** Opaque RGBA: R encodes horizontal sampling offset, G vertical, B is unused. */
  displacement: Uint8ClampedArray;
  /** Texture dimensions, at most 512 per side; geometry remains in CSS pixels. */
  height: number;
  /** White RGBA reflection layer; the flat center and exterior are transparent. */
  highlight: Uint8ClampedArray;
  /** SVG displacement scale in CSS pixels; the largest offset is scale / 2. */
  scale: number;
  width: number;
}

const MAX_MAP_SIZE = 512;
const NEUTRAL = 128;
const CHANNEL_SPAN = 254;

/**
 * Rounded rectangle as a rectangle expanded by a disk. Its distance gradient
 * points outward: axis-aligned along the sides and radial around each corner.
 */
const roundedRectangle = (
  x: number,
  y: number,
  halfWidth: number,
  halfHeight: number,
  radius: number,
) => {
  const cornerX = Math.abs(x) - (halfWidth - radius);
  const cornerY = Math.abs(y) - (halfHeight - radius);
  const outsideX = Math.max(cornerX, 0);
  const outsideY = Math.max(cornerY, 0);
  const cornerDistance = Math.hypot(outsideX, outsideY);
  const distance = cornerDistance + Math.min(Math.max(cornerX, cornerY), 0) - radius;

  if (cornerDistance > 0) {
    return {
      distance,
      x: (Math.sign(x) * outsideX) / cornerDistance,
      y: (Math.sign(y) * outsideY) / cornerDistance,
    };
  }

  return {
    distance,
    x: cornerX > cornerY ? Math.sign(x) : 0,
    y: cornerX > cornerY ? 0 : Math.sign(y),
  };
};

/**
 * Trace an orthographic viewing ray through a convex front to a flat rear plane.
 * The rear plane is the background, so there is no additional air gap to trace.
 * This is geometric refraction, without dispersion or multiple internal bounces.
 *
 * Snell's law and dielectric Fresnel equations:
 * https://pbr-book.org/4ed/Reflection_Models/Specular_Reflection_and_Transmission
 *
 * SVG samples at x + scale * (R - .5), y + scale * (G - .5). To preserve exact
 * identity despite 8-bit quantization, first transform R and G with a linear
 * feComponentTransfer: slope=255/254, intercept=-1/254. Use sRGB filter space.
 * Then byte 128 is exactly .5 and offsets decode as scale * (byte - 128) / 254.
 * https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feDisplacementMap
 */
export const generateGlassMaps = ({
  bezel = 8,
  height,
  ior = 1.45,
  radius,
  thickness = 10,
  width,
}: GlassMapOptions): GlassMaps => {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new RangeError('Glass dimensions must be finite and positive.');
  }
  if (!Number.isFinite(radius) || radius < 0 || !Number.isFinite(bezel) || bezel <= 0) {
    throw new RangeError('Glass radius must be nonnegative and bezel must be positive.');
  }
  if (!Number.isFinite(thickness) || thickness < 0 || !Number.isFinite(ior) || ior < 1) {
    throw new RangeError('Glass thickness must be nonnegative and IOR must be at least 1.');
  }

  const resolution = Math.min(1, MAX_MAP_SIZE / Math.max(width, height));
  const mapWidth = Math.max(1, Math.min(MAX_MAP_SIZE, Math.round(width * resolution)));
  const mapHeight = Math.max(1, Math.min(MAX_MAP_SIZE, Math.round(height * resolution)));
  const displacement = new Uint8ClampedArray(mapWidth * mapHeight * 4);
  const highlight = new Uint8ClampedArray(displacement.length);
  const offsets = new Float64Array(mapWidth * mapHeight * 2);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const cornerRadius = Math.min(radius, halfWidth, halfHeight);
  const edgeWidth = Math.min(Math.max(6, Math.min(12, bezel)), halfWidth, halfHeight);
  const eta = 1 / ior;
  const halfVectorLength = Math.hypot(0.3, 0.4, 1);
  let maxOffset = 0;

  for (let row = 0; row < mapHeight; row++) {
    for (let column = 0; column < mapWidth; column++) {
      const pixel = row * mapWidth + column;
      const index = pixel * 4;
      displacement[index] = NEUTRAL;
      displacement[index + 1] = NEUTRAL;
      displacement[index + 2] = NEUTRAL;
      displacement[index + 3] = 255;
      highlight[index] = 255;
      highlight[index + 1] = 255;
      highlight[index + 2] = 255;

      if (ior === 1 || thickness === 0) continue;

      const x = ((column + 0.5) / mapWidth - 0.5) * width;
      const y = ((row + 0.5) / mapHeight - 0.5) * height;
      const boundary = roundedRectangle(x, y, halfWidth, halfHeight, cornerRadius);
      const depth = -boundary.distance;
      if (depth <= 0 || depth >= edgeWidth) continue;

      // A quarter ellipse joins the vertical outer edge to the flat front.
      // z(d) = thickness * sqrt(1 - (1 - d / bezel)^2), with zero inner slope.
      const remaining = 1 - depth / edgeWidth;
      const profile = Math.sqrt(1 - remaining * remaining);
      const surfaceHeight = thickness * profile;
      const slopeNumerator = thickness * remaining;
      const slopeDenominator = edgeWidth * profile;
      const normalLength = Math.hypot(slopeNumerator, slopeDenominator);
      const radialNormal = slopeNumerator / normalLength;
      const normalX = boundary.x * radialNormal;
      const normalY = boundary.y * radialNormal;
      const normalZ = slopeDenominator / normalLength;

      // Incoming ray I=(0,0,-1); N points out of the glass. Snell gives
      // T = eta*I + (eta*cos(theta_i) - cos(theta_t))*N.
      const cosTransmitted = Math.sqrt(1 - eta * eta * (1 - normalZ * normalZ));
      const normalFactor = eta * normalZ - cosTransmitted;
      const transmittedZ = -eta + normalFactor * normalZ;
      const travel = surfaceHeight / -transmittedZ;
      const offsetX = normalFactor * normalX * travel;
      const offsetY = normalFactor * normalY * travel;
      offsets[pixel * 2] = offsetX;
      offsets[pixel * 2 + 1] = offsetY;
      maxOffset = Math.max(maxOffset, Math.abs(offsetX), Math.abs(offsetY));

      // Exact unpolarized Fresnel reflectance; a fixed upper-left soft light
      // adds a restrained directional glint, fading before the flat center.
      const parallel = (normalZ - eta * cosTransmitted) / (normalZ + eta * cosTransmitted);
      const perpendicular = (eta * normalZ - cosTransmitted) / (eta * normalZ + cosTransmitted);
      const fresnel = (parallel * parallel + perpendicular * perpendicular) / 2;
      const facingLight = Math.max(
        0,
        (-0.3 * normalX - 0.4 * normalY + normalZ) / halfVectorLength,
      );
      const reflection = remaining * (0.6 * fresnel + 0.22 * facingLight ** 24);
      highlight[index + 3] = Math.round(255 * Math.min(1, reflection));
    }
  }

  const scale = maxOffset * 2;
  if (!Number.isFinite(scale)) {
    throw new RangeError('Glass parameters exceed the finite optical range.');
  }
  if (scale > 0) {
    for (let pixel = 0; pixel < mapWidth * mapHeight; pixel++) {
      displacement[pixel * 4] = NEUTRAL + Math.round((offsets[pixel * 2] / scale) * CHANNEL_SPAN);
      displacement[pixel * 4 + 1] =
        NEUTRAL + Math.round((offsets[pixel * 2 + 1] / scale) * CHANNEL_SPAN);
    }
  }

  return { displacement, height: mapHeight, highlight, scale, width: mapWidth };
};
