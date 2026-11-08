import { type Vec3 } from './geometry';
import { type GlassVolume, type ScenePlane } from './raytrace';
import {
  glassFragmentShader,
  glassVertexShader,
  MAX_CONTENT_PLANES,
  MAX_GLASS_VOLUMES,
} from './shader';

export interface GlassRenderPlane extends ScenePlane {
  opaque?: boolean;
  /** A target's own DOM foreground is composited by the browser, not burned into its glass. */
  ownerVolumeId?: string;
  /** Top-left-origin normalized atlas rectangle. Omit for a full viewport texture. */
  uvRect?: readonly [number, number, number, number];
}

export interface GlassRenderRequest {
  activeVolumeId: string;
  environmentBottom?: Vec3;
  environmentTop?: Vec3;
  pixelRatio?: number;
  planes: readonly GlassRenderPlane[];
  source: HTMLCanvasElement | ImageBitmap | OffscreenCanvas;
  /** Source-plane prefilter in CSS pixels; preserves geometry and the live DOM foreground. */
  sourceBlur?: number;
  /** Reuse one uploaded atlas across all target renders belonging to this dirty frame. */
  sourceVersion?: number;
  target: { height: number; width: number; x: number; y: number };
  viewport: { height: number; width: number };
  volumes: readonly GlassVolume[];
}

export interface GlassRenderer {
  readonly canvas: HTMLCanvasElement;
  dispose: () => void;
  /** The returned backing canvas is shared: copy it before rendering the next target. */
  render: (request: GlassRenderRequest) => HTMLCanvasElement | null;
}

