// @vitest-environment node
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { createServer } from 'vite';
import { expect, it } from 'vitest';

import type {} from '../../../tests/fixtures/qingzhouBrand';

interface Page {
  emulateMedia: (options: { reducedMotion: 'reduce' | 'no-preference' }) => Promise<void>;
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
  goto: (url: string) => Promise<unknown>;
  on: (event: 'pageerror', callback: (error: Error) => void) => void;
  screenshot: (options: { path: string }) => Promise<Buffer>;
  setViewportSize: (size: { height: number; width: number }) => Promise<void>;
  waitForFunction: (fn: () => boolean) => Promise<unknown>;
}

it.runIf(process.env.MUSIC_BROWSER_EXECUTABLE)(
  'loads celadon assets, keeps rotating cabins upright and respects reduced motion',
  async () => {
    const server = await createServer({
      cacheDir: '.data/qingzhou-celadon/vite',
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
        include: [
          'antd-style',
          'react',
          'react/jsx-runtime',
          'react/jsx-dev-runtime',
          'react-dom/client',
        ],
      },
      plugins: [
        {
          name: 'qingzhou-brand-preview',
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url !== '/brand-preview') return next();
              res.setHeader('Content-Type', 'text/html');
              res.end(
                '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script type="module" src="/tests/fixtures/qingzhouBrand.tsx"></script></body></html>',
              );
            });
          },
        },
      ],
      resolve: { alias: { '@': path.resolve('src') } },
      server: { host: '127.0.0.1', port: 0, preTransformRequests: false },
    });
    const require = createRequire(new URL('../../../e2e/package.json', import.meta.url));
    const { chromium } = require('playwright') as {
      chromium: {
        launch: (options: {
          executablePath: string;
          headless: boolean;
          args: string[];
        }) => Promise<{
          close: () => Promise<void>;
          newPage: (options: {
            viewport: { height: number; width: number };
            deviceScaleFactor: number;
          }) => Promise<Page>;
        }>;
      };
    };
    const errors: string[] = [];
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let page: Page | undefined;
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing brand preview address.');
      browser = await chromium.launch({
        args: ['--enable-unsafe-swiftshader'],
        executablePath: process.env.MUSIC_BROWSER_EXECUTABLE!,
        headless: true,
      });
      page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 2,
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}/brand-preview`);
      await page.waitForFunction(
        () =>
          !!window.brandPreview &&
          Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
      );
      await page.waitForFunction(
        () =>
          document.querySelector('[data-qz-glass="composer"]')?.getAttribute('data-qz-renderer') ===
          'webgl2',
      );
      const initial = await page.evaluate(() => {
        const rotor = document.querySelector<HTMLElement>('[data-qz-wheel="rotor"]')!;
        rotor
          .closest<HTMLElement>('[data-qz-ferris]')!
          .style.setProperty('--qz-wheel-duration', '4s');
        return getComputedStyle(rotor).transform;
      });
      await page.waitForFunction(() => {
        const rotor = document.querySelector<HTMLElement>('[data-qz-wheel="rotor"]')!;
        return Math.abs(new DOMMatrixReadOnly(getComputedStyle(rotor).transform).b) > 0.3;
      });
      const orientation = await page.evaluate(() => {
        const rotor = document.querySelector<HTMLElement>('[data-qz-wheel="rotor"]')!;
        const rotation = new DOMMatrixReadOnly(getComputedStyle(rotor).transform);
        return {
          moved: getComputedStyle(rotor).transform,
          angles: Array.from(document.querySelectorAll<HTMLElement>('[data-qz-wheel="cabin"]')).map(
            (cabin) => {
              const combined = rotation.multiply(
                new DOMMatrixReadOnly(getComputedStyle(cabin).transform),
              );
              return Math.atan2(combined.b, combined.a);
            },
          ),
        };
      });
      expect(orientation.moved).not.toBe(initial);
      expect(orientation.angles).toHaveLength(8);
      for (const angle of orientation.angles) expect(Math.abs(angle)).toBeLessThan(0.01);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForFunction(
        () => document.querySelector('[data-qz-ferris]')?.getAttribute('data-moving') === 'false',
      );
      const paused = await page.evaluate(
        () => getComputedStyle(document.querySelector('[data-qz-wheel="rotor"]')!).animationName,
      );
      expect(paused).toBe('none');
      await mkdir('.data/qingzhou-celadon', { recursive: true });
      await page.screenshot({ path: '.data/qingzhou-celadon/dark.png' });
      await page.evaluate(() => {
        document.body.dataset.theme = 'light';
      });
      await page.waitForFunction(
        () =>
          document.querySelector('[data-qz-glass-scene]')?.getAttribute('data-qz-glass-status') ===
          'ready',
      );
      await page.screenshot({ path: '.data/qingzhou-celadon/light.png' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => innerWidth === 390);
      const layout = await page.evaluate(() => {
        const field = document.querySelector('textarea')!.getBoundingClientRect();
        const leaf = document.querySelector('[data-qz-leaf]')!.getBoundingClientRect();
        return {
          page: document.documentElement.scrollWidth,
          leafBottom: leaf.bottom,
          inputTop: field.top,
        };
      });
      expect(layout.page).toBeLessThanOrEqual(390);
      expect(layout.leafBottom).toBeLessThan(layout.inputTop);
      await page.screenshot({ path: '.data/qingzhou-celadon/mobile.png' });
      await page.evaluate(() => window.brandPreview.cleanup());
      expect(errors).toEqual([]);
    } catch (error) {
      console.error(
        'Brand preview errors',
        errors,
        await page?.evaluate(() => ({
          ready: !!window.brandPreview,
          images: Array.from(document.images).map((img) => [
            img.src,
            img.complete,
            img.naturalWidth,
          ]),
          scene: document.querySelector('[data-qz-glass-scene]')?.outerHTML.slice(0, 500),
        })),
      );
      throw error;
    } finally {
      await browser?.close();
      await server.close();
    }
  },
  90_000,
);
