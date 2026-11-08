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

uniform sampler2D uSource;
uniform float uSourceBlur;
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
  vec2 worldToUV = vec2(1.0) / uViewport;
  if (uvRect.z >= 0.0) {
    vec2 local = (point.xy - uPlaneCenter[index].xy) / uPlaneSizeOwnerOpaque[index].xy + 0.5;
    uv = uvRect.xy + local * uvRect.zw;
    minimum = uvRect.xy + halfTexel;
    maximum = uvRect.xy + uvRect.zw - halfTexel;
    worldToUV = uvRect.zw / uPlaneSizeOwnerOpaque[index].xy;
  }
  bool opaque = uPlaneSizeOwnerOpaque[index].w > 0.5;
  if (uSourceBlur <= 0.0) {
    vec4 color = texture(uSource, clamp(uv, minimum, maximum));
    return vec4(color.rgb, opaque ? 1.0 : color.a);
  }
  // Bounded nine-tap Gaussian source prefilter, not a change to the optical surface.
  // Accumulate premultiplied linear light to prevent transparent texels creating dark halos.
  vec2 stepUV = worldToUV * uSourceBlur * 1.41421356237;
  vec4 filtered = vec4(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float weight = float((x == 0 ? 2 : 1) * (y == 0 ? 2 : 1)) / 16.0;
      vec4 color = texture(uSource, clamp(uv + vec2(float(x), float(y)) * stepUV, minimum, maximum));
      float alpha = opaque ? 1.0 : color.a;
      filtered += vec4(color.rgb * alpha, alpha) * weight;
    }
  }
  return vec4(filtered.a > 0.0 ? filtered.rgb / filtered.a : vec3(0.0), filtered.a);
}

float mediumIor(Path path) {
  return path.mediumCount > 0 ? uVolumeCenterIor[path.media[path.mediumCount - 1]].w : 1.0;
}

void main() {
  vec2 pixel = gl_FragCoord.xy - uOutputOrigin;
  vec2 local = vec2(pixel.x / uResolution.x, 1.0 - pixel.y / uResolution.y);
  Path first;
  first.origin = vec3(uRegion.xy + local * uRegion.zw, uCameraZ);
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
      vec4 color = planeColor(plane, point);
      radiance += path.weight * color.rgb * color.a;
      path.weight *= 1.0 - color.a;
      path.origin = point + path.direction * (EPSILON * 4.0);
      if (max(path.weight.r, max(path.weight.g, path.weight.b)) > 0.0001) pending[pendingCount++] = path;
      continue;
    }
    if (path.interfaces >= 4) {
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
    if (reflected.reflections <= 2 && pendingCount < MAX_PENDING) pending[pendingCount++] = reflected;
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
  outputColor = vec4(displayColor(radiance), 1.0);
}`;
