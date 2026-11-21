export const MAX_GLASS_VOLUMES = 8;
export const MAX_CONTENT_PLANES = 12;

export const glassVertexShader = `#version 300 es
precision highp float;
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Closed-volume ray tracing; geometry and interface equations mirror geometry.ts/raytrace.ts. */
export const glassFragmentShader = `#version 300 es
precision highp float;
precision highp int;

#define MAX_VOLUMES ${MAX_GLASS_VOLUMES}
#define MAX_PLANES ${MAX_CONTENT_PLANES}
#define MAX_PENDING 8
#define MAX_PATHS 64
const float EPSILON = 0.002;
const float INFINITY_DISTANCE = 1.0e8;

uniform highp sampler2D uSource;
uniform float uSourceBlur;
uniform float uChromaticAberration;
uniform vec2 uViewport;
uniform vec2 uResolution;
uniform vec2 uOutputOrigin;
uniform vec4 uRegion;
uniform float uCameraZ;
uniform float uFar;
uniform int uActiveVolume;
uniform int uVolumeCount;
uniform int uPlaneCount;
uniform vec4 uVolumeCenterIor[MAX_VOLUMES];
uniform float uVolumeLens[MAX_VOLUMES];
uniform float uSurfaceFinish;
uniform vec4 uVolumeSizeRadius[MAX_VOLUMES];
uniform vec4 uVolumeBevelAbsorption[MAX_VOLUMES];
uniform vec4 uPlaneCenter[MAX_PLANES];
uniform vec4 uPlaneSizeOwnerOpaque[MAX_PLANES];
uniform vec4 uPlaneUV[MAX_PLANES];
uniform vec3 uEnvironmentTop;
uniform vec3 uEnvironmentBottom;
out vec4 outputColor;

struct Path {
  vec3 origin;
  vec3 direction;
  vec3 weight;
  int interfaces;
  int reflections;
  int mediumCount;
  int media[MAX_VOLUMES];
};

vec3 displayColor(vec3 color) {
  color = max(color, vec3(0.0));
  return mix(color * 12.92, 1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055, greaterThan(color, vec3(0.0031308)));
}

vec3 environment(vec3 direction) {
  return mix(uEnvironmentBottom, uEnvironmentTop, clamp(direction.z * 0.5 + 0.5, 0.0, 1.0));
}

float surface(int index, vec3 point, out vec3 normal) {
  vec3 p = point - uVolumeCenterIor[index].xyz;
  vec3 halfSize = uVolumeSizeRadius[index].xyz * 0.5;
  float outerRadius = min(uVolumeSizeRadius[index].w, min(halfSize.x, halfSize.y));
  if (uVolumeLens[index] > 0.5 && uVolumeBevelAbsorption[index].x > 0.0) {
    float width = uVolumeBevelAbsorption[index].x;
    vec2 q = abs(p.xy) - halfSize.xy + outerRadius;
    vec2 corner = max(q, vec2(0.0));
    float cornerLength = length(corner);
    float xy = cornerLength + min(max(q.x, q.y), 0.0) - outerRadius;
    vec2 signXY = mix(vec2(-1.0), vec2(1.0), greaterThanEqual(p.xy, vec2(0.0)));
    vec2 outward = cornerLength > 0.0 ? signXY * corner / cornerLength :
      (q.x > q.y ? vec2(signXY.x, 0.0) : vec2(0.0, signXY.y));
    float t = clamp(-xy / width, 0.0, 1.0);
    float height = 0.35 + 0.65 * t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
    float slope = halfSize.z * 0.65 * 30.0 * t * t * (1.0 - t) * (1.0 - t) / width;
    float z = abs(p.z) - halfSize.z * height;
    normal = xy > z ? vec3(outward, 0.0) : normalize(vec3(outward * slope, p.z < 0.0 ? -1.0 : 1.0));
    float bound = length(vec2(1.0, halfSize.z * 0.65 * 1.875 / width));
    return max(xy, z) / bound;
  }
  float bevel = min(uVolumeBevelAbsorption[index].x, min(outerRadius, halfSize.z));
  float radius = outerRadius - bevel;
  vec2 q = abs(p.xy) - (halfSize.xy - bevel - radius);
  vec2 corner = max(q, vec2(0.0));
  float cornerLength = length(corner);
  float xyDistance = cornerLength + min(max(q.x, q.y), 0.0) - radius;
  float zDistance = abs(p.z) - (halfSize.z - bevel);
  vec2 outside = max(vec2(xyDistance, zDistance), vec2(0.0));
  float outsideLength = length(outside);
  vec3 signP = mix(vec3(-1.0), vec3(1.0), greaterThanEqual(p, vec3(0.0)));
  vec2 normalXY = cornerLength > 0.0 ? signP.xy * corner / cornerLength :
    (q.x > q.y ? vec2(signP.x, 0.0) : vec2(0.0, signP.y));
  normal = outsideLength > 0.0 ? vec3(normalXY * outside.x, signP.z * outside.y) / outsideLength :
    (xyDistance > zDistance ? vec3(normalXY, 0.0) : vec3(0.0, 0.0, signP.z));
  return outsideLength + min(max(xyDistance, zDistance), 0.0) - bevel;
}

