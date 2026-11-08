/** Isolated, deterministic GPU fixture. This module is never imported by a product route. */
import { type Vec3 } from '@/features/LiquidGlass/three/geometry';
import { type GlassVolume, traceGlassScene } from '@/features/LiquidGlass/three/raytrace';
import {
  createGlassRenderer,
  type GlassRenderer,
  type GlassRenderPlane,
  type GlassRenderRequest,
} from '@/features/LiquidGlass/three/renderer';

export interface Glass3dOptions {
  absorption?: boolean;
  blur?: number;
  boundedSources?: boolean;
  chromaticAberration?: number;
  double?: boolean;
  environmentOnly?: boolean;
  layers?: number;
  overlay?: 'half' | 'none' | 'opaque' | 'transparent';
  ownForeground?: boolean;
  source?: 'gray-grid' | 'grid' | 'solid';
  upper?: 'blue' | 'orange';
}

const environment: Vec3 = [0.12, 0.16, 0.2];
const target = { height: 100, width: 320, x: 80, y: 80 };
const viewport = { height: 320, width: 512 };
const atlas = document.createElement('canvas');
atlas.width = viewport.width * 3;
atlas.height = viewport.height;
const context = atlas.getContext('2d')!;
const output = document.createElement('canvas');
output.width = target.width;
output.height = target.height;
output.dataset.glass3dOutput = '';
output.style.cssText =
  'display:block;width:640px;height:200px;background:#13252d;border-radius:16px;image-rendering:auto';
document.body.style.cssText =
  'margin:0;padding:32px;background:#10212a;color:#e5f4f3;font:14px system-ui';
const title = document.createElement('h1');
title.textContent = '清舟 · 三维玻璃光学验证';
const caption = document.createElement('p');
caption.textContent = '真实前后曲面、两层玻璃、独立上方反射源与透明内容层';
document.body.append(title, caption, output);
const outputContext = output.getContext('2d', { willReadFrequently: true })!;
const errors: string[] = [];
let renderer: GlassRenderer | null = null;
let lossExtension: WEBGL_lose_context | null = null;
let request: GlassRenderRequest;
let version = 0;
let lost = 0;
let restored = 0;
let disposed = false;
let currentOptions: Glass3dOptions = {};
let colors = new Map<string, Vec3>();

const makeRenderer = () =>
  createGlassRenderer({
    onContextLost: () => {
      lost++;
    },
    onContextRestored: () => {
      restored++;
      renderer?.dispose();
      renderer = makeRenderer();
    },
    onError: (error) => errors.push(error.message),
  });
renderer = makeRenderer();

