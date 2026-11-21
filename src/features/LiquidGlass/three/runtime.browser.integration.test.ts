// @vitest-environment node
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { createServer } from 'vite';
import { expect, it } from 'vitest';

import type {} from '../../../../tests/fixtures/glassPerformance';

interface BrowserPage {
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
  goto: (url: string) => Promise<unknown>;
  on: (event: 'pageerror', callback: (error: Error) => void) => void;
  screenshot: (options: { path: string }) => Promise<Buffer>;
  waitForFunction: (fn: () => boolean) => Promise<unknown>;
}

it.runIf(process.env.MUSIC_BROWSER_EXECUTABLE)(
  'aligns full-resolution panes to the border box, draws once at rest and restores fallback styles',
  async () => {
    const server = await createServer({
      cacheDir: '.data/glass-visual/vite',
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
          name: 'glass-visual-fixture',
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url !== '/glass-visual') return next();
              res.setHeader('Content-Type', 'text/html');
              res.end(
                '<!doctype html><html><body><script type="module" src="/tests/fixtures/glassPerformance.tsx"></script></body></html>',
              );
            });
          },
        },
      ],
      resolve: { alias: { '@': path.resolve('src') } },
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
          newPage: (options: {
            viewport: { height: number; width: number };
            deviceScaleFactor: number;
          }) => Promise<BrowserPage>;
        }>;
      };
    };
    const errors: string[] = [];
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === 'string') throw new Error('Missing glass visual address.');
      browser = await chromium.launch({
        args: ['--enable-unsafe-swiftshader'],
        executablePath: process.env.MUSIC_BROWSER_EXECUTABLE!,
        headless: true,
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 2,
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}/glass-visual`);
      await page.waitForFunction(() => !!window.glassPerformance?.ready());
      await page.evaluate(() => {
        const sidebar = document.querySelector<HTMLElement>('aside')!;
        sidebar.style.cssText +=
          'width:400px;height:900px;bottom:auto;border-width:1px 2px 3px 4px;box-shadow:inset 0 0 0 1px white';
        document.querySelector<HTMLElement>('main')!.style.left = '416px';
        document.querySelector<HTMLElement>('[data-qz-glass-scene]')!.style.backgroundImage =
          'repeating-linear-gradient(115deg,#b2c1ce 0px,#b2c1ce 2px,#dee5eb 2px,#dee5eb 48px)';
      });
      await page.waitForFunction(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('aside > [data-qz-glass-canvas]');
        return canvas?.width === 400 && canvas.height === 900;
      });
      const surfaces = await page.evaluate(() =>
        ['aside', '#composer', '#capsule'].map((selector) => {
          const element = document.querySelector<HTMLElement>(selector)!;
          const canvas = element.querySelector<HTMLCanvasElement>('[data-qz-glass-canvas]')!;
          const bounds = element.getBoundingClientRect();
          const output = canvas.getBoundingClientRect();
          const computed = getComputedStyle(element);
          return {
            selector,
            border: computed.borderTopColor,
            shadow: computed.boxShadow,
            offset: [
              output.x - bounds.x,
              output.y - bounds.y,
              output.width - bounds.width,
              output.height - bounds.height,
            ],
          };
        }),
      );
      for (const surface of surfaces) {
        expect(surface.border).toBe('rgba(0, 0, 0, 0)');
        expect(surface.shadow).toBe('none');
        for (const offset of surface.offset)
          expect(Math.abs(offset), JSON.stringify(surface)).toBeLessThan(0.05);
      }
      await mkdir('.data/glass-visual', { recursive: true });
      await page.screenshot({ path: '.data/glass-visual/light.png' });
      // A mutation-free wait checks actual GL submissions, including any accidental render loop.
      const idleDraws = await page.evaluate(async () => {
        const original = WebGL2RenderingContext.prototype.drawArrays;
        let count = 0;
        let lastDraw = performance.now();
        WebGL2RenderingContext.prototype.drawArrays = function (...args) {
          count++;
          lastDraw = performance.now();
          return original.apply(this, args);
        };
        const deadline = performance.now() + 5000;
        while (performance.now() - lastDraw < 100 && performance.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20));
        count = 0;
        await new Promise((resolve) => setTimeout(resolve, 250));
        WebGL2RenderingContext.prototype.drawArrays = original;
        return count;
      });
      expect(idleDraws).toBe(0);
      const interaction = await page.evaluate(() => window.glassPerformance.run(1000));
      expect(interaction.capsuleFps).toBeGreaterThan(0);
      await writeFile('.data/glass-visual/interaction.json', JSON.stringify(interaction, null, 2));
      await page.waitForFunction(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('aside > [data-qz-glass-canvas]');
        return canvas?.width === 400 && canvas.height === 900;
      });
      await page.evaluate(() => {
        const scene = document.querySelector<HTMLElement>('[data-qz-glass-scene]')!;
        scene.style.color = '#edf2f7';
        scene.style.backgroundImage =
          'repeating-linear-gradient(115deg,#344456 0px,#344456 2px,#131f2a 2px,#131f2a 48px)';
        scene.querySelectorAll<HTMLElement>('article p').forEach((card) => {
          card.style.background = '#ffffff08';
        });
        return new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      await page.waitForFunction(() => window.glassPerformance.ready());
      await page.screenshot({ path: '.data/glass-visual/dark.png' });
      expect(await page.evaluate(() => window.glassPerformance.cleanup())).toBe(0);
      const fallback = await page.evaluate(
        () => getComputedStyle(document.querySelector('aside')!).boxShadow,
      );
      expect(fallback).toContain('inset');
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await server.close();
    }
  },
  120_000,
);