export interface GlassRendererOptions {
  maxPixels?: number;
  onContextLost?: () => void;
  /** Resources are invalid after restoration: the owner should dispose and recreate this renderer. */
  onContextRestored?: () => void;
  onError?: (error: Error) => void;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to allocate a glass shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'Glass shader compilation failed.';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

/** WebGL2 only; no browser-version gate and no DOM/screen capture or pixel readback. */
export function createGlassRenderer(options: GlassRendererOptions = {}): GlassRenderer | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    powerPreference: 'high-performance',
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    stencil: false,
  });
  if (!gl) return null;

  let program: WebGLProgram | null = null;
  let texture: WebGLTexture | null = null;
  let vertexArray: WebGLVertexArrayObject | null = null;
  let vertexShader: WebGLShader | null = null;
  let fragmentShader: WebGLShader | null = null;
  let unavailable = false;
  let disposed = false;
  let lastSource: GlassRenderRequest['source'] | undefined;
  let lastSourceVersion: number | undefined;

  const contextLost = (event: Event) => {
    event.preventDefault();
    unavailable = true;
    options.onContextLost?.();
  };
  canvas.addEventListener('webglcontextlost', contextLost);
  const contextRestored = () => options.onContextRestored?.();
  canvas.addEventListener('webglcontextrestored', contextRestored);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unavailable = true;
    canvas.removeEventListener('webglcontextlost', contextLost);
    canvas.removeEventListener('webglcontextrestored', contextRestored);
    gl.deleteTexture(texture);
    gl.deleteVertexArray(vertexArray);
    gl.deleteProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    lastSource = undefined;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.width = 0;
    canvas.height = 0;
  };

  try {
    vertexShader = compileShader(gl, gl.VERTEX_SHADER, glassVertexShader);
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, glassFragmentShader);
    program = gl.createProgram();
    if (!program) throw new Error('Unable to allocate the glass program.');
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'Glass program linking failed.');
    }
    texture = gl.createTexture();
    vertexArray = gl.createVertexArray();
    if (!texture || !vertexArray) throw new Error('Unable to allocate glass GPU resources.');
    gl.useProgram(program);
    gl.bindVertexArray(vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.DITHER);
  } catch (error) {
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
    dispose();
    return null;
  }

  const location = (name: string) => gl.getUniformLocation(program!, name);
  const uniforms = {
    active: location('uActiveVolume'),
    cameraZ: location('uCameraZ'),
    environmentBottom: location('uEnvironmentBottom'),
    environmentTop: location('uEnvironmentTop'),
    far: location('uFar'),
    planeCenter: location('uPlaneCenter[0]'),
    planeCount: location('uPlaneCount'),
    planeSizeOwnerOpaque: location('uPlaneSizeOwnerOpaque[0]'),
    planeUV: location('uPlaneUV[0]'),
    region: location('uRegion'),
    resolution: location('uResolution'),
    source: location('uSource'),
    sourceBlur: location('uSourceBlur'),
    viewport: location('uViewport'),
    volumeCenterIor: location('uVolumeCenterIor[0]'),
    volumeCount: location('uVolumeCount'),
    volumeMaterial: location('uVolumeBevelAbsorption[0]'),
    volumeSizeRadius: location('uVolumeSizeRadius[0]'),
  };
  const maxPixels = Math.max(1, Math.min(options.maxPixels ?? 120_000, 120_000));
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

  return {
    canvas,
    dispose,
    render: (request) => {
      if (unavailable || gl.isContextLost()) return null;
      const active = request.volumes.find((volume) => volume.id === request.activeVolumeId);
      if (!active || request.target.width <= 0 || request.target.height <= 0) return null;
      if (
        request.volumes.length > MAX_GLASS_VOLUMES ||
        request.planes.length > MAX_CONTENT_PLANES
      ) {
        options.onError?.(
          new Error(
            `Glass scene exceeds ${MAX_GLASS_VOLUMES} volumes / ${MAX_CONTENT_PLANES} planes.`,
          ),
        );
        return null;
      }

      // Largest first initializes nested media in outer-to-inner order.
      const volumes = [...request.volumes].sort(
        (a, b) => b.size[0] * b.size[1] * b.size[2] - a.size[0] * a.size[1] * a.size[2],
      );
      const activeIndex = volumes.findIndex((volume) => volume.id === active.id);
      const requestedRatio = request.pixelRatio ?? 1;
      if (!Number.isFinite(requestedRatio) || requestedRatio <= 0) return null;
      const ratio = Math.min(
        requestedRatio,
        Math.sqrt(maxPixels / (request.target.width * request.target.height)),
        maxTextureSize / request.target.width,
        maxTextureSize / request.target.height,
      );
      const width = Math.max(1, Math.floor(request.target.width * ratio));
      const height = Math.max(1, Math.floor(request.target.height * ratio));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;

      try {
        gl.useProgram(program);
        gl.bindVertexArray(vertexArray);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        if (
          lastSource !== request.source ||
          request.sourceVersion === undefined ||
          lastSourceVersion !== request.sourceVersion
        ) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, request.source);
          lastSource = request.source;
          lastSourceVersion = request.sourceVersion;
        }
        const centers = new Float32Array(MAX_GLASS_VOLUMES * 4);
        const sizes = new Float32Array(MAX_GLASS_VOLUMES * 4);
        const materials = new Float32Array(MAX_GLASS_VOLUMES * 4);
        volumes.forEach((volume, index) => {
          centers.set([...volume.center, volume.ior], index * 4);
          sizes.set([...volume.size, volume.radius], index * 4);
          materials.set([volume.bevel, ...volume.absorption], index * 4);
        });
        const planeCenters = new Float32Array(MAX_CONTENT_PLANES * 4);
        const planeSizes = new Float32Array(MAX_CONTENT_PLANES * 4);
        const planeUV = new Float32Array(MAX_CONTENT_PLANES * 4);
        request.planes.forEach((plane, index) => {
          planeCenters.set([...plane.center, 0], index * 4);
          planeSizes.set(
            [
              ...plane.size,
              volumes.findIndex((volume) => volume.id === plane.ownerVolumeId),
              plane.opaque ? 1 : 0,
            ],
            index * 4,
          );
          planeUV.set(plane.uvRect ?? [0, 0, -1, -1], index * 4);
        });
        gl.uniform1i(uniforms.source, 0);
        gl.uniform1f(
          uniforms.sourceBlur,
          Number.isFinite(request.sourceBlur) ? Math.max(0, Math.min(request.sourceBlur!, 32)) : 0,
        );
        gl.uniform1i(uniforms.active, activeIndex);
        gl.uniform1i(uniforms.volumeCount, volumes.length);
        gl.uniform1i(uniforms.planeCount, request.planes.length);
        gl.uniform1f(uniforms.cameraZ, active.center[2] + active.size[2] * 0.5 + 0.008);
        gl.uniform1f(
          uniforms.far,
          Math.max(
            request.viewport.width,
            request.viewport.height,
            ...volumes.map((volume) => Math.abs(volume.center[2]) + volume.size[2]),
            ...request.planes.map((plane) => Math.abs(plane.center[2])),
          ) *
            4 +
            100,
        );
        gl.uniform2f(uniforms.viewport, request.viewport.width, request.viewport.height);
        gl.uniform2f(uniforms.resolution, width, height);
        gl.uniform4f(
          uniforms.region,
          request.target.x,
          request.target.y,
          request.target.width,
          request.target.height,
        );
        gl.uniform3f(uniforms.environmentTop, ...(request.environmentTop ?? [0.92, 0.96, 0.97]));
        gl.uniform3f(
          uniforms.environmentBottom,
          ...(request.environmentBottom ?? [0.72, 0.81, 0.83]),
        );
        gl.uniform4fv(uniforms.volumeCenterIor, centers);
        gl.uniform4fv(uniforms.volumeSizeRadius, sizes);
        gl.uniform4fv(uniforms.volumeMaterial, materials);
        gl.uniform4fv(uniforms.planeCenter, planeCenters);
        gl.uniform4fv(uniforms.planeSizeOwnerOpaque, planeSizes);
        gl.uniform4fv(uniforms.planeUV, planeUV);
        gl.viewport(0, 0, width, height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Glass GPU rendering failed.');
        return canvas;
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
        return null;
      }
    },
  };
}