bool volumeBounds(int index, vec3 origin, vec3 direction, out float nearT, out float farT) {
  vec3 halfSize = uVolumeSizeRadius[index].xyz * 0.5;
  vec3 lower = uVolumeCenterIor[index].xyz - halfSize;
  vec3 upper = uVolumeCenterIor[index].xyz + halfSize;
  nearT = 0.0;
  farT = uFar;
  for (int axis = 0; axis < 3; axis++) {
    if (abs(direction[axis]) < 1.0e-8) {
      if (origin[axis] < lower[axis] || origin[axis] > upper[axis]) return false;
    } else {
      float a = (lower[axis] - origin[axis]) / direction[axis];
      float b = (upper[axis] - origin[axis]) / direction[axis];
      nearT = max(nearT, min(a, b));
      farT = min(farT, max(a, b));
    }
  }
  return farT >= max(nearT, EPSILON);
}

float volumeHit(int index, vec3 origin, vec3 direction, float limit) {
  float nearT;
  float farT;
  if (!volumeBounds(index, origin, direction, nearT, farT)) return INFINITY_DISTANCE;
  float t = max(nearT, EPSILON);
  farT = min(farT, limit);
  for (int stepIndex = 0; stepIndex < 96; stepIndex++) {
    if (t > farT + EPSILON) break;
    vec3 normal;
    float distance = abs(surface(index, origin + direction * t, normal));
    if (distance <= EPSILON) {
      for (int polish = 0; polish < 2; polish++) {
        float signedDistance = surface(index, origin + direction * t, normal);
        float derivative = dot(direction, normal);
        if (abs(derivative) < 1.0e-6) break;
        float corrected = t - signedDistance / derivative;
        if (corrected < max(nearT, EPSILON) || corrected > farT) break;
        t = corrected;
      }
      return t;
    }
    t += max(distance, EPSILON);
  }
  return INFINITY_DISTANCE;
}

// Returns the closest real boundary or finite content plane, in either ray direction.
void nextHit(Path path, out float distance, out int volume, out int plane) {
  distance = uFar;
  volume = -1;
  plane = -1;
  if (abs(path.direction.z) > 1.0e-8) {
    for (int index = 0; index < MAX_PLANES; index++) {
      if (index >= uPlaneCount) break;
      if (int(uPlaneSizeOwnerOpaque[index].z) == uActiveVolume) continue;
      float t = (uPlaneCenter[index].z - path.origin.z) / path.direction.z;
      if (t <= EPSILON || t >= distance) continue;
      vec2 point = path.origin.xy + path.direction.xy * t;
      if (all(lessThanEqual(abs(point - uPlaneCenter[index].xy), uPlaneSizeOwnerOpaque[index].xy * 0.5))) {
        distance = t;
        plane = index;
      }
    }
  }
  for (int index = 0; index < MAX_VOLUMES; index++) {
    if (index >= uVolumeCount) break;
    float t = volumeHit(index, path.origin, path.direction, distance);
    if (t < distance) {
      distance = t;
      volume = index;
      plane = -1;
    }
  }
}

