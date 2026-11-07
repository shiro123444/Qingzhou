// @vitest-environment node
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import { expect, it } from 'vitest';

import { type MusicFile } from '@/server/runtime/music/contracts';
import { handleMusicCommand, handleMusicStream } from '@/server/runtime/music/handler';
import { musicByteRange, OwnedFileMusicProvider } from '@/server/runtime/music/owned-file-provider';
import { createMusicRuntime } from '@/server/runtime/music/runtime';

import { type AudioEngine } from './engine';

// Playwright is an existing e2e workspace dependency. Keep it out of the production bundle.
interface Locator {
  click: () => Promise<void>;
  fill: (value: string) => Promise<void>;
  getAttribute: (name: string) => Promise<string | null>;
  press: (key: string) => Promise<void>;
  selectOption: (value: string) => Promise<unknown>;
  setInputFiles: (file: { buffer: Buffer; mimeType: string; name: string }) => Promise<void>;
}
interface BrowserPage {
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
  getByRole: (role: string, options: { exact?: boolean; name: string }) => Locator;
  goto: (url: string, options: { waitUntil: 'commit' }) => Promise<unknown>;
  locator: (selector: string) => Locator;
  on: (event: 'pageerror', handler: (error: Error) => void) => void;
  reload: () => Promise<unknown>;
  screenshot: (options: { fullPage: boolean; path: string }) => Promise<unknown>;
  setViewportSize: (size: { height: number; width: number }) => Promise<void>;
  waitForFunction: (
    fn: () => boolean,
    arg?: undefined,
    options?: { timeout: number },
  ) => Promise<unknown>;
}
declare global {
  interface Window {
    musicTest: { audio?: HTMLAudioElement; audioCount: number; engine: AudioEngine };
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
    const provider = new OwnedFileMusicProvider(
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
                !['/music', '/chat', '/presentation'].includes(pathname) &&
                !pathname.startsWith('/fixture/') &&
                !pathname.startsWith('/api/runtime/music')
              )
                return next();
              void (async () => {
                if (['/music', '/chat', '/presentation'].includes(pathname)) {
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
        args: ['--autoplay-policy=no-user-gesture-required'],
      });
      page = await browser.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}/music`, { waitUntil: 'commit' });
      await page.waitForFunction(
        () => !!window.musicTest?.engine.store.getState().userId,
        undefined,
        { timeout: 60_000 },
      );
      await page
        .locator('input[type=file][accept="audio/*"]')
        .setInputFiles({ buffer: bytes, mimeType: 'audio/mpeg', name: 'Rain.mp3' });
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Your audio"]')?.textContent?.includes('Rain.mp3') ===
          true,
      );
      await page.getByRole('button', { name: 'Play Rain.mp3', exact: true }).click();
      await page.waitForFunction(
        () => window.musicTest.engine.store.getState().status === 'playing',
      );
      expect(await page.evaluate(() => window.musicTest.audio!.duration)).toBeGreaterThan(7.9);
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
      await page.getByRole('link', { name: 'Chat', exact: true }).click();
      await page.getByRole('link', { name: 'Presentation', exact: true }).click();
      await page.getByRole('link', { name: 'Music', exact: true }).click();
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
            .querySelector('ul[aria-label="Your audio"]')
            ?.textContent?.includes('Wind.mp3') === true,
      );
      await page.getByRole('searchbox', { name: 'Search audio by name', exact: true }).fill('Wind');
      await page.waitForFunction(() => {
        const list = document.querySelector('ul[aria-label="Your audio"]');
        return (
          list?.textContent?.includes('Wind.mp3') === true && !list.textContent.includes('Rain.mp3')
        );
      });
      await page.getByRole('searchbox', { name: 'Search audio by name', exact: true }).fill('');
      await page.waitForFunction(
        () =>
          document
            .querySelector('ul[aria-label="Your audio"]')
            ?.textContent?.includes('Rain.mp3') === true,
      );
      await page.getByRole('button', { name: 'Add to queue Wind.mp3', exact: true }).click();
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
      await mkdir('.data/music-m2-validation', { recursive: true });
      await page.screenshot({ fullPage: true, path: '.data/music-m2-validation/desktop.png' });
      await page.setViewportSize({ width: 760, height: 900 });
      await page.screenshot({ fullPage: true, path: '.data/music-m2-validation/compact.png' });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.evaluate(() => window.musicTest.engine.flush());
      await page.reload();
      await page.waitForFunction(
        () => window.musicTest?.engine.store.getState().status === 'paused',
      );
      expect(
        await page.evaluate(() => ({
          count: window.musicTest.audioCount,
          queue: window.musicTest.engine.store.getState().queue.length,
          position: window.musicTest.engine.store.getState().positionMs,
        })),
      ).toEqual({ count: 0, queue: 2, position: 2000 });
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
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      expect(
        await page.evaluate(() => ({
          paused: window.musicTest.audio!.paused,
          queue: window.musicTest.engine.store.getState().queue.length,
          src: window.musicTest.audio!.getAttribute('src'),
        })),
      ).toEqual({ paused: true, queue: 0, src: null });
      expect(errors).toEqual([]);
    } catch (error) {
      await mkdir('.data/music-m2-validation', { recursive: true });
      await page?.screenshot({ fullPage: true, path: '.data/music-m2-validation/failure.png' });
      const body = await page?.evaluate(() => document.body.innerText.slice(0, 2000));
      throw new Error(
        `${(error as Error).message}\nBrowser: ${JSON.stringify(errors)}\nUploads: ${counter}, rows: ${rows.size}\nHTTP: ${requests.join('\n')}\n${body}`,
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
