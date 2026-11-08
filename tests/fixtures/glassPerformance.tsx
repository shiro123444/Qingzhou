/** Real runtime stress fixture. Instrumentation lives here, never in the product bundle. */
import { mountLiquidGlass } from '@/features/LiquidGlass/runtime';
import { mountThreeGlass } from '@/features/LiquidGlass/three/runtime';
import { AudioEngine } from '@/features/MusicPlayer/engine';
import { type MusicTrack } from '@/types/music';

interface DrawSample {
  cost: number;
  kind: string;
  time: number;
}

export interface GlassPerformanceResult {
  audioAdvance: number;
  audioCount: number;
  audioPaused: boolean;
  audioWaiting: number;
  canvasCount: number;
  canvasDraws: Record<string, number>;
  capsuleDrawCostP95: number;
  capsuleFps: number;
  capsuleFrameP95: number;
  duration: number;
  inputEvents: number;
  inputLatencyP95: number;
  inputText: string;
  longTaskCount: number;
  longTaskMax: number;
  rafFps: number;
  rafFrameP95: number;
  rafMax: number;
  renderer: string;
  sourceUploadHz: Record<string, number>;
  sourceUploads: Record<string, number>;
}

interface SourceMotionResult {
  after: string;
  audioPaused: boolean;
  before: string;
  duration: number;
  uploadIncrease: number;
}

interface TopologyContinuityResult {
  audioAdvance: number;
  audioCount: number;
  audioPaused: boolean;
  duration: number;
  finalCanvasCount: number;
  initialCanvasCount: number;
  interruptions: Array<{ frame: number; kind: string }>;
  panelAdded: boolean;
  panelRemoved: boolean;
  panelRendered: boolean;
  samples: number;
}

declare global {
  interface Window {
    glassPerformance: {
      cleanup: () => number;
      isPlaying: () => boolean;
      ready: () => boolean;
      run: (duration?: number) => Promise<GlassPerformanceResult>;
      startAudio: () => Promise<void>;
      verifySourceMotion: () => Promise<SourceMotionResult>;
      verifyTopologyContinuity: () => Promise<TopologyContinuityResult>;
      verifyWallpaperSource: () => Promise<SourceMotionResult>;
    };
  }
}

const style = document.createElement('style');
style.textContent = `
  html,body { margin:0; width:100%; height:100%; overflow:hidden; font:14px system-ui; }
  * { box-sizing:border-box; }
  [data-qz-glass-scene] { position:relative; width:100vw; height:100vh; color:#1d3638; background:radial-gradient(at 20% 20%,#c5e7dc,transparent 60%),linear-gradient(130deg,#eef6fa,#e0e6ed); }
  [data-qz-glass] { position:absolute; border:1px solid #a4c0c055; background:#edf6f799; border-radius:18px; }
  aside { left:8px; top:8px; width:186px; bottom:8px; padding:22px; }
  main { left:202px; top:8px; right:8px; bottom:8px; padding:20px; }
  header { left:12px; top:12px; right:12px; height:48px; padding:14px; }
  article { position:absolute; top:80px; left:36px; right:36px; display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  article p { margin:0; padding:10px; border-radius:9px; background:#ffffff70; }
  #composer { left:36px; right:36px; bottom:28px; height:132px; padding:14px; border-radius:24px; }
  textarea { position:relative; width:100%; height:70px; resize:none; border:0; background:transparent; font:16px system-ui; color:inherit; }
  #echo { height:20px; white-space:nowrap; overflow:hidden; }
  #capsule { z-index:100; left:300px; top:170px; width:380px; height:76px; border-radius:38px; display:flex; gap:18px; align-items:center; padding:18px 24px; touch-action:none; }
  #capsule b { font-size:24px; }
  #capsule span { flex:1; }
  #capsule time { min-width:44px; }
`;
document.head.append(style);
const scene = document.createElement('div');
scene.dataset.qzGlassScene = '';
scene.innerHTML = `<aside data-qz-glass="sidebar"><h2>清舟</h2><p>聊天</p><p>资源</p><p>音乐</p></aside><main data-qz-glass="shell"><header data-qz-glass="header">真实玻璃 · 连续交互测试</header><article>${Array.from({ length: 24 }, (_, i) => `<p>内容 ${i + 1} — 清晰的正文与背景纹理。<br>输入和音乐应保持响应。</p>`).join('')}</article><section id="composer" data-qz-glass="composer"><textarea aria-label="Performance input" placeholder="输入测试"></textarea><div id="echo"></div></section></main><section id="capsule" data-qz-glass="capsule"><b>♫</b><span>清舟 · 连续播放</span><time>0.0</time></section>`;
document.body.append(scene);
const capsule = scene.querySelector<HTMLElement>('#capsule')!;
const input = scene.querySelector<HTMLTextAreaElement>('textarea')!;
const echo = scene.querySelector<HTMLElement>('#echo')!;
const clock = scene.querySelector('time')!.firstChild!;
echo.append(document.createTextNode(''));