vec4 planeColor(int index, vec3 point) {
  vec4 uvRect = uPlaneUV[index];
  vec2 halfTexel = 0.5 / vec2(textureSize(uSource, 0));
  vec2 minimum = halfTexel;
  vec2 maximum = vec2(1.0) - halfTexel;
  vec2 uv = point.xy / uViewport;
  if (uvRect.z >= 0.0) {
    vec2 local = (point.xy - uPlaneCenter[index].xy) / uPlaneSizeOwnerOpaque[index].xy + 0.5;
    uv = uvRect.xy + local * uvRect.zw;
    minimum = uvRect.xy + halfTexel;
    maximum = uvRect.xy + uvRect.zw - halfTexel;
  }
  vec4 color = textureLod(uSource, clamp(uv, minimum, maximum), 0.0);
  if (uSourceBlur > 0.0) {
    // The cached separable prefilter stores premultiplied linear light.
    return vec4(color.a > 0.0 ? color.rgb / color.a : vec3(0.0), color.a);
  }
  return vec4(color.rgb, uPlaneSizeOwnerOpaque[index].w > 0.5 ? 1.0 : color.a);
}

float mediumIor(Path path) {
  return path.mediumCount > 0 ? uVolumeCenterIor[path.media[path.mediumCount - 1]].w : 1.0;
}

// Bounded first-order dispersion around the actual green-ray hit, following the
// offset-scaled RGB sampling approach used by Liquid Glass Studio. This is not
// three spectral ray trees: reflection geometry and the medium stack stay shared.
vec4 dispersedPlaneColor(int index, vec3 point, vec2 cameraXY, Path path) {
  vec4 center = planeColor(index, point);
  if (uChromaticAberration <= 0.0 || path.reflections != 0 || path.interfaces == 0) return center;
  vec2 halfXY = uVolumeSizeRadius[uActiveVolume].xy * 0.5;
  float radius = min(uVolumeSizeRadius[uActiveVolume].w, min(halfXY.x, halfXY.y));
  vec2 q = abs(cameraXY - uVolumeCenterIor[uActiveVolume].xy) - halfXY + radius;
  float depth = -(length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius);
  float edge = 1.0 - smoothstep(0.0, max(uVolumeBevelAbsorption[uActiveVolume].x, 0.001), depth);
  vec2 separation = (point.xy - cameraXY) * uChromaticAberration * edge;
  float amount = length(separation);
  if (amount < 0.01) return center;
  separation *= min(1.0, 0.5 / amount);
  vec4 red = planeColor(index, point - vec3(separation, 0.0));
  vec4 blue = planeColor(index, point + vec3(separation, 0.0));
  // Transparent content keeps its original coverage. Mix in premultiplied space
  // so an empty neighbouring glyph texel cannot become a dark/coloured fringe.
  float redCoverage = min(red.a, center.a);
  float blueCoverage = min(blue.a, center.a);
  if (center.a > 0.0) {
    center.r = mix(center.r, red.r, redCoverage / center.a);
    center.b = mix(center.b, blue.b, blueCoverage / center.a);
  }
  return center;
}

