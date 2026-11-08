// @vitest-environment node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { createServer } from 'vite';
import { expect, it } from 'vitest';

import type {} from '../../../../tests/fixtures/glassPerformance';

interface Page {
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
  goto: (url: string) => Promise<unknown>;
  keyboard: { type: (text: string, options: { delay: number }) => Promise<void> };
  locator: (selector: string) => { focus: () => Promise<void> };
  on: (event: 'pageerror', callback: (error: Error) => void) => void;
  screenshot: (options: { path: string }) => Promise<Buffer>;
  waitForFunction: (fn: () => boolean) => Promise<unknown>;
}

/**
 * Opt-in benchmark, independent from correctness suites. Report measured timings;
 * never equate a CI/software GPU result with a guaranteed user-visible 60 fps.
 */
it.runIf(
  process.env.GLASS_PERF && process.env.MUSIC_BROWSER_EXECUTABLE && process.env.MUSIC_TEST_MP3,
)(
  'measures actual glass draws, input response and native music during continuous motion',
  async () => {
    const baseline = process.env.GLASS_PERF_BASELINE === '1';
    const label = (
      process.env.GLASS_PERF_LABEL ?? (baseline ? 'baseline' : 'optimized')
    ).replaceAll(/[^\w-]/g, '-');
    const root = path.resolve('.data/glass-performance');
    const bytes = await readFile(process.env.MUSIC_TEST_MP3!);
    const server = await createServer({
      cacheDir: '.data/glass-performance/vite',
      configFile: false,
      define: {
        'process.env': '{}',
        '__DEV__': 'true',
        '__TEST__': 'true',
        '__ELECTRON__': 'false',
        '__MOBILE__': 'false',
      },
      envFile: false,
      logLevel: 'error',
      optimizeDeps: {
        entries: [],
        noDiscovery: true,
        include: ['antd-style', 'react', 'react-dom', 'zustand/vanilla', 'js-sha256', 'zod'],
      },
      plugins: [
        {
          name: 'glass-performance-fixture',
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              const pathname = req.url?.split('?')[0];
              if (pathname === '/glass-performance') {
                res.setHeader('Content-Type', 'text/html');
                res.end(
                  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script type="module" src="/tests/fixtures/glassPerformance.tsx"></script></body></html>',
                );
              } else if (pathname === '/api/runtime/music/tracks/performance/stream') {
                res.setHeader('Content-Type', 'audio/mpeg');
                res.setHeader('Content-Length', bytes.length);
                res.end(bytes);
              } else next();
            });
          },
        },
      ],
      resolve: {
        alias: [
          ...(baseline
            ? [
                {
                  find: /^@\/features\/LiquidGlass\/(.*)$/,
                  replacement: path.join(root, 'baseline/src/features/LiquidGlass/$1'),
                },
              ]
            : []),
          { find: '@', replacement: path.resolve('src') },
        ],
      },
      root: process.cwd(),
      server: { host: '127.0.0.1', port: 0, preTransformRequests: false },
    });
    const require = createRequire(new URL('../../../../e2e/package.json', import.meta.url));
    const { chromium } = require('playwright') as {
      chromium: {
        launch: (options: {
          args: string[];
          executablePath: string;
          headless: boolean;
        }) => Promise<{
          close: () => Promise<void>;
          newPage: (options: { viewport: { height: number; width: number } }) => Promise<Page>;
        }>;
      };
    };
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const errors: string[] = [];
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === 'string')
        throw new Error('No performance fixture address');
      browser = await chromium.launch({
        args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
        executablePath: process.env.MUSIC_BROWSER_EXECUTABLE!,
        headless: true,
      });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}/glass-performance`);
      await page.waitForFunction(() => !!window.glassPerformance?.ready());
      await page.evaluate(() => window.glassPerformance.startAudio());
      await page.waitForFunction(() => window.glassPerformance.isPlaying());
      const drag = await page.evaluate(() => window.glassPerformance.run());
      await page.waitForFunction(() => window.glassPerformance.ready());
      await page.locator('textarea').focus();
      const typing = page.evaluate(() => window.glassPerformance.run());
      const text = 'typing stays responsive while glass moves';
      await page.keyboard.type(text, { delay: 70 });
      const concurrent = await typing;
      const topology = baseline
        ? undefined
        : await page.evaluate(() => window.glassPerformance.verifyTopologyContinuity());
      const sourceMotion = baseline
        ? undefined
        : await page.evaluate(() => window.glassPerformance.verifySourceMotion());
      const wallpaper = baseline
        ? undefined
        : await page.evaluate(() => window.glassPerformance.verifyWallpaperSource());
      await mkdir(root, { recursive: true });
      const report = {
        baseline,
        concurrent,
        drag,
        label,
        sourceMotion,
        topology,
        wallpaper,
        note: 'Headless Chrome benchmark. Actual glass draw submissions/copies are counted; FPS is diagnostic, not a cross-device guarantee.',
        timestamp: new Date().toISOString(),
      };
      await writeFile(path.join(root, `${label}.json`), JSON.stringify(report, null, 2));
      await page.screenshot({ path: path.join(root, `${label}.png`) });
      for (const phase of [drag, concurrent]) {
        expect(phase.capsuleFps).toBeGreaterThan(0);
        expect(phase.audioCount).toBe(1);
        expect(phase.audioPaused).toBe(false);
        expect(phase.audioAdvance).toBeGreaterThan((phase.duration / 1000) * 0.75);
        expect(phase.audioWaiting).toBe(0);
        expect(phase.canvasCount).toBeLessThanOrEqual(8);
      }
      expect(concurrent.inputEvents).toBeGreaterThan(0);
      expect(concurrent.inputText).toBe(text);
      expect(
        Object.values(concurrent.sourceUploads).reduce((sum, count) => sum + count, 0),
      ).toBeGreaterThan(0);
      if (sourceMotion) {
        expect(sourceMotion.audioPaused).toBe(true);
        expect(sourceMotion.uploadIncrease).toBeGreaterThan(0);
        expect(sourceMotion.after).not.toBe(sourceMotion.before);
      }
      if (topology) {
        expect(topology.samples).toBeGreaterThan(5);
        expect(topology.interruptions).toEqual([]);
        expect(topology.panelAdded).toBe(true);
        expect(topology.panelRemoved).toBe(true);
        expect(topology.finalCanvasCount).toBe(topology.initialCanvasCount);
        expect(topology.audioCount).toBe(1);
        expect(topology.audioPaused).toBe(false);
        expect(topology.audioAdvance).toBeGreaterThan((topology.duration / 1000) * 0.5);
      }
      if (wallpaper) {
        expect(wallpaper.audioPaused).toBe(true);
        expect(wallpaper.uploadIncrease).toBeGreaterThan(0);
        expect(wallpaper.after).not.toBe(wallpaper.before);
      }
      expect(await page.evaluate(() => window.glassPerformance.cleanup())).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await server.close();
    }
  },
  90_000,
);