let active = false;
let draws: DrawSample[] = [];
let sourceUploads: Record<string, number> = {};
let longTasks: PerformanceEntry[] = [];
let inputLatencies: number[] = [];
let inputEvents = 0;
let audioCount = 0;
let audioWaiting = 0;
let audio: HTMLAudioElement | undefined;
let sourceProbe: { fingerprints: string[]; lastUpload: number } | undefined;

const recordDraw = (canvas: HTMLCanvasElement | OffscreenCanvas, time: number) => {
  if (
    !active ||
    !(canvas instanceof HTMLCanvasElement) ||
    !canvas.hasAttribute('data-qz-glass-canvas')
  )
    return;
  const kind = canvas.parentElement?.dataset.qzGlass;
  if (kind) draws.push({ cost: performance.now() - time, kind, time: performance.now() });
};
const originalCopy = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function (
  ...args: [CanvasImageSource, ...number[]]
) {
  const start = performance.now();
  Reflect.apply(originalCopy, this, args);
  recordDraw(this.canvas, start);
};
const originalDraw = WebGL2RenderingContext.prototype.drawArrays;
WebGL2RenderingContext.prototype.drawArrays = function (...args: Parameters<typeof originalDraw>) {
  const start = performance.now();
  Reflect.apply(originalDraw, this, args);
  recordDraw(this.canvas, start);
};
const recordUpload = (context: WebGL2RenderingContext, args: unknown[]) => {
  // Count actual atlas pixels, not storage allocation. The direct player and shared
  // compositor each own one texture, so keep their rates separate instead of summing.
  const source = args.find(
    (arg) =>
      arg instanceof HTMLCanvasElement ||
      arg instanceof OffscreenCanvas ||
      arg instanceof ImageBitmap,
  );
  if ((!active && !sourceProbe) || !source) return;
  const canvas = context.canvas;
  const kind =
    canvas instanceof HTMLCanvasElement
      ? (canvas.parentElement?.dataset.qzGlass ?? 'shared')
      : 'shared';
  if (active) sourceUploads[kind] = (sourceUploads[kind] ?? 0) + 1;
  if (sourceProbe && kind === 'capsule' && source instanceof HTMLCanvasElement) {
    // Correctness probe only, after timing has stopped: inspect the actual uploaded
    // atlas pixels rather than treating a redundant upload as a content update.
    const pixels = source.getContext('2d')!.getImageData(0, 0, source.width, source.height).data;
    let hash = 2166136261;
    for (let i = 0; i < pixels.length; i += 16) hash = Math.imul(hash ^ pixels[i], 16777619);
    sourceProbe.fingerprints.push(`${source.width}x${source.height}:${hash >>> 0}`);
    sourceProbe.lastUpload = performance.now();
  }
};
const originalTexImage = WebGL2RenderingContext.prototype.texImage2D;
WebGL2RenderingContext.prototype.texImage2D = function (...args: unknown[]) {
  Reflect.apply(originalTexImage, this, args);
  recordUpload(this, args);
};
const originalTexSubImage = WebGL2RenderingContext.prototype.texSubImage2D;
WebGL2RenderingContext.prototype.texSubImage2D = function (...args: unknown[]) {
  Reflect.apply(originalTexSubImage, this, args);
  recordUpload(this, args);
};
const observer = new PerformanceObserver((entries) => {
  if (active) longTasks.push(...entries.getEntries());
});
observer.observe({ entryTypes: ['longtask'] });
input.addEventListener('input', (event) => {
  echo.firstChild!.textContent = input.value;
  if (!active) return;
  inputEvents++;
  requestAnimationFrame(() => inputLatencies.push(performance.now() - event.timeStamp));
});

