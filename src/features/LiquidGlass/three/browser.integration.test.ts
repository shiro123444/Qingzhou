// @vitest-environment node
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { createServer } from 'vite';
import { expect, it } from 'vitest';

import type {} from '../../../../tests/fixtures/glass3d';

interface BrowserPage {
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
  goto: (url: string) => Promise<unknown>;
  on: (event: 'pageerror', callback: (error: Error) => void) => void;
  screenshot: (options: { path: string }) => Promise<Buffer>;
  waitForFunction: (fn: () => boolean) => Promise<unknown>;
}

it.runIf(process.env.MUSIC_BROWSER_EXECUTABLE)(
  'traces real GPU glass against the CPU oracle, layered sources and context lifecycle',
  async () => {
    const server = await createServer({
      cacheDir: '.data/music-m2-validation/vite-glass3d',
      configFile: false,
      envFile: false,
      logLevel: 'error',
      optimizeDeps: { noDiscovery: true },
      plugins: [
        {
          name: 'glass3d-browser-fixture',
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url !== '/glass-3d') return next();
              res.setHeader('Content-Type', 'text/html');
              res.end(
                '<!doctype html><html><body><script type="module" src="/tests/fixtures/glass3d.tsx"></script></body></html>',
              );
            });
          },
        },
      ],
      resolve: { alias: { '@': path.resolve('src') } },
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
        }) => Promise<{ close: () => Promise<void>; newPage: () => Promise<BrowserPage> }>;
      };
    };
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const errors: string[] = [];
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing glass browser fixture address.');
      browser = await chromium.launch({
        args: ['--enable-unsafe-swiftshader'],
        executablePath: process.env.MUSIC_BROWSER_EXECUTABLE!,
        headless: true,
      });
      const page = await browser.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}/glass-3d`);
      await page.waitForFunction(() => !!window.glass3dTest);
      expect(await page.evaluate(() => window.glass3dTest.supported)).toBe(true);
      expect(await page.evaluate(() => window.glass3dTest.errors)).toEqual([]);
      expect(await page.evaluate(() => window.glass3dTest.pixel(0, 0)[3])).toBe(0);
      await mkdir('.data/music-m2-validation', { recursive: true });
      await page.screenshot({ path: '.data/music-m2-validation/glass-3d-double-grid.png' });

      const oracle = await page.evaluate(() => {
        const test = window.glass3dTest;
        const cases = [];
        for (const double of [false, true]) {
          test.render({ absorption: true, double, source: 'solid' });
          for (const [x, y] of [
            [160, 50],
            [70, 3],
            [160, 3],
            [230, 3],
            [20, 48],
            [300, 48],
            [90, 80],
          ]) {
            cases.push({
              actual: test.pixel(x, y),
              expected: test.oracle(x, y),
              point: [x, y],
              double,
            });
          }
        }
        return cases;
      });
      for (const sample of oracle) {
        expect(sample.actual[3], JSON.stringify(sample)).toBe(255);
        for (let channel = 0; channel < 3; channel++) {
          expect(
            Math.abs(sample.actual[channel] - sample.expected[channel]),
            JSON.stringify(sample),
          ).toBeLessThan(5);
        }
      }

      const environmentSamples = await page.evaluate(() => {
        const test = window.glass3dTest;
        test.render({ double: true, environmentOnly: true, absorption: true });
        return [
          [160, 50],
          [70, 3],
          [20, 48],
          [300, 48],
        ].map(([x, y]) => ({ actual: test.pixel(x, y), expected: test.oracle(x, y) }));
      });
      for (const sample of environmentSamples) {
        for (let channel = 0; channel < 3; channel++) {
          expect(
            Math.abs(sample.actual[channel] - sample.expected[channel]),
            JSON.stringify(sample),
          ).toBeLessThan(5);
        }
      }

      const layering = await page.evaluate(() => {
        const test = window.glass3dTest;
        test.render({ double: false });
        const single = test.frame();
        test.render({ double: true });
        const double = test.frame();
        let differences = 0;
        for (let index = 0; index < single.length; index += 4) {
          if (
            single[index + 3] &&
            Math.abs(single[index] - double[index]) +
              Math.abs(single[index + 1] - double[index + 1]) +
              Math.abs(single[index + 2] - double[index + 2]) >
              12
          )
            differences++;
        }
        return differences;
      });
      expect(layering).toBeGreaterThan(2000);

      const reflections = await page.evaluate(() => {
        const test = window.glass3dTest;
        test.render({ source: 'solid', upper: 'orange' });
        const orange = test.pixel(160, 50);
        test.render({ source: 'solid', upper: 'blue' });
        const blue = test.pixel(160, 50);
        return { blue, orange };
      });
      expect(reflections.orange[0] - reflections.blue[0]).toBeGreaterThan(10);
      expect(reflections.blue[2] - reflections.orange[2]).toBeGreaterThan(3);
      await page.screenshot({ path: '.data/music-m2-validation/glass-3d-upper-reflection.png' });

      const occlusion = await page.evaluate(() => {
        const test = window.glass3dTest;
        test.render({ double: true, source: 'solid' });
        const base = test.pixel(160, 50);
        test.render({ double: true, overlay: 'transparent', source: 'solid' });
        const transparent = test.pixel(160, 50);
        test.render({ double: true, overlay: 'opaque', source: 'solid' });
        const opaque = test.pixel(160, 50);
        test.render({ double: true, overlay: 'half', source: 'solid' });
        const half = test.pixel(160, 50);
        return { base, half, opaque, transparent };
      });
      expect(occlusion.transparent).toEqual(occlusion.base);
      expect(occlusion.opaque[1] - occlusion.base[1]).toBeGreaterThan(30);
      expect(occlusion.half[1]).toBeGreaterThan(occlusion.base[1]);
      expect(occlusion.half[1]).toBeLessThan(occlusion.opaque[1]);
      await page.screenshot({ path: '.data/music-m2-validation/glass-3d-alpha-plane.png' });

      const foreground = await page.evaluate(() => {
        const test = window.glass3dTest;
        test.render({ source: 'solid' });
        const base = test.frame();
        test.render({ ownForeground: true, source: 'solid' });
        return { base, own: test.frame() };
      });
      expect(foreground.own).toEqual(foreground.base);

      const prefilter = await page.evaluate(() => {
        const test = window.glass3dTest;
        const edgeEnergy = (frame: number[]) => {
          let total = 0;
          for (let x = 60; x < 260; x++) {
            const offset = (50 * 320 + x) * 4;
            for (let c = 0; c < 3; c++) total += (frame[offset + c] - frame[offset + 4 + c]) ** 2;
          }
          return total;
        };
        test.render({ source: 'grid' });
        const sharp = test.frame();
        test.render({ blur: 5, source: 'grid' });
        const softened = test.frame();
        const sameOutline = sharp.every(
          (value, index) => index % 4 !== 3 || value === softened[index],
        );
        test.render({ boundedSources: true, source: 'solid' });
        const bounded = test.frame();
        test.render({ blur: 12, boundedSources: true, source: 'solid' });
        const boundedSoft = test.frame();
        let solidDifference = 0;
        for (let index = 0; index < bounded.length; index++)
          solidDifference = Math.max(
            solidDifference,
            Math.abs(bounded[index] - boundedSoft[index]),
          );
        test.render({ blur: 5, source: 'grid' });
        const base = test.frame();
        test.render({ blur: 5, overlay: 'transparent', source: 'grid' });
        const transparent = test.frame();
        return {
          base,
          sameOutline,
          solidDifference,
          sharpEnergy: edgeEnergy(sharp),
          softEnergy: edgeEnergy(softened),
          transparent,
        };
      });
      expect(prefilter.softEnergy).toBeLessThan(prefilter.sharpEnergy * 0.8);
      expect(prefilter.sameOutline).toBe(true);
      expect(prefilter.solidDifference).toBeLessThanOrEqual(1);
      expect(prefilter.transparent).toEqual(prefilter.base);
      await page.screenshot({ path: '.data/music-m2-validation/glass-3d-source-prefilter.png' });
      expect(await page.evaluate(() => window.glass3dTest.resolution(0.02))).toEqual([6, 2]);
      expect(await page.evaluate(() => window.glass3dTest.resolution(0))).toBeNull();

      const batch = await page.evaluate(() => window.glass3dTest.batchProof());
      for (const tile of batch.differences) {
        expect(tile.size).toEqual(tile.expectedSize);
        expect(tile.difference).toBeLessThanOrEqual(1);
      }
      expect(batch.draws).toBe(2);
      expect(batch.allocations).toBe(0);
      expect(batch.uploads).toBe(0);
      const direct = await page.evaluate(() => window.glass3dTest.directProof());
      expect(direct.sameCanvas).toBe(true);
      expect(direct.preserved).toBe(false);
      expect(direct.error).toBe(0);
      expect(direct.pixel[3]).toBe(255);
      for (let channel = 0; channel < 3; channel++) {
        expect(Math.abs(direct.pixel[channel] - direct.expected[channel])).toBeLessThan(5);
      }

      await page.evaluate(() => window.glass3dTest.loseContext());
      await page.waitForFunction(() => window.glass3dTest.lifecycle().lost === 1);
      expect(await page.evaluate(() => window.glass3dTest.render())).toBe(false);
      await page.evaluate(() => window.glass3dTest.restoreContext());
      await page.waitForFunction(() => window.glass3dTest.lifecycle().restored === 1);
      expect(await page.evaluate(() => window.glass3dTest.render({ double: true }))).toBe(true);
      expect(await page.evaluate(() => window.glass3dTest.pixel(160, 50)[3])).toBe(255);
      await page.screenshot({ path: '.data/music-m2-validation/glass-3d-restored.png' });
      await page.evaluate(() => window.glass3dTest.dispose());
      expect(await page.evaluate(() => window.glass3dTest.render())).toBe(false);
      expect(await page.evaluate(() => window.glass3dTest.errors)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await server.close();
    }
  },
  120_000,
);
