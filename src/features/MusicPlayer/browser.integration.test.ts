// @vitest-environment node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import sharp from 'sharp';
import { createServer } from 'vite';
import { expect, it } from 'vitest';

import music from '@/locales/default/music';
import { type MusicFile, type MusicProvider } from '@/server/runtime/music/contracts';
import { handleMusicCommand, handleMusicStream } from '@/server/runtime/music/handler';
import { musicByteRange, OwnedFileMusicProvider } from '@/server/runtime/music/owned-file-provider';
import { createMusicRuntime } from '@/server/runtime/music/runtime';
import { type MusicTrack } from '@/types/music';
import { type MusicLibraryPlaylist } from '@/types/music-account';

import { type AudioEngine } from './engine';
import { type MusicPluginHost } from './plugins/runtime';

// Playwright is an existing e2e workspace dependency. Keep it out of the production bundle.
interface Locator {
  boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
  click: () => Promise<void>;
  fill: (value: string) => Promise<void>;
  getAttribute: (name: string) => Promise<string | null>;
  press: (key: string) => Promise<void>;
  selectOption: (value: string) => Promise<unknown>;
  setInputFiles: (file: { buffer: Buffer; mimeType: string; name: string }) => Promise<void>;
}
interface BrowserPage {
  context: () => {
    newCDPSession: (page: BrowserPage) => Promise<{
      detach: () => Promise<void>;
      send: (method: string, parameters: Record<string, unknown>) => Promise<unknown>;
    }>;
  };
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
  getByRole: (role: string, options: { exact?: boolean; name: string }) => Locator;
  goto: (url: string, options: { waitUntil: 'commit' }) => Promise<unknown>;
  locator: (selector: string) => Locator;
  mouse: {
    down: () => Promise<void>;
    move: (x: number, y: number, options?: { steps: number }) => Promise<void>;
    up: () => Promise<void>;
  };
  on: (event: 'pageerror', handler: (error: Error) => void) => void;
  reload: () => Promise<unknown>;
  screenshot: (options: {
    clip?: { x: number; y: number; width: number; height: number };
    fullPage?: boolean;
    path?: string;
  }) => Promise<Buffer>;
  setViewportSize: (size: { height: number; width: number }) => Promise<void>;
  waitForFunction: (
    fn: () => boolean,
    arg?: undefined,
    options?: { timeout: number },
  ) => Promise<unknown>;
}
declare global {
  interface Window {
    musicTest: {
      audio?: HTMLAudioElement;
      audioCount: number;
      engine: AudioEngine;
      inputLatencyMs?: number;
      plugins: MusicPluginHost;
    };
  }
}