function prepare(options: Glass3dOptions) {
  currentOptions = options;
  const baseColor: Vec3 = [0.08, 0.62, 0.7];
  const aboveColor: Vec3 = options.upper === 'blue' ? [0.12, 0.3, 0.95] : [0.95, 0.24, 0.12];
  const overlayColor: Vec3 = [0.12, 0.88, 0.25];
  const fill = (color: Vec3) =>
    `rgb(${color.map((channel) => Math.round(channel * 255)).join(' ')})`;
  context.clearRect(0, 0, atlas.width, atlas.height);
  context.fillStyle = fill(baseColor);
  context.fillRect(0, 0, 512, 320);
  if (options.source !== 'solid') {
    for (let x = 0; x < 512; x += 16) {
      context.fillStyle =
        options.source === 'gray-grid'
          ? x % 32
            ? '#eeeeee'
            : '#222222'
          : x % 32
            ? '#f07361'
            : '#1ab8cf';
      context.fillRect(x, 0, 16, 320);
    }
    context.fillStyle = '#e9f5e2';
    for (let y = 0; y < 320; y += 24) context.fillRect(0, y, 512, 2);
  }
  context.fillStyle = fill(aboveColor);
  context.fillRect(512, 0, 512, 320);
  context.globalAlpha =
    options.overlay === 'transparent' ? 0 : options.overlay === 'half' ? 0.5 : 1;
  context.fillStyle = fill(overlayColor);
  context.fillRect(1024, 0, 512, 320);
  context.globalAlpha = 1;
  if (options.boundedSources) {
    for (const [index, color] of [baseColor, aboveColor, overlayColor].entries()) {
      context.fillStyle = '#ff00ff';
      context.fillRect(index * 512, 0, 512, 320);
      context.fillStyle = fill(color);
      context.fillRect(index * 512 + 8, 8, 16, 16);
    }
  }
  // Match the source's actual 8-bit channels in the independent CPU color oracle.
  const quantize = (color: Vec3): Vec3 =>
    color.map((value) => Math.round(value * 255) / 255) as unknown as Vec3;
  colors = new Map([
    ['background', quantize(baseColor)],
    ['above', quantize(aboveColor)],
    ['overlay', quantize(overlayColor)],
  ]);
  const volumes: GlassVolume[] = [
    {
      absorption: options.absorption ? [0.005, 0.012, 0.02] : [0, 0, 0],
      bevel: 6,
      center: [240, 130, 36],
      id: 'capsule',
      ior: 1.45,
      radius: 50,
      size: [320, 100, 12],
    },
  ];
  const layerCount = options.layers ?? (options.double ? 2 : 1);
  for (let index = 1; index < layerCount; index++)
    volumes.push({
      absorption: [0.002, 0.001, 0.002],
      bevel: 5,
      center: [240, 130, 36 - index * 24],
      id: `lower-${index}`,
      ior: 1.7,
      radius: 50,
      size: [340, 116, 12],
    });
  const planes: GlassRenderPlane[] = [
    {
      center: [256, 160, -16 - Math.max(0, layerCount - 2) * 24],
      id: 'background',
      opaque: true,
      size: [512, 320],
      uvRect: [0, 0, 1 / 3, 1],
    },
    {
      center: [256, 160, 80],
      id: 'above',
      opaque: true,
      size: [512, 320],
      uvRect: [1 / 3, 0, 1 / 3, 1],
    },
  ];
  if (options.overlay && options.overlay !== 'none')
    planes.push({
      center: [256, 160, 24],
      id: 'overlay',
      opaque: options.overlay === 'opaque',
      size: [512, 320],
      uvRect: [2 / 3, 0, 1 / 3, 1],
    });
  if (options.ownForeground)
    planes.push({
      center: [256, 160, 41],
      id: 'own-content',
      opaque: true,
      ownerVolumeId: 'capsule',
      size: [512, 320],
      uvRect: [2 / 3, 0, 1 / 3, 1],
    });
  if (options.boundedSources) {
    planes.forEach((plane, index) => {
      plane.center = [240, 130, plane.center[2]];
      plane.size = [320, 100];
      plane.uvRect = [
        (index * 512 + 8) / atlas.width,
        8 / atlas.height,
        16 / atlas.width,
        16 / atlas.height,
      ];
    });
  }
  request = {
    activeVolumeId: 'capsule',
    chromaticAberration: options.chromaticAberration,
    environmentBottom: environment,
    environmentTop: environment,
    planes: options.environmentOnly ? [] : planes,
    source: atlas,
    sourceBlur: options.blur,
    sourceVersion: ++version,
    target,
    viewport,
    volumes,
  };
}

function render(options: Glass3dOptions = currentOptions) {
  if (disposed) return false;
  prepare(options);
  const frame = renderer?.render(request);
  outputContext.clearRect(0, 0, output.width, output.height);
  if (frame) outputContext.drawImage(frame, 0, 0);
  return !!frame;
}

const linear = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const display = (value: number) =>
  (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055) * 255;