const track: MusicTrack = {
  id: 'performance',
  mimeType: 'audio/mpeg',
  name: 'Local test tone',
  size: 1,
  source: 'library',
  version: '1',
};
const engine = new AudioEngine({
  client: {
    resolve: async () => ({ src: '/api/runtime/music/tracks/performance/stream', track }),
    search: async () => [track],
    track: async () => track,
    uploadAudio: async () => track,
  },
  createAudio: () => {
    audioCount++;
    audio = new Audio();
    audio.muted = true;
    audio.addEventListener('waiting', () => {
      if (active) audioWaiting++;
    });
    return audio;
  },
  storage: { getItem: () => null, removeItem: () => {}, setItem: () => {} },
});
const unsubscribe = engine.store.subscribe((state) => {
  clock.textContent = (state.positionMs / 1000).toFixed(1);
});
const stopFallback = mountLiquidGlass();
const stopThree = mountThreeGlass();

const probe = document.createElement('canvas');
const gl = probe.getContext('webgl2');
const debug = gl?.getExtension('WEBGL_debug_renderer_info');
const renderer = String(
  gl?.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) ?? 'unavailable',
);
gl?.getExtension('WEBGL_lose_context')?.loseContext();

const percentile = (values: number[], p: number) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]
    : 0;
const differences = (times: number[]) => times.slice(1).map((time, i) => time - times[i]);