void main() {
  vec2 pixel = gl_FragCoord.xy - uOutputOrigin;
  vec2 local = vec2(pixel.x / uResolution.x, 1.0 - pixel.y / uResolution.y);
  Path first;
  first.origin = vec3(uRegion.xy + local * uRegion.zw, uCameraZ);
  // Coverage is evaluated at the actual render footprint, so adaptive resolution
  // cannot turn the curved rim into a hard staircase. The native DOM is untouched.
  vec2 halfXY = uVolumeSizeRadius[uActiveVolume].xy * 0.5;
  float outerRadius = min(uVolumeSizeRadius[uActiveVolume].w, min(halfXY.x, halfXY.y));
  vec2 outlineQ = abs(first.origin.xy - uVolumeCenterIor[uActiveVolume].xy) - halfXY + outerRadius;
  float outlineDistance = length(max(outlineQ, vec2(0.0))) + min(max(outlineQ.x, outlineQ.y), 0.0) - outerRadius;
  vec2 outlineCorner = max(outlineQ, vec2(0.0));
  vec2 outlineNormal = length(outlineCorner) > 0.0 ? normalize(outlineCorner) :
    (outlineQ.x > outlineQ.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  float footprint = max(dot(outlineNormal, uRegion.zw / uResolution), 0.001);
  float coverage = clamp(0.5 - outlineDistance / footprint, 0.0, 1.0);
  // Extend the boundary sample to cover partially intersected corner pixels.
  // Tracing only their outside centre would discard valid subpixel coverage.
  if (outlineDistance > 0.0 && coverage > 0.0) {
    vec2 signXY = mix(vec2(-1.0), vec2(1.0), greaterThanEqual(first.origin.xy - uVolumeCenterIor[uActiveVolume].xy, vec2(0.0)));
    first.origin.xy -= outlineNormal * signXY * (outlineDistance + EPSILON * 2.0);
  }
  first.direction = vec3(0.0, 0.0, -1.0);
  first.weight = vec3(1.0);
  first.interfaces = 0;
  first.reflections = 0;
  first.mediumCount = 0;
  for (int index = 0; index < MAX_VOLUMES; index++) {
    first.media[index] = -1;
    if (index < uVolumeCount) {
      vec3 ignoredNormal;
      if (surface(index, first.origin, ignoredNormal) < -EPSILON) first.media[first.mediumCount++] = index;
    }
  }
  if (volumeHit(uActiveVolume, first.origin, first.direction, uFar) == INFINITY_DISTANCE) {
    outputColor = vec4(0.0);
    return;
  }

  Path pending[MAX_PENDING];
  pending[0] = first;
  int pendingCount = 1;
  vec3 radiance = vec3(0.0);
  for (int work = 0; work < MAX_PATHS; work++) {
    if (pendingCount == 0) break;
    Path path = pending[--pendingCount];
    if (max(path.weight.r, max(path.weight.g, path.weight.b)) < 0.01) {
      radiance += path.weight * environment(path.direction);
      continue;
    }
    float distance;
    int volume;
    int plane;
    nextHit(path, distance, volume, plane);
    if (volume < 0 && plane < 0) {
      radiance += path.weight * environment(path.direction);
      continue;
    }
    if (path.mediumCount > 0) {
      vec3 absorption = uVolumeBevelAbsorption[path.media[path.mediumCount - 1]].yzw;
      path.weight *= exp(-absorption * distance);
    }
    vec3 point = path.origin + path.direction * distance;
    if (plane >= 0) {
      vec4 color = dispersedPlaneColor(plane, point, first.origin.xy, path);
      radiance += path.weight * color.rgb * color.a;
      path.weight *= 1.0 - color.a;
      path.origin = point + path.direction * (EPSILON * 4.0);
      if (max(path.weight.r, max(path.weight.g, path.weight.b)) > 0.0001) pending[pendingCount++] = path;
      continue;
    }
    // A capsule above a panel and shell already needs six interfaces. Stopping
    // the direct ray after four replaces real content with a flat environment
    // patch. Keep every registered layer in transmission, while reflected paths
    // retain their small independent budget.
    int interfaceBudget = path.reflections == 0 ? max(4, uVolumeCount * 2) : 4;
    if (path.interfaces >= interfaceBudget) {
      radiance += path.weight * environment(path.direction);
      continue;
    }

    vec3 outward;
    surface(volume, point, outward);
    bool entering = dot(path.direction, outward) < 0.0;
    vec3 normal = entering ? outward : -outward;
    Path transmitted = path;
    if (entering) {
      if (transmitted.mediumCount < MAX_VOLUMES) transmitted.media[transmitted.mediumCount++] = volume;
    } else {
      for (int index = 0; index < MAX_VOLUMES; index++) {
        if (index >= transmitted.mediumCount) break;
        if (transmitted.media[index] == volume) {
          for (int next = index; next < MAX_VOLUMES - 1; next++) transmitted.media[next] = transmitted.media[next + 1];
          transmitted.mediumCount--;
          break;
        }
      }
    }
    float incidentIor = mediumIor(path);
    float transmittedIor = mediumIor(transmitted);
    float eta = incidentIor / transmittedIor;
    float cosIncident = clamp(-dot(path.direction, normal), 0.0, 1.0);
    float sinTransmittedSquared = eta * eta * (1.0 - cosIncident * cosIncident);
    bool totalInternalReflection = abs(eta - 1.0) > 1.0e-6 && sinTransmittedSquared >= 1.0;
    float cosTransmitted = sqrt(max(0.0, 1.0 - sinTransmittedSquared));
    float reflectance = 1.0;
    if (!totalInternalReflection) {
      float s = (incidentIor * cosIncident - transmittedIor * cosTransmitted) /
        max(incidentIor * cosIncident + transmittedIor * cosTransmitted, 1.0e-8);
      float p = (transmittedIor * cosIncident - incidentIor * cosTransmitted) /
        max(transmittedIor * cosIncident + incidentIor * cosTransmitted, 1.0e-8);
      reflectance = clamp((s * s + p * p) * 0.5, 0.0, 1.0);
    }

    Path reflected = path;
    reflected.direction = normalize(reflect(path.direction, normal));
    reflected.origin = point + reflected.direction * (EPSILON * 4.0);
    reflected.weight *= reflectance;
    if (reflected.mediumCount > 0) reflected.weight *= exp(-uVolumeBevelAbsorption[reflected.media[reflected.mediumCount - 1]].yzw * (EPSILON * 4.0));
    reflected.interfaces++;
    reflected.reflections++;
    // Reserve a stack slot for transmission; a deep stack must not drop the
    // high-energy direct path merely because reflected branches are pending.
    if (reflected.reflections <= 2 && pendingCount < MAX_PENDING - 1) pending[pendingCount++] = reflected;
    else radiance += reflected.weight * environment(reflected.direction);

    if (!totalInternalReflection) {
      transmitted.direction = normalize(eta * path.direction + (eta * cosIncident - cosTransmitted) * normal);
      transmitted.origin = point + transmitted.direction * (EPSILON * 4.0);
      transmitted.weight *= 1.0 - reflectance;
      if (transmitted.mediumCount > 0) transmitted.weight *= exp(-uVolumeBevelAbsorption[transmitted.media[transmitted.mediumCount - 1]].yzw * (EPSILON * 4.0));
      transmitted.interfaces++;
      if (pendingCount < MAX_PENDING) pending[pendingCount++] = transmitted;
      else radiance += transmitted.weight * environment(transmitted.direction);
    }
  }
  for (int index = 0; index < MAX_PENDING; index++) {
    if (index < pendingCount) radiance += pending[index].weight * environment(pending[index].direction);
  }
  if (uSurfaceFinish > 0.0) {
    float depth = max(0.0, -outlineDistance);
    float width = max(uVolumeBevelAbsorption[uActiveVolume].x, 1.0);
    vec2 signXY = mix(vec2(-1.0), vec2(1.0), greaterThanEqual(first.origin.xy - uVolumeCenterIor[uActiveVolume].xy, vec2(0.0)));
    vec2 outward = outlineNormal * signXY;
    float facing = dot(outward, normalize(vec2(-0.6, -0.8))) * 0.5 + 0.5;
    float light = smoothstep(0.0, 1.0, facing);
    float sharpWidth = sqrt(0.65 * 0.65 + footprint * footprint / 12.0);
    float sharp = exp(-pow((depth - 0.85) / sharpWidth, 2.0)) * 0.65 / sharpWidth;
    float broad = exp(-pow(depth / max(width * 0.65, 1.0), 2.0));
    float shadow = exp(-pow((depth - 2.8) / 2.0, 2.0)) * (1.0 - light);
    // Uniform adaptive tint, with luminance compressed equally across the whole surface.
    vec3 tint = mix(uEnvironmentBottom, uEnvironmentTop, 0.45);
    radiance = mix(radiance, tint, 0.08 * uSurfaceFinish);
    radiance *= 1.0 - shadow * 0.12 * uSurfaceFinish;
    radiance += (sharp * (0.035 + 0.16 * light) + broad * 0.018 * light) * uSurfaceFinish;
  }
  // Sub-LSB display-space dither prevents dark 8-bit gradients from forming bands.
  vec2 screenPixel = floor(first.origin.xy * uResolution / uRegion.zw);
  float noise = fract(52.9829189 * fract(dot(screenPixel, vec2(0.06711056, 0.00583715)))) - 0.5;
  outputColor = vec4(clamp(displayColor(radiance) + noise / 255.0, 0.0, 1.0), coverage);
}`;
