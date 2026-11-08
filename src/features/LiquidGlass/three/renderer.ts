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

export interface GlassRenderTile {
  activeVolumeId: string;
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface GlassRenderBatch {
  canvas: HTMLCanvasElement;
  /** Pixel rectangles use the canvas's top-left origin. Copy before the next render. */
  tiles: GlassRenderTile[];
}

export interface GlassRenderMetrics {
  batches: number;
  bufferResizes: number;
  draws: number;
  /** Last completed GPU batch. Undefined when timer queries are unavailable or disjoint. */
  gpuMilliseconds?: number;
  gpuSamples: number;
  sourceUploads: number;
}

export interface GlassRenderer {
  readonly canvas: HTMLCanvasElement;
  dispose: () => void;
  readonly metrics: Readonly<GlassRenderMetrics>;
  /** The returned backing canvas is shared: copy it before rendering the next target. */
  render: (request: GlassRenderRequest) => HTMLCanvasElement | null;
  /** Submit every surface before any GPU-to-DOM copy, avoiding per-surface synchronization. */
  renderBatch: (requests: readonly GlassRenderRequest[]) => GlassRenderBatch | null;
}

export interface GlassRendererOptions {
  /** A visible canvas can be rendered directly, avoiding any GPU-to-2D copy. */
  canvas?: HTMLCanvasElement;
  maxPixels?: number;
  onContextLost?: () => void;
  /** Resources are invalid after restoration: the owner should dispose and recreate this renderer. */
  onContextRestored?: () => void;
  onError?: (error: Error) => void;
  preserveDrawingBuffer?: boolean;
}

const linearColor = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

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
  const canvas = options.canvas ?? document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    powerPreference: 'high-performance',
    premultipliedAlpha: false,
    preserveDrawingBuffer: options.preserveDrawingBuffer ?? true,
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
  let sourceWidth = 0;
  let sourceHeight = 0;
  const metrics: GlassRenderMetrics = {
    batches: 0,
    bufferResizes: 0,
    draws: 0,
    gpuSamples: 0,
    sourceUploads: 0,
  };
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as {
    GPU_DISJOINT_EXT: number;
    TIME_ELAPSED_EXT: number;
  } | null;
  let pendingQuery: WebGLQuery | null = null;
  let activeQuery: WebGLQuery | null = null;