const waitUntil = (condition: () => boolean) =>
  new Promise<void>((resolve, reject) => {
    const started = performance.now();
    const check = () => {
      if (condition()) resolve();
      else if (performance.now() - started > 5000)
        reject(new Error('Glass source motion did not update its texture.'));
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });

window.glassPerformance = {
  cleanup: () => {
    stopThree();
    stopFallback();
    engine.dispose();
    unsubscribe();
    observer.disconnect();
    CanvasRenderingContext2D.prototype.drawImage = originalCopy;
    WebGL2RenderingContext.prototype.drawArrays = originalDraw;
    WebGL2RenderingContext.prototype.texImage2D = originalTexImage;
    WebGL2RenderingContext.prototype.texSubImage2D = originalTexSubImage;
    return document.querySelectorAll('[data-qz-glass-canvas]').length;
  },
  ready: () => capsule.dataset.qzRenderer === 'webgl2' && scene.dataset.qzGlassStatus === 'ready',
  isPlaying: () => !!audio && !audio.paused && audio.currentTime > 0.1,
  startAudio: async () => {
    await engine.setAccount('performance-fixture');
    engine.playTrack(track);
  },
  verifyTopologyContinuity: async () => {
    await waitUntil(() => window.glassPerformance.ready());
    const originals = ['shell', 'sidebar', 'capsule'].map((kind) => {
      const host = scene.querySelector<HTMLElement>(`[data-qz-glass="${kind}"]`)!;
      const canvas = host.querySelector<HTMLCanvasElement>(':scope > [data-qz-glass-canvas]');
      if (!canvas || host.dataset.qzRenderer !== 'webgl2')
        throw new Error(`Missing initial ${kind} glass canvas`);
      return { canvas, host, kind };
    });
    const panel = document.createElement('section');
    panel.dataset.qzGlass = 'panel';
    panel.textContent = 'Playback queue — a newly registered glass layer';
    panel.style.cssText =
      'left:480px;top:210px;width:280px;height:110px;padding:18px;border-radius:24px;z-index:90';
    const initialCanvasCount = scene.querySelectorAll('[data-qz-glass-canvas]').length;
    const originalWidth = capsule.style.width;
    const audioStart = audio?.currentTime ?? 0;
    const start = performance.now();
    const interruptions: TopologyContinuityResult['interruptions'] = [];
    let samples = 0;
    let panelAdded = false;
    let panelRemoved = false;
    let panelRendered = false;
    const sample = () => {
      samples++;
      for (const { canvas, host, kind } of originals) {
        if (
          !canvas.isConnected ||
          canvas.parentElement !== host ||
          host.dataset.qzRenderer !== 'webgl2' ||
          host.querySelector(':scope > [data-qz-glass-canvas]') !== canvas ||
          canvas.width === 0 ||
          canvas.height === 0
        )
          interruptions.push({ frame: samples, kind });
      }
      panelRendered ||= panel.dataset.qzRenderer === 'webgl2';
    };
    try {
      await new Promise<void>((resolve) => {
        const step = (now: number) => {
          sample();
          const progress = Math.min(1, (now - start) / 500);
          if (progress >= 0.2 && !panelAdded) {
            scene.append(panel);
            panelAdded = true;
          }
          if (progress >= 0.75 && !panelRemoved) {
            panel.remove();
            panelRemoved = true;
          }
          // Exercise a continuous expanded → compact → expanded geometry change.
          capsule.style.width = `${76 + 304 * Math.abs(Math.cos(progress * Math.PI))}px`;
          if (progress >= 1) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      capsule.style.width = originalWidth;
      await waitUntil(() => {
        sample();
        return window.glassPerformance.ready();
      });
      return {
        audioAdvance: (audio?.currentTime ?? 0) - audioStart,
        audioCount,
        audioPaused: audio?.paused ?? true,
        duration: performance.now() - start,
        finalCanvasCount: scene.querySelectorAll('[data-qz-glass-canvas]').length,
        initialCanvasCount,
        interruptions,
        panelAdded,
        panelRemoved,
        panelRendered,
        samples,
      };
    } finally {
      panel.remove();
      capsule.style.width = originalWidth;
    }
  },
  verifySourceMotion: async () => {
    engine.pause();
    unsubscribe();
    const ordinaryContent = scene.querySelector<HTMLElement>('article p')!;
    const probe = { fingerprints: [] as string[], lastUpload: performance.now() };
    sourceProbe = probe;
    try {
      // Establish a deterministic source, then allow queued audio/pointer work to settle.
      ordinaryContent.style.backgroundColor = '#ff5c52';
      await waitUntil(
        () =>
          probe.fingerprints.length > 0 &&
          scene.dataset.qzGlassStatus === 'ready' &&
          performance.now() - probe.lastUpload > 200,
      );
      const before = probe.fingerprints.at(-1)!;
      const uploads = probe.fingerprints.length;
      const start = performance.now();
      // This is the only mutation under test; the node is neither glass nor a motion host.
      ordinaryContent.style.transform = 'translate(90px, 18px)';
      await waitUntil(() => probe.fingerprints.length > uploads);
      return {
        after: probe.fingerprints.at(-1)!,
        audioPaused: audio?.paused ?? true,
        before,
        duration: performance.now() - start,
        uploadIncrease: probe.fingerprints.length - uploads,
      };
    } finally {
      sourceProbe = undefined;
    }
  },
  verifyWallpaperSource: async () => {
    engine.pause();
    unsubscribe();
    const poster = document.createElement('canvas');
    poster.width = 16;
    poster.height = 16;
    const context = poster.getContext('2d')!;
    const makeWallpaper = (color: string) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 16, 16);
      context.fillStyle = '#fff';
      context.fillRect(0, 0, 8, 8);
      return `url("${poster.toDataURL('image/png')}")`;
    };
    const originalBackground = scene.style.backgroundImage;
    const probe = { fingerprints: [] as string[], lastUpload: performance.now() };
    sourceProbe = probe;
    try {
      scene.style.backgroundImage = makeWallpaper('#e83446');
      await waitUntil(
        () =>
          probe.fingerprints.length > 0 &&
          scene.dataset.qzGlassStatus === 'ready' &&
          performance.now() - probe.lastUpload > 200,
      );
      const before = probe.fingerprints.at(-1)!;
      const uploads = probe.fingerprints.length;
      const start = performance.now();
      // Only the decoded inline raster wallpaper changes; no network or remote artwork.
      scene.style.backgroundImage = makeWallpaper('#346de8');
      await waitUntil(() => probe.fingerprints.length > uploads);
      return {
        after: probe.fingerprints.at(-1)!,
        audioPaused: audio?.paused ?? true,
        before,
        duration: performance.now() - start,
        uploadIncrease: probe.fingerprints.length - uploads,
      };
    } finally {
      sourceProbe = undefined;
      scene.style.backgroundImage = originalBackground;
      poster.width = 0;
      poster.height = 0;
    }
  },
  run: async (duration = 4000) => {
    draws = [];
    sourceUploads = {};
    inputLatencies = [];
    inputEvents = 0;
    longTasks = [];
    audioWaiting = 0;
    active = true;
    const start = performance.now();
    const audioStart = audio?.currentTime ?? 0;
    const frames: number[] = [];
    capsule.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, buttons: 1, pointerId: 1 }),
    );
    await new Promise<void>((resolve) => {
      const step = (now: number) => {
        frames.push(now);
        const progress = (now - start) / duration;
        if (progress >= 1) {
          resolve();
          return;
        }
        const x = 160 + Math.sin(progress * Math.PI * 4) * 140;
        const y = 130 + Math.sin(progress * Math.PI * 2) * 105;
        capsule.style.transform = `translate(${x}px,${y}px)`;
        capsule.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            buttons: 1,
            clientX: 300 + x,
            clientY: 170 + y,
            pointerId: 1,
          }),
        );
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const end = performance.now();
    active = false;
    capsule.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, buttons: 0, pointerId: 1 }),
    );
    const capsuleDraws = draws.filter(({ kind }) => kind === 'capsule');
    return {
      audioAdvance: (audio?.currentTime ?? 0) - audioStart,
      audioCount,
      audioPaused: audio?.paused ?? true,
      audioWaiting,
      canvasCount: scene.querySelectorAll('[data-qz-glass-canvas]').length,
      canvasDraws: draws.reduce<Record<string, number>>((counts, draw) => {
        counts[draw.kind] = (counts[draw.kind] ?? 0) + 1;
        return counts;
      }, {}),
      capsuleDrawCostP95: percentile(
        capsuleDraws.map(({ cost }) => cost),
        0.95,
      ),
      capsuleFps: capsuleDraws.length / ((end - start) / 1000),
      capsuleFrameP95: percentile(differences(capsuleDraws.map(({ time }) => time)), 0.95),
      duration: end - start,
      inputEvents,
      inputLatencyP95: percentile(inputLatencies, 0.95),
      inputText: input.value,
      longTaskCount: longTasks.length,
      longTaskMax: Math.max(0, ...longTasks.map(({ duration }) => duration)),
      rafFps: (frames.length - 1) / ((frames.at(-1)! - frames[0]) / 1000),
      rafFrameP95: percentile(differences(frames), 0.95),
      rafMax: Math.max(0, ...differences(frames)),
      renderer,
      sourceUploadHz: Object.fromEntries(
        Object.entries(sourceUploads).map(([kind, count]) => [
          kind,
          count / ((end - start) / 1000),
        ]),
      ),
      sourceUploads,
    };
  },
};