it.runIf(process.env.MUSIC_BROWSER_EXECUTABLE && process.env.MUSIC_TEST_MP3)(
  'uploads, plays, seeks lyrics, controls one audio across routes, restores paused and stops on logout in a real browser',
  async () => {
    const bytes = await readFile(process.env.MUSIC_TEST_MP3!);
    const rows = new Map<string, MusicFile>();
    const objects = new Map<string, Buffer>();
    const host = createMusicRuntime();
    let base = '';
    let counter = 0;
    const requests: string[] = [];
    const library = new OwnedFileMusicProvider(
      'alice',
      {
        findById: async (id) => rows.get(id),
        queryAudio: async ({ query, limit }) =>
          [...rows.values()].filter((row) => row.name.includes(query)).slice(0, limit),
      },
      {
        createPreSignedUrlForPreview: async (key) => `${base}/fixture/storage/${key}`,
        getFileMetadata: async (key) => ({ contentLength: objects.get(key)!.length }),
      },
    );
    let lyricRequests = 0;
    const online: MusicTrack = {
      id: 'online-fixture',
      name: 'Online preview',
      mimeType: 'audio/mpeg',
      size: bytes.length,
      source: 'kugou',
      version: 'fixture',
      playbackKind: 'preview',
      durationMs: 20000,
    };
    const liked: MusicTrack = {
      ...online,
      id: 'liked-fixture',
      name: 'Liked fixture',
      playbackKind: 'full',
      durationMs: 269000,
    };
    const collected: MusicTrack = {
      ...liked,
      id: 'collected-fixture',
      name: 'Collected fixture',
    };
    const likedTracks = Array.from({ length: 669 }, (_, index) =>
      index === 0
        ? liked
        : {
            ...liked,
            id: `liked-fixture-${index + 1}`,
            name: `Liked fixture ${index + 1}`,
          },
    );
    const wordLyrics = [
      '[1000,3000]<0,600,0>Bright <600,1200,0>river <1800,1200,0>flows',
      '[5000,4000]<0,1400,0>Across <1400,2600,0>night',
      ...Array.from(
        { length: 60 },
        (_, index) => `[${10000 + index * 300},280]<0,100,0>Line <100,180,0>${index + 1}`,
      ),
    ].join('\n');
    const catalog = new Map([online, ...likedTracks, collected].map((track) => [track.id, track]));
    const playlists: MusicLibraryPlaylist[] = [
      { id: '101', name: 'Liked songs fixture', kind: 'liked', trackCount: 669 },
      { id: '102', name: 'Collected playlist fixture', kind: 'collected', trackCount: 1 },
    ];
    const accountRevision = '55d73ef1-8f31-4e90-abf7-2d3e663d988e';
    const libraryRequests: { operation: string; page?: number; playlistId?: string }[] = [];
    const resolvedTracks: string[] = [];
    const provider: MusicProvider = {
      userId: 'alice',
      track: (id, signal) =>
        catalog.has(id) ? Promise.resolve(catalog.get(id)!) : library.track(id, signal),
      search: (query, limit, signal, source) =>
        source === 'kugou' && query === 'automatic'
          ? Promise.resolve([online])
          : library.search(query, limit, signal),
      resolve: (id, signal) => {
        resolvedTracks.push(id);
        return catalog.has(id)
          ? Promise.resolve({
              src: `/api/runtime/music/tracks/${id}/stream`,
              track: catalog.get(id)!,
              offsetMs: id === online.id ? 10000 : 0,
            })
          : library.resolve(id, signal);
      },
      stream: (id, request) => library.stream(catalog.has(id) ? 'track-1' : id, request),
      lyrics: async (trackId) => {
        lyricRequests++;
        return {
          trackId,
          format: trackId === liked.id ? 'krc' : 'lrc',
          text:
            trackId === online.id
              ? '[00:09]Clip begins\n[00:12]Inside online clip\n[00:35]Outside available clip'
              : trackId === liked.id
                ? wordLyrics
                : `[00:01]${catalog.get(trackId)!.name} lyric`,
        };
      },
    };
    const server = await createServer({
      configFile: false,
      envFile: false,
      logLevel: 'error',
      root: process.cwd(),
      cacheDir: '.data/music-m2-validation/vite',
      resolve: { alias: { '@': path.resolve('src') }, dedupe: ['react', 'react-dom'] },
      define: {
        '__DEV__': 'true',
        '__TEST__': 'true',
        '__ELECTRON__': 'false',
        '__MOBILE__': 'false',
        'process.env': '{}',
      },
      optimizeDeps: {
        noDiscovery: true,
        entries: [],
        include: [
          'react',
          'react/jsx-runtime',
          'react/jsx-dev-runtime',
          'react-dom/client',
          'react-router-dom',
          '@lobehub/ui',
          'antd',
          'antd-style',
          'i18next',
          'react-i18next',
          'lucide-react',
          'zustand',
          'zustand/vanilla',
          'zod',
          'js-sha256',
          'file-type',
        ],
      },
      plugins: [
        react(),
        {
          name: 'music-browser-fixture',
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              const pathname = req.url?.split('?')[0] ?? '/';
              if (
                !['/music', '/chat', '/presentation', '/glass-lab'].includes(pathname) &&
                !pathname.startsWith('/fixture/') &&
                !pathname.startsWith('/api/runtime/music')
              )
                return next();
              void (async () => {
                if (['/music', '/chat', '/presentation', '/glass-lab'].includes(pathname)) {
                  const html = await vite.transformIndexHtml(
                    pathname,
                    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui}</style></head><body><div id="root"></div><script type="module" src="/tests/fixtures/musicM2.tsx"></script></body></html>',
                  );
                  res.setHeader('Content-Type', 'text/html');
                  res.end(html);
                  return;
                }
                const chunks: Buffer[] = [];
                for await (const chunk of req) chunks.push(Buffer.from(chunk));
                const body = Buffer.concat(chunks);
                if (pathname === '/api/runtime/music/account') {
                  const input = JSON.parse(body.toString());
                  let result: unknown;
                  if (input.operation === 'library') {
                    libraryRequests.push({ operation: input.operation });
                    result = { revision: accountRevision, playlists, page: 1, hasMore: false };
                  } else if (input.operation === 'playlist') {
                    const page = input.page ?? 1;
                    const entries = input.playlistId === '101' ? likedTracks : [collected];
                    libraryRequests.push({
                      operation: input.operation,
                      page,
                      playlistId: input.playlistId,
                    });
                    result = {
                      revision: accountRevision,
                      playlist: playlists.find((playlist) => playlist.id === input.playlistId),
                      tracks: entries.slice((page - 1) * 100, page * 100),
                      page,
                      hasMore: page * 100 < entries.length,
                      total: entries.length,
                    };
                  } else {
                    result = {
                      state: 'connected',
                      revision: accountRevision,
                      displayName: 'Fixture listener',
                    };
                  }
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ success: true, result }));
                  return;
                }
                if (pathname === '/fixture/upload') {
                  const path = `${++counter}.mp3`;
                  objects.set(path, body);
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ path }));
                  return;
                }
                if (pathname === '/fixture/register') {
                  const input = JSON.parse(body.toString());
                  const id = `track-${counter}`;
                  rows.set(id, {
                    ...input,
                    fileType: input.fileType,
                    id,
                    updatedAt: new Date(),
                    userId: 'alice',
                  });
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ id }));
                  return;
                }
                if (pathname.startsWith('/fixture/storage/')) {
                  const object = objects.get(pathname.slice('/fixture/storage/'.length))!;
                  const range = req.headers.range
                    ? musicByteRange(req.headers.range, object.length)
                    : undefined;
                  const payload = range ? object.subarray(range.start, range.end + 1) : object;
                  res.writeHead(range ? 206 : 200, {
                    'Content-Type': 'audio/mpeg',
                    'Content-Length': payload.length,
                    ...(range
                      ? { 'Content-Range': `bytes ${range.start}-${range.end}/${object.length}` }
                      : {}),
                  });
                  res.end(payload);
                  return;
                }
                const headers = new Headers();
                for (const [name, value] of Object.entries(req.headers))
                  if (typeof value === 'string') headers.set(name, value);
                const request = new Request(new URL(pathname, base), {
                  method: req.method,
                  headers,
                  ...(req.method === 'POST' ? { body } : {}),
                });
                const id = /^\/api\/runtime\/music\/tracks\/([^/]+)\/stream$/.exec(pathname)?.[1];
                const response = id
                  ? await handleMusicStream(request, id, provider)
                  : await handleMusicCommand(request, provider, host);
                if (!id)
                  requests.push(
                    `${body.toString()}: ${response.status} ${await response.clone().text()}`,
                  );
                res.writeHead(response.status, Object.fromEntries(response.headers));
                if (response.body) for await (const chunk of response.body) res.write(chunk);
                res.end();
              })().catch((error: Error) => {
                res.statusCode = 500;
                res.end(error.message);
              });
            });
          },
        },
      ],
      server: { host: '127.0.0.1', port: 0, preTransformRequests: false, strictPort: false },
    });
    const require = createRequire(new URL('../../../e2e/package.json', import.meta.url));
    const { chromium } = require('playwright') as {
      chromium: {
        launch: (options: {
          args: string[];
          executablePath: string;
          headless: boolean;
        }) => Promise<{
          close: () => Promise<void>;
          newPage: () => Promise<BrowserPage>;
        }>;
      };
    };
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let page: BrowserPage | undefined;
    const errors: string[] = [];
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === 'string') throw new Error('No browser test address');
      base = `http://127.0.0.1:${address.port}`;
      const sanity = await fetch(`${base}/api/runtime/music`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'music.search', input: {} }),
      });
      expect(await sanity.json()).toMatchObject({ success: true });
      browser = await chromium.launch({
        executablePath: process.env.MUSIC_BROWSER_EXECUTABLE!,
        headless: true,
        args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
      });
      page = await browser.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}/glass-lab`, { waitUntil: 'commit' });
      await page.waitForFunction(
        () => document.querySelector('[data-glass-probe]')?.hasAttribute('data-qz-optics') === true,
        undefined,
        { timeout: 60_000 },
      );
      const capabilities = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.setAttribute('content', 'drawable');
        const context = canvas.getContext('2d');
        return {
          userAgent: navigator.userAgent,
          webgpu: 'gpu' in navigator,
          htmlInCanvas: 'content' in canvas && canvas.content === 'drawable',
          drawElementImage: !!context && 'drawElementImage' in context,
          updateElementGeometry: 'updateElementGeometry' in canvas,
        };
      });
      await mkdir('.data/music-m2-validation', { recursive: true });
      await writeFile(
        '.data/music-m2-validation/glass-capabilities.json',
        JSON.stringify(capabilities, null, 2),
      );
      const probeBox = (await page.locator('[data-glass-probe]').boundingBox())!;
      const refracted = await page.screenshot({ clip: probeBox });
      // Disable only displacement: blur, light, tint and the same live backdrop remain unchanged.
      await page.evaluate(async () => {
        const probe = document.querySelector<HTMLElement>('[data-glass-probe]')!;
        const filter = getComputedStyle(probe).backdropFilter;
        const id = /#([^"')]+)/.exec(filter)![1];
        const map = document.getElementById(id)!.querySelector('feDisplacementMap')!;
        map.setAttribute('data-original-scale', map.getAttribute('scale')!);
        map.setAttribute('scale', '0');
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      const flat = await page.screenshot({ clip: probeBox });
      const a = await sharp(refracted).removeAlpha().raw().toBuffer();
      const b = await sharp(flat).removeAlpha().raw().toBuffer();
      const pixelDifference = (left: number, top: number, width: number, height: number) => {
        let sum = 0;
        for (let y = top; y < top + height; y++)
          for (let x = left; x < left + width; x++)
            for (let c = 0; c < 3; c++) {
              const i = (y * 320 + x) * 3 + c;
              sum += Math.abs(a[i] - b[i]);
            }
        return sum / (width * height * 3);
      };
      expect(pixelDifference(3, 45, 10, 10)).toBeGreaterThan(3);
      expect(pixelDifference(70, 30, 180, 40)).toBeLessThan(1);
      // Foreground belongs to the surface, so its pixels must not bend with its backdrop.
      expect(pixelDifference(141, 4, 38, 4)).toBeLessThan(1);
      await page.evaluate(async () => {
        const probe = document.querySelector<HTMLElement>('[data-glass-probe]')!;
        const id = /#([^"')]+)/.exec(getComputedStyle(probe).backdropFilter)![1];
        const map = document.getElementById(id)!.querySelector('feDisplacementMap')!;
        map.setAttribute('scale', map.getAttribute('data-original-scale')!);
        document.querySelector<HTMLElement>('[data-glass-lab]')!.style.backgroundPositionX = '8px';
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      const moved = await page.screenshot({ clip: probeBox });
      expect(Buffer.compare(moved, refracted)).not.toBe(0);
      await writeFile('.data/music-m2-validation/glass-refracted.png', refracted);
      await writeFile('.data/music-m2-validation/glass-flat.png', flat);
      // Reusing a DOM surface at the same size must invalidate its geometry and material.
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('[data-glass-probe]')!.style.borderBottomRightRadius =
          '8px';
      });
      await page.waitForFunction(
        () => !document.querySelector('[data-glass-probe]')?.hasAttribute('data-qz-optics'),
      );
      await page.evaluate(() => {
        const probe = document.querySelector<HTMLElement>('[data-glass-probe]')!;
        probe.style.borderRadius = '18px';
        probe.dataset.qzGlass = 'control';
      });
      await page.waitForFunction(() => {
        const probe = document.querySelector<HTMLElement>('[data-glass-probe]')!;
        const id = /#([^"')]+)/.exec(getComputedStyle(probe).backdropFilter)?.[1];
        return (
          !!id &&
          document
            .getElementById(id)
            ?.querySelector('feGaussianBlur')
            ?.getAttribute('stdDeviation') === '0.5'
        );
      });
      expect(
        await page.evaluate(() => document.querySelectorAll('[data-qz-glass-definitions]').length),
      ).toBe(1);
      const preferences = await page.context().newCDPSession(page);
      for (const name of ['prefers-reduced-transparency', 'prefers-contrast']) {
        await preferences.send('Emulation.setEmulatedMedia', {
          features: [{ name, value: name === 'prefers-contrast' ? 'more' : 'reduce' }],
        });
        await page.waitForFunction(
          () => !document.querySelector('[data-glass-probe]')?.hasAttribute('data-qz-optics'),
        );
        expect(
          await page.evaluate(
            () => getComputedStyle(document.querySelector('[data-glass-probe]')!).backdropFilter,
          ),
        ).toBe('none');
      }
      await preferences.send('Emulation.setEmulatedMedia', { features: [] });
      await preferences.detach();
      await page.goto(`${base}/music`, { waitUntil: 'commit' });
      await page.waitForFunction(
        () => !!window.musicTest?.engine.store.getState().userId,
        undefined,
        { timeout: 60_000 },
      );
      const glassCanvases = () =>
        page!.evaluate(() => {
          const canvases = [
            ...document.querySelectorAll<HTMLCanvasElement>('[data-qz-glass-canvas]'),
          ];
          const surfaces = [...document.querySelectorAll('[data-qz-renderer="webgl2"]')];
          return {
            count: canvases.length,
            owners: surfaces.length,
            valid:
              canvases.every(
                (canvas) =>
                  canvas.width > 0 &&
                  canvas.height > 0 &&
                  canvas.getAttribute('aria-hidden') === 'true' &&
                  getComputedStyle(canvas).pointerEvents === 'none' &&
                  canvas.parentElement?.getAttribute('data-qz-renderer') === 'webgl2',
              ) &&
              surfaces.every(
                (surface) =>
                  surface.querySelectorAll(':scope > [data-qz-glass-canvas]').length === 1,
              ),
          };
        });
      const waitForCapsuleGlass = () =>
        page!.waitForFunction(
          () =>
            document.querySelector('[data-capsule-body]')?.getAttribute('data-qz-renderer') ===
            'webgl2',
          undefined,
          { timeout: 60_000 },
        );
      await waitForCapsuleGlass();
      const studioGlass = await glassCanvases();
      expect(studioGlass.count).toBeGreaterThan(0);
      expect(studioGlass.count).toBeLessThanOrEqual(8);
      expect(studioGlass.owners).toBe(studioGlass.count);
      expect(studioGlass.valid).toBe(true);
      await page.screenshot({
        fullPage: true,
        path: '.data/music-m2-validation/glass-runtime-studio.png',
      });

      // Runtime preferences tear down GPU output, then rebuild one canvas per surviving owner.
      const runtimePreferences = await page.context().newCDPSession(page);
      for (const name of ['prefers-contrast', 'prefers-reduced-transparency']) {
        await runtimePreferences.send('Emulation.setEmulatedMedia', {
          features: [{ name, value: name === 'prefers-contrast' ? 'more' : 'reduce' }],
        });
        await page.waitForFunction(
          () =>
            document.querySelectorAll('[data-qz-renderer="webgl2"], [data-qz-glass-canvas]')
              .length === 0,
        );
        expect(
          await page.evaluate(
            () => getComputedStyle(document.querySelector('[data-capsule-body]')!).backdropFilter,
          ),
        ).toBe('none');
        await runtimePreferences.send('Emulation.setEmulatedMedia', { features: [] });
        await waitForCapsuleGlass();
        const recovered = await glassCanvases();
        expect(recovered.count).toBeLessThanOrEqual(8);
        expect(recovered.owners).toBe(recovered.count);
        expect(recovered.valid).toBe(true);
      }
      await runtimePreferences.detach();
      await page
        .locator('input[type=file][accept="audio/*"]')
        .setInputFiles({ buffer: bytes, mimeType: 'audio/mpeg', name: 'Rain.mp3' });
      await page.waitForFunction(
        () =>
          document
            .querySelector('ul[aria-label="Music library"]')
            ?.textContent?.includes('Rain.mp3') === true,
      );
      await page.getByRole('button', { name: 'Play Rain.mp3', exact: true }).click();
      await page.waitForFunction(
        () => window.musicTest.engine.store.getState().status === 'playing',
      );
      expect(await page.evaluate(() => window.musicTest.audio!.duration)).toBeGreaterThan(7.9);
      // Folding the global surface must never stop or recreate its audio engine.
      await page.getByRole('button', { name: music.capsuleExpand, exact: true }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="music-capsule"]')
            ?.getAttribute('data-positioned') === 'true',
      );
      await waitForCapsuleGlass();
      await page.evaluate(() => {
        document.querySelector<HTMLCanvasElement>(
          '[data-capsule-body] > [data-qz-glass-canvas]',
        )!.dataset.fixtureIdentity = 'persistent-capsule';
      });
      const capsuleBounds = () =>
        page!.evaluate(() => {
          const rect = document.querySelector('[data-capsule-body]')!.getBoundingClientRect();
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        });
      await page.getByRole('link', { name: music.closeStudio, exact: true }).click();
      await page.waitForFunction(() => location.pathname === '/');
      expect(await page.evaluate(() => window.musicTest.audio!.paused)).toBe(false);
      await page.getByRole('link', { name: 'Presentation', exact: true }).click();
      await page.waitForFunction(() => location.pathname === '/presentation');
      await waitForCapsuleGlass();
      const titleBounds = (await page.locator('[data-capsule-body] strong').boundingBox())!;
      await page.mouse.move(
        titleBounds.x + titleBounds.width / 2,
        titleBounds.y + titleBounds.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(220, 180, { steps: 12 });
      await page.mouse.up();
      const dragged = await capsuleBounds();
      expect(dragged.left).toBeLessThan(300);
      expect(dragged.top).toBeLessThan(240);
      expect(await page.evaluate(() => location.pathname)).toBe('/presentation');
      await waitForCapsuleGlass();
      expect(
        await page.evaluate(() => {
          const body = document.querySelector<HTMLElement>('[data-capsule-body]')!;
          const canvas = body.querySelector<HTMLCanvasElement>(':scope > [data-qz-glass-canvas]')!;
          const a = body.getBoundingClientRect();
          const b = canvas.getBoundingClientRect();
          return (
            canvas.dataset.fixtureIdentity === 'persistent-capsule' &&
            Math.abs(a.left - b.left) <= 1 &&
            Math.abs(a.top - b.top) <= 1 &&
            Math.abs(a.width - b.width) <= 2 &&
            Math.abs(a.height - b.height) <= 2
          );
        }),
      ).toBe(true);
      await page.screenshot({
        fullPage: true,
        path: '.data/music-m2-validation/glass-runtime-dragged.png',
      });
      const dragFrom = async (selector: string, dx: number, dy: number, hold = false) => {
        const rect = (await page!.locator(selector).boundingBox())!;
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        await page!.mouse.move(x, y);
        await page!.mouse.down();
        if (hold) await new Promise((resolve) => setTimeout(resolve, 240));
        await page!.mouse.move(x + dx, y + dy, { steps: 10 });
        await page!.mouse.up();
      };
      await dragFrom('[data-capsule-body] button[aria-label="Floating player: pause"]', 50, 30);
      expect((await capsuleBounds()).left).toBeGreaterThan(dragged.left + 40);
      expect(await page.evaluate(() => window.musicTest.audio!.paused)).toBe(false);
      await page.getByRole('button', { name: music.capsulePause, exact: true }).click();
      // Real CSS interpolation must preserve both the moving lens and unrelated page optics.
      const morphReport = await page.evaluate(async () => {
        const body = document.querySelector<HTMLElement>('[data-capsule-body]')!;
        const shell = document.querySelector<HTMLElement>('[data-qz-glass="shell"]')!;
        const capsuleCanvas = body.querySelector(':scope > [data-qz-glass-canvas]');
        const shellCanvas = shell.querySelector(':scope > [data-qz-glass-canvas]');
        const dock = document.querySelector<HTMLElement>('[data-testid="music-capsule"]')!;
        const origin = body.getBoundingClientRect();
        const report = {
          anchorDrift: 0,
          canvasReplacements: 0,
          fallbackFrames: 0,
          frames: 0,
          hiddenFocus: false,
          intermediateWidths: 0,
          missingInitialCanvas: !capsuleCanvas || !shellCanvas,
        };
        const sample = async (button: HTMLButtonElement) => {
          button.focus();
          button.click();
          const started = performance.now();
          do {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const rect = body.getBoundingClientRect();
            report.frames++;
            if (rect.width > 65 && rect.width < origin.width - 5) report.intermediateWidths++;
            report.anchorDrift = Math.max(
              report.anchorDrift,
              Math.abs(rect.right - origin.right),
              Math.abs(rect.bottom - origin.bottom),
            );
            if (body.dataset.qzRenderer !== 'webgl2' || shell.dataset.qzRenderer !== 'webgl2')
              report.fallbackFrames++;
            if (
              body !== document.querySelector('[data-capsule-body]') ||
              capsuleCanvas !== body.querySelector(':scope > [data-qz-glass-canvas]') ||
              shellCanvas !== shell.querySelector(':scope > [data-qz-glass-canvas]')
            )
              report.canvasReplacements++;
            report.hiddenFocus ||= !!document.activeElement?.closest('[inert]');
          } while (performance.now() - started < 560 || dock.dataset.qzGlassMorphing === 'true');
        };
        for (let cycle = 0; cycle < 2; cycle++) {
          await sample(body.querySelector<HTMLButtonElement>('[data-capsule-collapse]')!);
          await sample(body.querySelector<HTMLButtonElement>('[data-capsule-expand]')!);
          await sample(body.querySelector<HTMLButtonElement>('[data-capsule-more]')!);
          await sample(body.querySelector<HTMLButtonElement>('[data-capsule-more]')!);
        }
        return report;
      });
      expect(morphReport.missingInitialCanvas).toBe(false);
      expect(morphReport.frames).toBeGreaterThan(30);
      expect(morphReport.intermediateWidths).toBeGreaterThan(10);
      expect(morphReport.canvasReplacements).toBe(0);
      expect(morphReport.fallbackFrames).toBe(0);
      expect(morphReport.anchorDrift).toBeLessThan(2);
      expect(morphReport.hiddenFocus).toBe(false);

      await page.waitForFunction(() => window.musicTest.audio!.paused);
      await waitForCapsuleGlass();
      const presentationGlass = await glassCanvases();
      for (let cycle = 0; cycle < 3; cycle++) {
        await page.getByRole('link', { name: 'Chat', exact: true }).click();
        await waitForCapsuleGlass();
        await page.getByRole('link', { name: 'Presentation', exact: true }).click();
        await waitForCapsuleGlass();
        expect(await glassCanvases()).toEqual(presentationGlass);
        expect(
          await page.evaluate(
            () =>
              document.querySelector<HTMLCanvasElement>(
                '[data-capsule-body] > [data-qz-glass-canvas]',
              )?.dataset.fixtureIdentity,
          ),
        ).toBe('persistent-capsule');
      }
      const contrast = await page.context().newCDPSession(page);
      const beforeContrast = await capsuleBounds();
      await contrast.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-contrast', value: 'more' }],
      });
      await page.waitForFunction(
        () => document.querySelectorAll('[data-qz-glass-canvas]').length === 0,
      );
      expect(await capsuleBounds()).toEqual(beforeContrast);
      await page.screenshot({
        fullPage: true,
        path: '.data/music-m2-validation/glass-runtime-opaque.png',
      });
      await contrast.send('Emulation.setEmulatedMedia', { features: [] });
      await waitForCapsuleGlass();
      expect(await glassCanvases()).toEqual(presentationGlass);
      expect(await capsuleBounds()).toEqual(beforeContrast);
      await contrast.detach();
      await page.screenshot({
        fullPage: true,
        path: '.data/music-m2-validation/glass-runtime-restored.png',
      });
      const beforeRangeDrag = await page.evaluate(() => window.musicTest.audio!.currentTime);
      const beforeRangeDock = await capsuleBounds();
      await dragFrom('[data-capsule-body] input[type="range"]', 45, 30, true);
      expect((await capsuleBounds()).left).toBeGreaterThan(beforeRangeDock.left + 35);
      expect(await page.evaluate(() => window.musicTest.audio!.currentTime)).toBeCloseTo(
        beforeRangeDrag,
        1,
      );
      const rangeDock = await capsuleBounds();
      await dragFrom('[data-capsule-body] input[type="range"]', 25, 0);
      expect(await capsuleBounds()).toEqual(rangeDock);
      expect(await page.evaluate(() => window.musicTest.audio!.currentTime)).not.toBeCloseTo(
        beforeRangeDrag,
        1,
      );
      // Starting a normal seek must keep seeking even if the pointer is held past 180 ms.
      const seeking = (await page
        .locator('[data-capsule-body] input[type="range"]')
        .boundingBox())!;
      const seekingX = seeking.x + seeking.width / 3;
      const seekingY = seeking.y + seeking.height / 2;
      await page.mouse.move(seekingX, seekingY);
      await page.mouse.down();
      await page.mouse.move(seekingX + 15, seekingY, { steps: 3 });
      await new Promise((resolve) => setTimeout(resolve, 240));
      await page.mouse.move(seekingX + 35, seekingY, { steps: 10 });
      await page.mouse.up();
      expect(await capsuleBounds()).toEqual(rangeDock);
      await page.getByRole('slider', { name: music.capsuleSeek, exact: true }).press('Home');
      expect(await capsuleBounds()).toEqual(rangeDock);
      await page.getByRole('button', { name: music.capsulePlay, exact: true }).click();
      await page.waitForFunction(() => !window.musicTest.audio!.paused);
      await page.locator('[data-capsule-body]').press('ArrowRight');
      const keyboardMoved = await capsuleBounds();
      expect(keyboardMoved.left).toBeGreaterThan(dragged.left);
      const capsulePosition = await page.evaluate(() => window.musicTest.audio!.currentTime);
      await page.getByRole('button', { name: music.capsuleCollapse, exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>('[data-testid="music-capsule"]')?.dataset
            .qzGlassMorphing === 'false',
      );
      const folded = await capsuleBounds();
      expect(Math.abs(folded.right - keyboardMoved.right)).toBeLessThan(2);
      expect(Math.abs(folded.bottom - keyboardMoved.bottom)).toBeLessThan(2);
      await page.mouse.move((folded.left + folded.right) / 2, (folded.top + folded.bottom) / 2);
      await page.mouse.down();
      await page.mouse.move(
        (folded.left + folded.right) / 2 - 60,
        (folded.top + folded.bottom) / 2 - 40,
        { steps: 10 },
      );
      await page.mouse.up();
      const orbDragged = await capsuleBounds();
      expect(orbDragged.left).toBeLessThan(folded.left - 50);
      expect(
        await page.locator('[data-testid="music-capsule"]').getAttribute('data-collapsed'),
      ).toBe('true');
      const touch = await page.context().newCDPSession(page);
      const touchX = (orbDragged.left + orbDragged.right) / 2;
      const touchY = (orbDragged.top + orbDragged.bottom) / 2;
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: touchX, y: touchY, id: 1 }],
      });
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: touchX - 30, y: touchY - 20, id: 1 }],
      });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await touch.detach();
      const touchDragged = await capsuleBounds();
      expect(touchDragged.left).toBeLessThan(orbDragged.left - 20);
      expect(
        await page.locator('[data-testid="music-capsule"]').getAttribute('data-collapsed'),
      ).toBe('true');
      await page.getByRole('link', { name: 'Chat', exact: true }).click();
      await page.getByRole('link', { name: 'Presentation', exact: true }).click();
      expect(await capsuleBounds()).toEqual(touchDragged);
      expect(
        await page.locator('[data-testid="music-capsule"]').getAttribute('data-collapsed'),
      ).toBe('true');
      expect(
        await page.evaluate(() => ({
          count: window.musicTest.audioCount,
          paused: window.musicTest.audio!.paused,
        })),
      ).toEqual({ count: 1, paused: false });
      expect(await page.evaluate(() => window.musicTest.audio!.currentTime)).toBeGreaterThanOrEqual(
        capsulePosition,
      );
      await page.getByRole('button', { name: music.capsuleExpand, exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>('[data-testid="music-capsule"]')?.dataset
            .qzGlassMorphing === 'false',
      );
      // Temporary composer avoidance must not overwrite the user's saved anchor.
      await page.locator('[data-capsule-body]').press('Home');
      const reset = await capsuleBounds();
      await page.getByRole('link', { name: 'Chat', exact: true }).click();
      await page.waitForFunction(() => {
        const a = document.querySelector('[data-capsule-body]')?.getBoundingClientRect();
        const b = document.querySelector('[data-music-player-avoid]')?.getBoundingClientRect();
        if (!a || !b) return false;
        return a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
      });
      expect(await capsuleBounds()).not.toEqual(reset);
      await page.getByRole('link', { name: 'Presentation', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('[data-music-player-avoid]'));
      expect(await capsuleBounds()).toEqual(reset);
      await page.getByRole('link', { name: 'Chat', exact: true }).click();
      await mkdir('.data/music-m2-validation', { recursive: true });
      await page.screenshot({
        fullPage: true,
        path: '.data/music-m2-validation/capsule-desktop.png',
      });
      await page.setViewportSize({ width: 390, height: 850 });
      await page.getByRole('button', { name: music.capsuleMore, exact: true }).click();
      expect(
        await page.evaluate(() => {
          const dock = document.querySelector('[data-testid="music-capsule"]');
          if (!dock) return false;
          const rect = dock.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.top >= 0 &&
            rect.right <= innerWidth &&
            rect.bottom <= innerHeight
          );
        }),
      ).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        fullPage: true,
        path: '.data/music-m2-validation/capsule-mobile.png',
      });
      const panelTouch = await page.context().newCDPSession(page);
      const panelTitle = (await page.locator('[data-capsule-body] strong').boundingBox())!;
      const panelX = panelTitle.x + panelTitle.width / 2;
      const panelY = panelTitle.y + panelTitle.height / 2;
      await panelTouch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: panelX, y: panelY, id: 1 }],
      });
      await panelTouch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: panelX, y: panelY - 40, id: 1 }],
      });
      await panelTouch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await panelTouch.detach();
      await page.getByRole('button', { name: music.capsuleShuffle, exact: true }).click();
      expect(await page.evaluate(() => window.musicTest.engine.store.getState().shuffle)).toBe(
        true,
      );
      await page.getByRole('button', { name: music.capsuleShuffle, exact: true }).click();
      await page.getByRole('button', { name: music.capsuleMore, exact: true }).click();
      await page.getByRole('button', { name: music.capsuleCollapse, exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole('link', { name: 'Presentation', exact: true }).click();
      await page.getByRole('link', { name: 'Music', exact: true }).click();
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.locator('input[type=file][accept=".lrc,text/plain"]').setInputFiles({
        buffer: Buffer.from('[00:00]Opening\n[00:02]Second line\n[00:05]Last line'),
        mimeType: 'text/plain',
        name: 'Rain.lrc',
      });
      await page.getByRole('button', { name: 'Second line', exact: true }).click();
      await page.waitForFunction(() => Math.abs(window.musicTest.audio!.currentTime - 2) < 0.2);
      expect(
        await page
          .locator('[aria-label="Lyrics"] p[aria-current="true"]')
          .getAttribute('aria-current'),
      ).toBe('true');
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.waitForFunction(
        () => window.musicTest.engine.store.getState().status === 'playing',
      );
      const before = await page.evaluate(() => window.musicTest.audio!.currentTime);
      await page.getByRole('tab', { name: music.plugins, exact: true }).click();
      await page.getByRole('switch', { name: music.lyricsPlugin, exact: true }).click();
      await page.waitForFunction(
        () => window.musicTest.plugins.store.getState().status === 'disabled',
      );
      expect(
        await page.evaluate(() => ({
          paused: window.musicTest.audio!.paused,
          count: window.musicTest.audioCount,
          lyrics: window.musicTest.plugins.store.getState().lyrics,
        })),
      ).toEqual({ paused: false, count: 1, lyrics: null });
      await page.getByRole('link', { name: 'Chat', exact: true }).click();
      await page.getByRole('link', { name: 'Presentation', exact: true }).click();
      await page.getByRole('link', { name: 'Music', exact: true }).click();
      expect(await page.evaluate(() => window.musicTest.plugins.store.getState().enabled)).toBe(
        false,
      );
      await page.getByRole('button', { name: music.enableLyricsPlugin, exact: true }).click();
      await page.waitForFunction(
        () => window.musicTest.plugins.store.getState().status === 'active',
      );
      expect(
        await page.evaluate(() => window.musicTest.plugins.store.getState().lyrics?.lines.length),
      ).toBe(3);
      expect(
        await page.evaluate(() => ({
          count: window.musicTest.audioCount,
          paused: window.musicTest.audio!.paused,
          time: window.musicTest.audio!.currentTime,
        })),
      ).toMatchObject({ count: 1, paused: false });
      expect(await page.evaluate(() => window.musicTest.audio!.currentTime)).toBeGreaterThanOrEqual(
        before,
      );
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page
        .locator('input[type=file][accept="audio/*"]')
        .setInputFiles({ buffer: bytes, mimeType: 'audio/mpeg', name: 'Wind.mp3' });
      await page.waitForFunction(
        () =>
          document
            .querySelector('ul[aria-label="Music library"]')
            ?.textContent?.includes('Wind.mp3') === true,
      );
      await page.getByRole('searchbox', { name: 'Search audio by name', exact: true }).fill('Wind');
      await page.waitForFunction(() => {
        const list = document.querySelector('ul[aria-label="Music library"]');
        return (
          list?.textContent?.includes('Wind.mp3') === true && !list.textContent.includes('Rain.mp3')
        );
      });
      await page.getByRole('searchbox', { name: 'Search audio by name', exact: true }).fill('');
      await page.waitForFunction(
        () =>
          document
            .querySelector('ul[aria-label="Music library"]')
            ?.textContent?.includes('Rain.mp3') === true,
      );
      await page.getByRole('button', { name: 'Add to queue Wind.mp3', exact: true }).click();
      await page.getByRole('tab', { name: music.nowPlaying, exact: true }).click();
      await page.getByRole('button', { name: 'Next track', exact: true }).click();
      await page.waitForFunction(
        () =>
          window.musicTest.engine.store.getState().activeId === 'track-2' &&
          window.musicTest.engine.store.getState().status === 'playing',
      );
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.getByRole('button', { name: 'Previous track', exact: true }).click();
      await page.waitForFunction(
        () => window.musicTest.engine.store.getState().activeId === 'track-1',
      );
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.getByRole('button', { name: 'Second line', exact: true }).click();
      await page.getByRole('combobox', { name: 'Repeat mode', exact: true }).selectOption('list');
      await page.getByRole('button', { name: 'Shuffle', exact: true }).click();
      await page.getByRole('slider', { name: 'Volume', exact: true }).press('Home');
      expect(
        await page.evaluate(() => ({
          repeat: window.musicTest.engine.store.getState().repeat,
          shuffle: window.musicTest.engine.store.getState().shuffle,
          volume: window.musicTest.audio!.volume,
        })),
      ).toEqual({ repeat: 'list', shuffle: true, volume: 0 });
      // A wide sidebar can leave a narrow workspace even on a desktop-sized viewport.
      await page.evaluate(() => {
        document.querySelector('main')!.style.maxWidth = '288px';
      });
      await page.getByRole('tab', { name: music.queue, exact: true }).click();
      expect(
        await page.evaluate(() => {
          const main = document.querySelector('main')!;
          return main.scrollWidth <= main.clientWidth;
        }),
      ).toBe(true);
      await page.getByRole('tab', { name: music.plugins, exact: true }).click();
      expect(
        await page.evaluate(() => {
          const main = document.querySelector('main')!;
          return main.scrollWidth <= main.clientWidth;
        }),
      ).toBe(true);
      await page.evaluate(() => {
        document.querySelector('main')!.style.maxWidth = '';
      });
      await page.getByRole('tab', { name: music.nowPlaying, exact: true }).click();
      await mkdir('.data/music-m2-validation', { recursive: true });
      await page.screenshot({ fullPage: true, path: '.data/music-m2-validation/desktop.png' });
      await page.setViewportSize({ width: 390, height: 850 });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await page.screenshot({ fullPage: true, path: '.data/music-m2-validation/compact.png' });
      expect(
        await page.evaluate(() =>
          [...document.querySelectorAll('[role="tab"]')].every((tab) => {
            const rect = tab.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= window.innerWidth;
          }),
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.locator('[data-capsule-body]').press('ArrowLeft');
      const beforeRefresh = await capsuleBounds();
      await page.evaluate(() => window.musicTest.engine.flush());
      await page.getByRole('tab', { name: music.plugins, exact: true }).click();
      await page.getByRole('switch', { name: music.lyricsPlugin, exact: true }).click();
      await page.waitForFunction(
        () => window.musicTest.plugins.store.getState().status === 'disabled',
      );
      await page.screenshot({
        fullPage: true,
        path: '.data/music-m2-validation/plugins-mobile.png',
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.reload();
      await page.waitForFunction(
        () => window.musicTest?.engine.store.getState().status === 'paused',
      );
      expect(await capsuleBounds()).toEqual(beforeRefresh);
      expect(
        await page.evaluate(() => ({
          count: window.musicTest.audioCount,
          queue: window.musicTest.engine.store.getState().queue.length,
          position: window.musicTest.engine.store.getState().positionMs,
        })),
      ).toEqual({ count: 0, queue: 2, position: 2000 });
      expect(await page.evaluate(() => window.musicTest.plugins.store.getState().enabled)).toBe(
        false,
      );
      await page.getByRole('button', { name: music.enableLyricsPlugin, exact: true }).click();
      await page.waitForFunction(
        () => window.musicTest.plugins.store.getState().status === 'active',
      );
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.waitForFunction(
        () => window.musicTest.engine.store.getState().status === 'playing',
      );
      await page.evaluate(() => window.musicTest.audio!.pause());
      await page.waitForFunction(
        () => window.musicTest.engine.store.getState().status === 'paused',
      );
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.waitForFunction(
        () => window.musicTest.engine.store.getState().status === 'playing',
      );
      // Online songs obtain timed lyrics through the actual command/client/Cordis path.
      // The fake catalog keeps this correctness test independent of upstream availability.
      await page.getByRole('tab', { name: music.library, exact: true }).click();
      await page.getByRole('button', { name: music.kugou, exact: true }).click();
      await page.getByRole('searchbox', { name: music.searchKugou, exact: true }).fill('automatic');
      await page.getByRole('button', { name: 'Play Online preview', exact: true }).click();
      await page.waitForFunction(() => {
        const view = window.musicTest.plugins.store.getState().lyrics;
        return (
          window.musicTest.engine.store.getState().status === 'playing' &&
          view?.status === 'ready' &&
          view.lines.length === 2
        );
      });
      expect(lyricRequests).toBe(1);
      expect(
        await page.evaluate(() => ({
          count: window.musicTest.audioCount,
          offset: window.musicTest.engine.store.getState().offsetMs,
          duration: window.musicTest.engine.store.getState().durationMs,
          lines: window.musicTest.plugins.store.getState().lyrics?.lines,
          manualImport: [...document.querySelectorAll('button')].some(
            (button) => button.textContent === 'Import LRC',
          ),
        })),
      ).toEqual({
        count: 1,
        offset: 10000,
        duration: 20000,
        manualImport: false,
        lines: [
          { text: 'Clip begins', timeMs: 0 },
          { text: 'Inside online clip', timeMs: 2000 },
        ],
      });
      await page.getByRole('button', { name: 'Inside online clip', exact: true }).click();
      expect(
        await page.evaluate(() => Math.abs(window.musicTest.audio!.currentTime - 2) < 0.75),
      ).toBe(true);

      // Personal collections use the signed-in account API, then the same player and Cordis host.
      await page.getByRole('tab', { name: music.library, exact: true }).click();
      await page.getByRole('button', { name: music.kugouLiked, exact: true }).click();
      await page.waitForFunction(
        () => !!document.querySelector('ul[aria-label="Liked songs fixture"] li'),
      );
      const libraryDomRows = await page.evaluate(
        () => document.querySelectorAll('ul[aria-label="Liked songs fixture"] li').length,
      );
      expect(libraryDomRows).toBeGreaterThan(0);
      expect(libraryDomRows).toBeLessThan(40);
      const resolvesBeforePlaylist = resolvedTracks.length;
      await page.getByRole('button', { name: music.playAll, exact: true }).click();
      await page.waitForFunction(() => {
        const state = window.musicTest.engine.store.getState();
        const lyrics = window.musicTest.plugins.store.getState().lyrics;
        return (
          state.activeId === 'liked-fixture' &&
          state.status === 'playing' &&
          lyrics?.status === 'ready' &&
          lyrics.lines[0]?.text === 'Bright river flows'
        );
      });
      expect(lyricRequests).toBe(2);
      expect(resolvedTracks.slice(resolvesBeforePlaylist)).toEqual(['liked-fixture']);
      expect([
        ...new Set(
          libraryRequests
            .filter((request) => request.playlistId === '101')
            .map((request) => request.page),
        ),
      ]).toEqual([1]);
      expect(
        await page.evaluate(() => ({
          total: window.musicTest.engine.store.getState().playlist?.total,
          loaded: window.musicTest.engine.store.getState().queue.length,
          count: window.musicTest.audioCount,
        })),
      ).toEqual({ total: 669, loaded: 100, count: 1 });
      await page.getByRole('tab', { name: music.queue, exact: true }).click();
      await page.waitForFunction(
        () => !!document.querySelector('ul[aria-label="Queue"] li[aria-setsize="669"]'),
      );
      const queueDomRows = await page.evaluate(
        () => document.querySelectorAll('ul[aria-label="Queue"] li').length,
      );
      expect(queueDomRows).toBeLessThan(40);
      expect(
        await page.evaluate(() => document.body.textContent?.includes('100 loaded · 669 songs')),
      ).toBe(true);
      await page.getByRole('tab', { name: music.nowPlaying, exact: true }).click();
      // The animation follows the real media clock, including pause and backward seek.
      await page.evaluate(() => window.musicTest.engine.seek(1700));
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-lyric-line="0"] [data-lyric-word="1"]')
            ?.getAttribute('data-state') === 'current',
      );
      const wordFrames = await page.evaluate(async () => {
        const frames: { audio: number; progress: number; interval: number }[] = [];
        let previous = performance.now();
        for (let index = 0; index < 24; index++) {
          await new Promise(requestAnimationFrame);
          const now = performance.now();
          const word = document.querySelector<HTMLElement>(
            '[data-lyric-line="0"] [data-lyric-word="1"]',
          )!;
          frames.push({
            audio: window.musicTest.audio!.currentTime,
            progress: Number.parseFloat(word.style.getPropertyValue('--lyric-progress')),
            interval: now - previous,
          });
          previous = now;
        }
        return frames;
      });
      expect(wordFrames.at(-1)!.audio).toBeGreaterThan(wordFrames[0].audio);
      expect(wordFrames.at(-1)!.progress).toBeGreaterThan(wordFrames[0].progress);
      for (const frame of wordFrames) {
        const expectedProgress = Math.min(
          100,
          Math.max(0, ((frame.audio * 1000 - 1600) / 1200) * 100),
        );
        expect(Math.abs(frame.progress - expectedProgress)).toBeLessThan(15);
      }
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.evaluate(() => window.musicTest.engine.seek(2200));
      await page.waitForFunction(() => {
        const word = document.querySelector<HTMLElement>(
          '[data-lyric-line="0"] [data-lyric-word="1"]',
        );
        return (
          !!word &&
          Math.abs(Number.parseFloat(word.style.getPropertyValue('--lyric-progress')) - 50) < 2
        );
      });
      const pausedFrames = await page.evaluate(async () => {
        const word = document.querySelector<HTMLElement>(
          '[data-lyric-line="0"] [data-lyric-word="1"]',
        )!;
        const before = {
          time: window.musicTest.audio!.currentTime,
          progress: word.style.getPropertyValue('--lyric-progress'),
        };
        for (let index = 0; index < 8; index++) await new Promise(requestAnimationFrame);
        return {
          before,
          after: {
            time: window.musicTest.audio!.currentTime,
            progress: word.style.getPropertyValue('--lyric-progress'),
          },
        };
      });
      expect(pausedFrames.after).toEqual(pausedFrames.before);
      await page.evaluate(() => window.musicTest.engine.seek(1100));
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-lyric-line="0"] [data-lyric-word="0"]')
            ?.getAttribute('data-state') === 'current',
      );
      expect(
        await page
          .locator('[data-lyric-line="0"] [data-lyric-word="1"]')
          .getAttribute('data-state'),
      ).toBe('future');
      const scrollFrames = await page.evaluate(async () => {
        const container = document.querySelector<HTMLElement>('[aria-label="Lyrics"]')!;
        const positions = [container.scrollTop];
        window.musicTest.engine.seek(15400);
        for (let index = 0; index < 40; index++) {
          await new Promise(requestAnimationFrame);
          positions.push(container.scrollTop);
        }
        return positions;
      });
      expect(scrollFrames.at(-1)!).toBeGreaterThan(scrollFrames[0] + 100);
      expect(new Set(scrollFrames.map(Math.round)).size).toBeGreaterThan(5);
      await page.waitForFunction(
        () =>
          document.querySelector('[data-lyric-line="20"]')?.getAttribute('aria-current') === 'true',
      );
      // Measure a real control input-to-next-frame while audio and word animation run.
      await page.evaluate(() => {
        window.musicTest.engine.seek(1700);
        const volume = document.querySelector('input[aria-label="Volume"]')!;
        volume.addEventListener(
          'input',
          () => {
            const start = performance.now();
            requestAnimationFrame(() => {
              window.musicTest.inputLatencyMs = performance.now() - start;
            });
          },
          { once: true },
        );
      });
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.getByRole('slider', { name: 'Volume', exact: true }).press('ArrowRight');
      await page.waitForFunction(() => typeof window.musicTest.inputLatencyMs === 'number');
      await writeFile(
        '.data/music-m2-validation/word-lyrics-browser.json',
        JSON.stringify(
          {
            libraryTotal: 669,
            loadedMetadata: 100,
            libraryDomRows,
            queueDomRows,
            frameIntervalsMs: wordFrames.map((frame) => frame.interval),
            audioAdvancedMs: (wordFrames.at(-1)!.audio - wordFrames[0].audio) * 1000,
            inputLatencyMs: await page.evaluate(() => window.musicTest.inputLatencyMs),
            smoothScrollPositions: scrollFrames,
            audioInstances: await page.evaluate(() => window.musicTest.audioCount),
          },
          null,
          2,
        ),
      );
      await page.getByRole('tab', { name: music.library, exact: true }).click();
      await page.getByRole('button', { name: music.kugouCollectedPlaylists, exact: true }).click();
      await page.getByRole('button', { name: 'Collected playlist fixture', exact: true }).click();
      await page
        .getByRole('button', { name: 'Add to queue Collected fixture', exact: true })
        .click();
      expect(
        await page.evaluate(() => {
          const state = window.musicTest.engine.store.getState();
          return {
            activeId: state.activeId,
            queued: state.playlist?.appendedCount === 1,
            playing: !window.musicTest.audio!.paused,
            count: window.musicTest.audioCount,
          };
        }),
      ).toEqual({ activeId: 'liked-fixture', queued: true, playing: true, count: 1 });
      expect(lyricRequests).toBe(2);
      await page.getByRole('button', { name: music.playAll, exact: true }).click();
      await page.waitForFunction(() => {
        const state = window.musicTest.engine.store.getState();
        const lyrics = window.musicTest.plugins.store.getState().lyrics;
        return (
          state.activeId === 'collected-fixture' &&
          state.status === 'playing' &&
          lyrics?.status === 'ready' &&
          lyrics.lines[0]?.text === 'Collected fixture lyric'
        );
      });
      expect(lyricRequests).toBe(3);
      expect(await page.evaluate(() => window.musicTest.audioCount)).toBe(1);
      expect(
        await page.evaluate(() =>
          window.musicTest.engine.store.getState().queue.map((track) => track.id),
        ),
      ).toEqual(['collected-fixture']);
      expect(libraryRequests).toEqual(
        expect.arrayContaining([
          { operation: 'library' },
          { operation: 'playlist', playlistId: '101', page: 1 },
          { operation: 'playlist', playlistId: '102', page: 1 },
        ]),
      );
      // Crossing the loaded page fetches metadata once, then resolves only the chosen songs.
      await page.getByRole('tab', { name: music.library, exact: true }).click();
      await page.getByRole('button', { name: music.kugouLiked, exact: true }).click();
      await page.getByRole('button', { name: music.playAll, exact: true }).click();
      await page.waitForFunction(
        () =>
          window.musicTest.engine.store.getState().activeId === 'liked-fixture' &&
          window.musicTest.engine.store.getState().status === 'playing',
      );
      const beforeBoundary = resolvedTracks.length;
      await page.evaluate(() => {
        window.musicTest.engine.setShuffle(false);
        window.musicTest.engine.playQueuedTrack('liked-fixture-100');
      });
      await page.waitForFunction(() => {
        const state = window.musicTest.engine.store.getState();
        return (
          state.activeId === 'liked-fixture-100' &&
          state.status === 'playing' &&
          state.queue.length === 200
        );
      });
      await page.getByRole('button', { name: 'Next track', exact: true }).click();
      await page.waitForFunction(() => {
        const state = window.musicTest.engine.store.getState();
        return (
          state.activeId === 'liked-fixture-101' &&
          state.status === 'playing' &&
          state.playlist?.currentIndex === 100
        );
      });
      expect(resolvedTracks.slice(beforeBoundary)).toEqual([
        'liked-fixture-100',
        'liked-fixture-101',
      ]);
      expect(
        libraryRequests.filter((request) => request.playlistId === '101' && request.page === 2),
      ).toHaveLength(1);
      expect(libraryRequests.some((request) => (request.page ?? 1) > 2)).toBe(false);
      expect(
        await page.evaluate(() => ({
          total: window.musicTest.engine.store.getState().playlist?.total,
          loaded: window.musicTest.engine.store.getState().queue.length,
          count: window.musicTest.audioCount,
        })),
      ).toEqual({ total: 669, loaded: 200, count: 1 });
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      expect(
        await page.evaluate(() => ({
          paused: window.musicTest.audio!.paused,
          queue: window.musicTest.engine.store.getState().queue.length,
          src: window.musicTest.audio!.getAttribute('src'),
        })),
      ).toEqual({ paused: true, queue: 0, src: null });
      expect(await page.evaluate(() => window.musicTest.plugins.store.getState())).toMatchObject({
        userId: null,
        status: 'disabled',
        lyrics: null,
      });
      await page.waitForFunction(() => !document.querySelector('[data-capsule-body]'));
      const signedOutGlass = await glassCanvases();
      expect(signedOutGlass.count).toBeLessThanOrEqual(8);
      expect(signedOutGlass.owners).toBe(signedOutGlass.count);
      expect(signedOutGlass.valid).toBe(true);
      expect(errors).toEqual([]);
    } catch (error) {
      await mkdir('.data/music-m2-validation', { recursive: true });
      await page?.screenshot({ fullPage: true, path: '.data/music-m2-validation/failure.png' });
      const body = await page?.evaluate(() => document.body.innerText.slice(0, 2000));
      const glass = await page?.evaluate(() => ({
        contrast: matchMedia('(prefers-contrast: more)').matches,
        reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
        hidden: document.hidden,
        scene: { ...document.querySelector<HTMLElement>('[data-qz-glass-scene]')?.dataset },
        surfaces: [...document.querySelectorAll<HTMLElement>('[data-qz-glass]')].map((element) => ({
          kind: element.dataset.qzGlass,
          renderer: element.dataset.qzRenderer,
          canvas: element.querySelectorAll(':scope > canvas').length,
          bounds: element.getBoundingClientRect().toJSON(),
        })),
      }));
      throw new Error(
        `${(error as Error).message}\nGlass: ${JSON.stringify(glass)}\nBrowser: ${JSON.stringify(errors)}\nUploads: ${counter}, rows: ${rows.size}\nHTTP: ${requests.join('\n')}\n${body}`,
        { cause: error },
      );
    } finally {
      await browser?.close();
      await server.close();
      await host.dispose();
    }
  },
  120_000,
);