  const contextLost = (event: Event) => {
    event.preventDefault();
    unavailable = true;
    metrics.gpuMilliseconds = undefined;
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
    if (activeQuery && timer) gl.endQuery(timer.TIME_ELAPSED_EXT);
    gl.deleteQuery(activeQuery);
    gl.deleteQuery(pendingQuery);
    activeQuery = null;
    pendingQuery = null;
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
    outputOrigin: location('uOutputOrigin'),
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

  const centers = new Float32Array(MAX_GLASS_VOLUMES * 4);
  const sizes = new Float32Array(MAX_GLASS_VOLUMES * 4);
  const materials = new Float32Array(MAX_GLASS_VOLUMES * 4);
  const planeCenters = new Float32Array(MAX_CONTENT_PLANES * 4);
  const planeSizes = new Float32Array(MAX_CONTENT_PLANES * 4);
  const planeUV = new Float32Array(MAX_CONTENT_PLANES * 4);

  const beginBatch = () => {
    if (pendingQuery && timer && gl.getQueryParameter(pendingQuery, gl.QUERY_RESULT_AVAILABLE)) {
      metrics.gpuMilliseconds = gl.getParameter(timer.GPU_DISJOINT_EXT)
        ? undefined
        : (gl.getQueryParameter(pendingQuery, gl.QUERY_RESULT) as number) / 1_000_000;
      metrics.gpuSamples++;
      gl.deleteQuery(pendingQuery);
      pendingQuery = null;
    }
    if (timer && !pendingQuery) {
      activeQuery = gl.createQuery();
      if (activeQuery) gl.beginQuery(timer.TIME_ELAPSED_EXT, activeQuery);
    }
    metrics.batches++;
    gl.useProgram(program);
    gl.bindVertexArray(vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uniforms.source, 0);
  };
  const endBatch = () => {
    if (activeQuery && timer) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      pendingQuery = activeQuery;
      activeQuery = null;
    }
  };
  const resize = (width: number, height: number) => {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      metrics.bufferResizes++;
    }
  };
  const dimensions = (request: GlassRenderRequest) => {
    if (!request.volumes.some(({ id }) => id === request.activeVolumeId)) return null;
    if (
      !Number.isFinite(request.target.width) ||
      request.target.width <= 0 ||
      !Number.isFinite(request.target.height) ||
      request.target.height <= 0 ||
      request.volumes.length > MAX_GLASS_VOLUMES ||
      request.planes.length > MAX_CONTENT_PLANES
    )
      return null;
    const requestedRatio = request.pixelRatio ?? 1;
    if (!Number.isFinite(requestedRatio) || requestedRatio <= 0) return null;
    const ratio = Math.min(
      requestedRatio,
      Math.sqrt(maxPixels / (request.target.width * request.target.height)),
      maxTextureSize / request.target.width,
      maxTextureSize / request.target.height,
    );
    return {
      width: Math.max(1, Math.floor(request.target.width * ratio)),
      height: Math.max(1, Math.floor(request.target.height * ratio)),
    };
  };
  const upload = (request: GlassRenderRequest) => {
    if (
      lastSource === request.source &&
      request.sourceVersion !== undefined &&
      lastSourceVersion === request.sourceVersion
    )
      return;
    if (sourceWidth === request.source.width && sourceHeight === request.source.height) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, request.source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, request.source);
      sourceWidth = request.source.width;
      sourceHeight = request.source.height;
    }
    lastSource = request.source;
    lastSourceVersion = request.sourceVersion;
    metrics.sourceUploads++;
  };
  // Scene data is reused within a synchronous batch only: callers may mutate arrays next frame.
  const prepareScene = (request: GlassRenderRequest) => {
    const volumes = [...request.volumes].sort(
      (a, b) => b.size[0] * b.size[1] * b.size[2] - a.size[0] * a.size[1] * a.size[2],
    );
    volumes.forEach((volume, index) => {
      centers.set([...volume.center, volume.ior], index * 4);
      sizes.set([...volume.size, volume.radius], index * 4);
      materials.set([volume.bevel, ...volume.absorption], index * 4);
    });
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
    gl.uniform1i(uniforms.volumeCount, volumes.length);
    gl.uniform1i(uniforms.planeCount, request.planes.length);
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
    gl.uniform4fv(uniforms.volumeCenterIor, centers);
    gl.uniform4fv(uniforms.volumeSizeRadius, sizes);
    gl.uniform4fv(uniforms.volumeMaterial, materials);
    gl.uniform4fv(uniforms.planeCenter, planeCenters);
    gl.uniform4fv(uniforms.planeSizeOwnerOpaque, planeSizes);
    gl.uniform4fv(uniforms.planeUV, planeUV);
    return volumes;
  };
  const draw = (
    request: GlassRenderRequest,
    tile: GlassRenderTile,
    volumes: readonly GlassVolume[],
  ) => {
    const activeIndex = volumes.findIndex(({ id }) => id === request.activeVolumeId);
    const active = volumes[activeIndex];
    const bottom = canvas.height - tile.y - tile.height;
    gl.uniform1f(
      uniforms.sourceBlur,
      Number.isFinite(request.sourceBlur) ? Math.max(0, Math.min(request.sourceBlur!, 32)) : 0,
    );
    gl.uniform1i(uniforms.active, activeIndex);
    gl.uniform1f(uniforms.cameraZ, active.center[2] + active.size[2] * 0.5 + 0.008);
    gl.uniform2f(uniforms.outputOrigin, tile.x, bottom);
    gl.uniform2f(uniforms.resolution, tile.width, tile.height);
    gl.uniform4f(
      uniforms.region,
      request.target.x,
      request.target.y,
      request.target.width,
      request.target.height,
    );
    gl.uniform3fv(
      uniforms.environmentTop,
      (request.environmentTop ?? [0.92, 0.96, 0.97]).map(linearColor),
    );
    gl.uniform3fv(
      uniforms.environmentBottom,
      (request.environmentBottom ?? [0.72, 0.81, 0.83]).map(linearColor),
    );
    gl.viewport(tile.x, bottom, tile.width, tile.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    metrics.draws++;
  };
  const report = (error: unknown) =>
    options.onError?.(error instanceof Error ? error : new Error(String(error)));

  return {
    canvas,
    dispose,
    get metrics() {
      return { ...metrics };
    },
    render: (request) => {
      if (unavailable || gl.isContextLost()) return null;
      const size = dimensions(request);
      if (!size) return null;
      try {
        resize(size.width, size.height);
        beginBatch();
        upload(request);
        draw(
          request,
          { ...size, activeVolumeId: request.activeVolumeId, x: 0, y: 0 },
          prepareScene(request),
        );
        return canvas;
      } catch (error) {
        report(error);
        return null;
      } finally {
        endBatch();
      }
    },
    renderBatch: (requests) => {
      if (
        unavailable ||
        gl.isContextLost() ||
        !requests.length ||
        requests.length > MAX_GLASS_VOLUMES
      )
        return null;
      const sizes = requests.map(dimensions);
      if (sizes.some((size) => !size)) return null;
      const validSizes = sizes as Array<{ width: number; height: number }>;
      const rowWidth = Math.min(
        maxTextureSize,
        Math.max(
          ...validSizes.map(({ width }) => width),
          Math.ceil(
            Math.sqrt(validSizes.reduce((sum, { width, height }) => sum + width * height, 0)) * 1.2,
          ),
        ),
      );
      let x = 0;
      let y = 0;
      let rowHeight = 0;
      let width = 0;
      const tiles = validSizes.map((size, index) => {
        if (x + size.width > rowWidth) {
          x = 0;
          y += rowHeight;
          rowHeight = 0;
        }
        const tile = { ...size, activeVolumeId: requests[index].activeVolumeId, x, y };
        x += size.width;
        rowHeight = Math.max(rowHeight, size.height);
        width = Math.max(width, x);
        return tile;
      });
      const height = y + rowHeight;
      if (height > maxTextureSize) return null;
      try {
        resize(width, height);
        beginBatch();
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        let previous: GlassRenderRequest | undefined;
        let volumes: readonly GlassVolume[] = [];
        requests.forEach((request, index) => {
          upload(request);
          if (
            previous?.volumes !== request.volumes ||
            previous.planes !== request.planes ||
            previous.viewport !== request.viewport
          )
            volumes = prepareScene(request);
          draw(request, tiles[index], volumes);
          previous = request;
        });
        return { canvas, tiles };
      } catch (error) {
        report(error);
        return null;
      } finally {
        endBatch();
      }
    },
  };
}
