// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { getTestDB } from '@lobechat/database/test-utils';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import { expect, it, vi } from 'vitest';

import { TaskModel } from '@/database/models/task';
import { agents, users } from '@/database/schemas';
import { AgentComputerService } from '@/server/services/agentComputer';
import { computerHumanCommandSchema } from '@/types/agentComputer';

import { runDocker } from './docker/driver';
import { getComputerProviderRegistration } from './provider';
import { NativeComputerRuntime } from './runtime';

interface LiveLocator {
  boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
  click: (options?: { position: { x: number; y: number } }) => Promise<void>;
  count: () => Promise<number>;
  fill: (value: string) => Promise<void>;
  getAttribute: (name: string) => Promise<string | null>;
  hover: (options?: { position: { x: number; y: number } }) => Promise<void>;
  isDisabled: () => Promise<boolean>;
  isEnabled: () => Promise<boolean>;
  screenshot: (options?: { path: string }) => Promise<Uint8Array>;
  waitFor: () => Promise<void>;
}
interface LivePage {
  emulateMedia: (options: { reducedMotion: 'reduce' }) => Promise<void>;
  getByRole: (role: string, options: { name: string; exact?: boolean }) => LiveLocator;
  goto: (url: string) => Promise<unknown>;
  locator: (selector: string) => LiveLocator;
  mouse: {
    move: (x: number, y: number, options?: { steps: number }) => Promise<void>;
    down: () => Promise<void>;
    up: () => Promise<void>;
  };
  screenshot: (options: { path: string; fullPage: boolean }) => Promise<unknown>;
  setViewportSize: (size: { width: number; height: number }) => Promise<void>;
  waitForTimeout: (milliseconds: number) => Promise<void>;
}
interface LiveBrowser {
  close: () => Promise<void>;
  newPage: (options: { viewport: { width: number; height: number } }) => Promise<LivePage>;
}
const { chromium } = createRequire(import.meta.url)('@playwright/test') as {
  chromium: {
    launch: (options: { headless: boolean; executablePath: string }) => Promise<LiveBrowser>;
  };
};