function oracle(x: number, y: number) {
  const active = request.volumes[0];
  const trace = traceGlassScene(
    {
      direction: [0, 0, -1],
      origin: [
        target.x + x + 0.5,
        target.y + y + 0.5,
        active.center[2] + active.size[2] / 2 + 0.008,
      ],
    },
    { planes: request.planes, volumes: request.volumes },
    { epsilon: 0.002 },
  );
  const rgb = trace.stats.prunedWeight.map(
    (weight, channel) => weight * linear(environment[channel]),
  );
  for (const sample of trace.samples) {
    const color = sample.kind === 'plane' ? colors.get(sample.sourceId!)! : environment;
    for (let channel = 0; channel < 3; channel++)
      rgb[channel] += sample.weight[channel] * linear(color[channel]);
  }
  return rgb.map(display);
}

function batchProof() {
  prepare({ double: true, blur: 5 });
  const requests = request.volumes.map((volume) => ({
    ...request,
    activeVolumeId: volume.id,
    pixelRatio: volume.id === 'capsule' ? 1 : 0.7,
    target: {
      x: volume.center[0] - volume.size[0] / 2,
      y: volume.center[1] - volume.size[1] / 2,
      width: volume.size[0],
      height: volume.size[1],
    },
  }));
  const expected = requests.map((item) => {
    const frame = renderer!.render(item)!;
    const copy = document.createElement('canvas');
    copy.width = frame.width;
    copy.height = frame.height;
    const context = copy.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(frame, 0, 0);
    return {
      width: copy.width,
      height: copy.height,
      pixels: context.getImageData(0, 0, copy.width, copy.height).data,
    };
  });
  const before = renderer!.metrics;
  const batch = renderer!.renderBatch(requests)!;
  const staging = document.createElement('canvas');
  staging.width = batch.canvas.width;
  staging.height = batch.canvas.height;
  const context = staging.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(batch.canvas, 0, 0);
  const differences = batch.tiles.map((tile, index) => {
    const actual = context.getImageData(tile.x, tile.y, tile.width, tile.height).data;
    let difference = 0;
    for (let at = 0; at < actual.length; at++)
      difference = Math.max(difference, Math.abs(actual[at] - expected[index].pixels[at]));
    return {
      difference,
      size: [tile.width, tile.height],
      expectedSize: [expected[index].width, expected[index].height],
    };
  });
  const first = renderer!.metrics;
  renderer!.renderBatch(requests);
  const second = renderer!.metrics;
  return {
    differences,
    draws: first.draws - before.draws,
    allocations: second.bufferResizes - first.bufferResizes,
    uploads: second.sourceUploads - before.sourceUploads,
  };
}

function directProof() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:320px;height:100px';
  canvas.dataset.glass3dDirect = '';
  document.body.append(canvas);
  const direct = createGlassRenderer({ canvas, preserveDrawingBuffer: false });
  prepare({ double: true, source: 'solid' });
  const frame = direct!.render(request)!;
  const context = frame.getContext('webgl2')!;
  const pixel = new Uint8Array(4);
  context.readPixels(160, frame.height - 51, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
  const result = {
    sameCanvas: frame === canvas,
    preserved: context.getContextAttributes()!.preserveDrawingBuffer,
    pixel: Array.from(pixel),
    expected: oracle(160, 50),
    error: context.getError(),
  };
  direct!.dispose();
  canvas.remove();
  return result;
}

export const glass3dTest = {
  batchProof,
  directProof,
  dispose: () => {
    disposed = true;
    renderer?.dispose();
  },
  errors,
  frame: () => Array.from(outputContext.getImageData(0, 0, output.width, output.height).data),
  lifecycle: () => ({ disposed, lost, restored }),
  loseContext: () => {
    lossExtension =
      renderer?.canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context') ?? null;
    lossExtension?.loseContext();
  },
  oracle,
  pixel: (x: number, y: number) => Array.from(outputContext.getImageData(x, y, 1, 1).data),
  render,
  resolution: (pixelRatio: number) => {
    const frame = renderer?.render({ ...request, pixelRatio });
    return frame ? [frame.width, frame.height] : null;
  },
  restoreContext: () => lossExtension?.restoreContext(),
  supported: !!renderer,
};

declare global {
  interface Window {
    glass3dTest: typeof glass3dTest;
  }
}
window.glass3dTest = glass3dTest;
render({ double: true });