it.runIf(process.env.QINGZHOU_COMPUTER_ACCEPTANCE === '1')(
  'operates the actual React console and revokes its input on handback',
  async () => {
    if (process.env.TEST_SERVER_DB !== '0') throw new Error('ISOLATED_DATABASE_REQUIRED');
    vi.stubEnv('QINGZHOU_COMPUTER_ENABLED', '1');
    vi.stubEnv('AGENT_RUNTIME_MODE', 'native');
    const scope = { userId: `console-${randomUUID()}`, agentId: `agent-${randomUUID()}` },
      token = randomUUID();
    const db = await getTestDB();
    await db.insert(users).values({ id: scope.userId });
    await db.insert(agents).values({ id: scope.agentId, userId: scope.userId });
    const runtime = new NativeComputerRuntime(db, scope, getComputerProviderRegistration()!, {
      actor: 'human',
      authorize: async () => undefined,
    });
    const service = new AgentComputerService(db, scope.userId);
    const taskModel = new TaskModel(db, scope.userId);
    await taskModel.create({
      assigneeAgentId: scope.agentId,
      name: 'Daily brief',
      instruction: 'Test-only scheduled task; no worker runs it.',
      status: 'scheduled',
      automationMode: 'heartbeat',
      heartbeatInterval: 1800,
    });
    let resource: string | undefined;
    const html = `<!doctype html><html><body><h1>Interactive takeover</h1><input aria-label="Message" style="position:absolute;left:40px;top:100px;width:300px;height:40px"><button style="position:absolute;left:40px;top:180px;width:200px;height:40px" onclick="document.getElementById('result').textContent='Saved '+document.querySelector('input').value">Save</button><p id="result" style="position:absolute;top:240px"></p></body></html>`;
    const directory =
      process.env.QINGZHOU_COMPUTER_ACCEPTANCE_DIR ??
      path.resolve('.data/computer-console-validation');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let managementRequests = 0;
    let observationRequests = 0;
    const server = await createServer({
      configFile: false,
      envFile: false,
      logLevel: 'error',
      root: process.cwd(),
      cacheDir: path.join(directory, 'vite'),
      resolve: {
        alias: [
          {
            find: '@/services/agentComputer',
            replacement: path.resolve('tests/fixtures/computerConsoleClient.ts'),
          },
          { find: '@', replacement: path.resolve('src') },
        ],
        dedupe: ['react', 'react-dom'],
      },
      define: {
        '__DEV__': 'true',
        '__TEST__': 'true',
        '__ELECTRON__': 'false',
        '__MOBILE__': 'false',
        'process.env': '{}',
      },
      optimizeDeps: {
        noDiscovery: true,
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
          'swr',
          'motion/react',
          '@react-three/fiber',
          'three',
        ],
      },
      plugins: [
        react(),
        {
          name: 'computer-console-fixture',
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              const route = req.url?.split('?')[0];
              if (route === '/console' || route === '/companion') {
                res.setHeader('content-type', 'text/html');
                res.setHeader(
                  'set-cookie',
                  `qz-fixture=${token}; HttpOnly; SameSite=Strict; Path=/`,
                );
                res.end(
                  await vite.transformIndexHtml(
                    '/console',
                    `<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="/tests/fixtures/${route === '/companion' ? 'computerCompanion' : 'computerConsole'}.tsx"></script></body></html>`,
                  ),
                );
                return;
              }
              if (req.url !== '/fixture/computer') return next();
              if (req.method !== 'POST' || !req.headers.cookie?.includes(`qz-fixture=${token}`)) {
                res.statusCode = 401;
                res.end();
                return;
              }
              try {
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const chunk of req) {
                  size += chunk.length;
                  if (size > 40000) throw new Error('INPUT_TOO_LARGE');
                  chunks.push(Buffer.from(chunk));
                }
                const { action, input } = JSON.parse(Buffer.concat(chunks).toString());
                let result;
                if (action === 'get') result = await service.get(scope.agentId);
                else if (action === 'tasks') {
                  const page = await taskModel.list({
                    assigneeAgentId: scope.agentId,
                    limit: 6,
                    statuses: ['backlog', 'running', 'scheduled', 'paused'],
                  });
                  result = {
                    total: page.total,
                    items: page.tasks.map((task) => ({
                      id: task.id,
                      title: task.name || task.identifier,
                      status: task.status,
                      mode: task.automationMode,
                      intervalSeconds: task.heartbeatInterval,
                    })),
                  };
                } else if (action === 'manage') {
                  managementRequests++;
                  result = await service.manage({
                    ...input,
                    agentId: scope.agentId,
                    command: computerHumanCommandSchema.parse(input.command),
                  });
                } else if (action === 'observe') {
                  observationRequests++;
                  result = await service.observe(scope.agentId, input.expectedRevision);
                } else throw new Error('UNKNOWN_FIXTURE_ACTION');
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify(result));
              } catch {
                res.statusCode = 409;
                res.end('{}');
              }
            });
          },
        },
      ],
      server: { host: '127.0.0.1', port: 0, preTransformRequests: false },
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === 'string') throw new Error('NO_FIXTURE_ADDRESS');
      browser = await chromium.launch({
        headless: true,
        executablePath:
          process.env.COMPUTER_BROWSER_EXECUTABLE ??
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      });
      const page = await browser.newPage({ viewport: { width: 1400, height: 1050 } });
      await page.goto(`http://127.0.0.1:${address.port}/companion`);
      const avatar = page.locator('[data-computer-companion] canvas[data-engine]');
      await avatar.waitFor();
      await page.locator('a[href^="/task/"]').waitFor();
      expect(observationRequests).toBe(0);
      expect(await page.locator('[data-computer-companion] img').count()).toBe(0);
      expect(
        await page.getByRole('button', { name: 'Pull to open the computer', exact: true }).count(),
      ).toBe(0);
      await page.screenshot({
        path: path.join(directory, 'companion-default.png'),
        fullPage: true,
      });
      const center = await page.locator('[data-companion-content]').boundingBox(),
        rail = await page.locator('[data-computer-companion]').boundingBox();
      expect(rail!.x).toBeGreaterThanOrEqual(center!.x + center!.width);
      await page.mouse.move(80, 120);
      await page.waitForTimeout(700);
      const left = Buffer.from(
        await avatar.screenshot({ path: path.join(directory, 'gaze-left.png') }),
      );
      await page.mouse.move(1380, 500);
      await page.waitForTimeout(700);
      const right = Buffer.from(
        await avatar.screenshot({ path: path.join(directory, 'gaze-right.png') }),
      );
      expect(left.equals(right)).toBe(false);
      await page.getByRole('textbox', { name: 'Test composer' }).fill('An unsent draft');
      await page.locator('[data-attention-area="compose"]').waitFor();
      await page.getByRole('tab', { name: 'Senses', exact: true }).click();
      await page.getByRole('button', { name: 'Turn off companion awareness', exact: true }).click();
      await page.mouse.move(80, 120);
      await page.waitForTimeout(800);
      const offLeft = Buffer.from(await avatar.screenshot());
      await page.mouse.move(1380, 500);
      await page.waitForTimeout(500);
      expect(offLeft.equals(Buffer.from(await avatar.screenshot()))).toBe(true);
      await page.getByRole('button', { name: 'Turn on companion awareness', exact: true }).click();
      await page.getByRole('button', { name: 'Music workspace', exact: true }).hover();
      await page.locator('[data-attention-area="music"]').waitFor();
      expect(managementRequests).toBe(0);
      await page.getByRole('tab', { name: 'Activity', exact: true }).click();
      expect(observationRequests).toBe(0);
      await page.getByRole('button', { name: 'Open companion workspace', exact: true }).click();
      await page.getByRole('button', { name: 'Open computer', exact: true }).waitFor();
      await page.screenshot({ path: path.join(directory, 'workbench-empty.png'), fullPage: true });
      await page.getByRole('button', { name: 'Open computer', exact: true }).click();
      await page.getByRole('button', { name: 'Return to assistant', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'You’re in control.', exact: true }).waitFor();
      const firstLetter = page.locator(
        '[data-computer-workbench] h2 [data-weight-wave] > span[aria-hidden] > span:first-child > span:first-child',
      );
      await page
        .getByRole('heading', { name: 'You’re in control.', exact: true })
        .hover({ position: { x: 10, y: 20 } });
      await expect
        .poll(async () =>
          parseFloat((await firstLetter.getAttribute('style'))?.split(':')[1] ?? '0'),
        )
        .toBeGreaterThan(680);
      expect(await page.locator('[data-motion-glyph] svg').count()).toBe(0);
      expect(managementRequests).toBe(3);
      const session = (await runtime.store.view()).session!;
      resource = `qz-cmp-${createHash('sha256').update(JSON.stringify(session.id)).digest('hex').slice(0, 32)}`;
      await runDocker(
        [
          'container',
          'exec',
          '-d',
          resource,
          'node',
          '-e',
          `require('node:http').createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(${JSON.stringify(html)});}).listen(18767,'127.0.0.1')`,
        ],
        AbortSignal.timeout(5000),
      );

      await expect
        .poll(async () => await page.getByRole('textbox', { name: 'Website address' }).isEnabled())
        .toBe(true);
      await page.getByRole('textbox', { name: 'Website address' }).fill('http://127.0.0.1:18767/');
      await page.getByRole('button', { name: 'Go', exact: true }).click();
      await page.getByRole('img', { name: 'Live browser screen', exact: true }).waitFor();
      const screen = page.getByRole('application', { name: 'Live browser screen' });
      const box = await screen.boundingBox();
      if (!box) throw new Error('NO_CONSOLE_SCREEN');
      await screen.click({
        position: { x: (190 / 1100) * box.width, y: (120 / 700) * box.height },
      });
      await page
        .getByRole('textbox', { name: 'Text to enter in the focused browser field' })
        .fill('Hello from human');
      await page.getByRole('button', { name: 'Enter text', exact: true }).click();
      await expect
        .poll(async () => {
          const current = await runtime.store.view();
          return !current.session?.busy;
        })
        .toBe(true);
      await page.getByRole('application', { name: 'Live browser screen' }).waitFor();
      await page
        .getByRole('application', { name: 'Live browser screen' })
        .click({ position: { x: (140 / 1100) * box.width, y: (200 / 700) * box.height } });
      await expect
        .poll(async () => {
          const view = await runtime.store.view();
          try {
            const { frame } = await service.observe(scope.agentId, view.session!.revision);
            return frame.running ? frame.text : '';
          } catch {
            return '';
          }
        })
        .toContain('Saved Hello from human');
      await page.screenshot({ path: path.join(directory, 'browser-takeover.png'), fullPage: true });
      await page.getByRole('button', { name: 'Glass magnifier', exact: true }).click();
      await screen.hover({ position: { x: 170, y: 140 } });
      await expect.poll(async () => await page.locator('[data-glass-lens]').count()).toBe(1);
      await page.screenshot({ path: path.join(directory, 'glass-lens.png'), fullPage: true });
      await page.getByRole('button', { name: 'Return to assistant', exact: true }).click();
      await expect
        .poll(async () => await page.getByRole('textbox', { name: 'Website address' }).isDisabled())
        .toBe(true);
      await expect
        .poll(async () => (await runtime.store.view()).session?.control, { timeout: 10000 })
        .toBe('agent');
      await page.getByRole('heading', { name: 'Your companion’s ready.', exact: true }).waitFor();
      await page.screenshot({ path: path.join(directory, 'browser-handback.png'), fullPage: true });
      await page.getByRole('button', { name: 'Close computer', exact: true }).click();
      await page.getByRole('button', { name: 'Collapse companion sidebar', exact: true }).click();
      await page.getByRole('button', { name: 'Expand companion sidebar', exact: true }).click();
      await page.getByRole('button', { name: 'Open companion workspace', exact: true }).click();
      await page.getByRole('button', { name: 'Take control', exact: true }).click();
      await expect.poll(async () => (await runtime.store.view()).session?.control).toBe('human');
      await page.getByRole('button', { name: 'Close computer', exact: true }).click();
      await expect
        .poll(async () => await page.locator('[data-state="human"]').count(), { timeout: 15000 })
        .toBe(1);
      expect(await page.locator('[data-computer-companion] img').count()).toBe(0);
      await page.waitForTimeout(250);
      const closedObservations = observationRequests;
      await page.waitForTimeout(1000);
      expect(observationRequests).toBe(closedObservations);

      await page.screenshot({ path: path.join(directory, 'companion-human.png'), fullPage: true });
      await page.getByRole('button', { name: 'Collapse companion sidebar', exact: true }).click();
      await page.getByRole('button', { name: 'Expand companion sidebar', exact: true }).click();
      await page.getByRole('button', { name: 'Validate streaming motion', exact: true }).click();
      await expect
        .poll(async () => await page.locator('[data-qz-stream-word]').count())
        .toBeGreaterThan(4);
      await expect.poll(async () => await page.locator('pre').count()).toBe(1);
      await expect.poll(async () => await page.locator('[data-read-current]').count()).toBe(1);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.screenshot({ path: path.join(directory, 'reduced-motion.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(async () => {
          const box = await page.locator('[data-computer-companion]').boundingBox();
          return !!box && box.x >= 0 && box.x + box.width <= 390;
        })
        .toBe(true);
      await page.screenshot({ path: path.join(directory, 'companion-narrow.png'), fullPage: true });
      await page.goto(`http://127.0.0.1:${address.port}/companion?dark`);

      await page.getByRole('button', { name: 'View & control', exact: true }).waitFor();
      expect(await page.locator('[data-computer-companion] img').count()).toBe(0);
      await page.screenshot({ path: path.join(directory, 'companion-dark.png'), fullPage: true });
      await page.getByRole('button', { name: 'View & control', exact: true }).click();
      await page.getByRole('heading', { name: 'You’re in control.', exact: true }).waitFor();
      await expect
        .poll(async () => {
          const box = await page
            .getByRole('application', { name: 'Live browser screen' })
            .boundingBox();
          return !!box && box.width > 200 && box.x >= 0 && box.x + box.width <= 390;
        })
        .toBe(true);
      await page.screenshot({
        path: path.join(directory, 'workbench-narrow-dark.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1400, height: 1050 });
      await page.goto(`http://127.0.0.1:${address.port}/companion?lang=zh-CN`);
      await page.getByRole('button', { name: '查看与接管', exact: true }).click();
      await page.getByRole('heading', { name: '你正在控制', exact: true }).waitFor();
      await page.getByRole('application', { name: '浏览器实时画面', exact: true }).waitFor();
      await page.screenshot({ path: path.join(directory, 'workbench-zh.png'), fullPage: true });
    } finally {
      await browser?.close();
      await server.close();
      const final = await runtime.store.view();
      const ownedResource =
        resource ??
        (final.session
          ? `qz-cmp-${createHash('sha256').update(JSON.stringify(final.session.id)).digest('hex').slice(0, 32)}`
          : undefined);
      if (ownedResource) {
        await runDocker(['container', 'rm', '--force', ownedResource], AbortSignal.timeout(10000));
        await runDocker(['volume', 'rm', `${ownedResource}-data`], AbortSignal.timeout(10000));
      }
      vi.unstubAllEnvs();
    }
  },
  120000,
);
