import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const token = randomBytes(32).toString('hex');
let browser,
  socket,
  targetId,
  nextId = 0,
  connected = false;
const waiting = new Map();
function rpc(method, params = {}) {
  if (!connected) return Promise.reject(new Error('BROWSER_DISCONNECTED'));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('BROWSER_RPC_TIMEOUT'));
    }, 8000);
    waiting.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
function disconnected() {
  connected = false;
  for (const item of waiting.values()) {
    clearTimeout(item.timer);
    item.reject(new Error('BROWSER_DISCONNECTED'));
  }
  waiting.clear();
}
async function connectPage() {
  const pages = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page =
    pages.find((page) => page.id === targetId) ?? pages.find((page) => page.type === 'page');
  if (!page) throw new Error('BROWSER_PAGE_MISSING');
  targetId = page.id;
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('BROWSER_CONNECT_FAILED')), {
      once: true,
    });
  });
  connected = true;
  socket.addEventListener('close', disconnected);
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(event.data);
    const item = waiting.get(value.id);
    if (item) {
      clearTimeout(item.timer);
      waiting.delete(value.id);
      if (value.error) item.reject(new Error('BROWSER_PROTOCOL_ERROR'));
      else item.resolve(value.result);
    }
    if (value.method === 'Page.javascriptDialogOpening')
      void rpc('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined);
  });
  await rpc('Page.enable');
  await rpc('Emulation.setDeviceMetricsOverride', {
    width: 1100,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
}
async function start() {
  if (browser && browser.exitCode === null) {
    if (!connected) await connectPage();
    return;
  }
  browser = spawn(
    '/usr/bin/chromium',
    [
      '--headless',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--renderer-process-limit=2',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=9222',
      '--user-data-dir=/workspace/.browser-profile',
      '--window-size=1100,700',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  browser.on('exit', disconnected);
  for (let i = 0; i < 100; i++) {
    try {
      await connectPage();
      return;
    } catch {
      if (browser.exitCode !== null) throw new Error('BROWSER_START_FAILED');
      await delay(75);
    }
  }
  throw new Error('BROWSER_START_TIMEOUT');
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error('BROWSER_EVALUATE_FAILED');
  return result.result.value;
}
async function observe() {
  if (!browser || browser.exitCode !== null) return { running: false };
  if (!connected) await connectPage();
  const info = await evaluate(
    `(()=>({url:location.href.slice(0,4000),title:document.title.slice(0,500),text:(document.body?.innerText??'').slice(0,16000),controls:[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].map(e=>{const r=e.getBoundingClientRect();return {role:e.tagName.toLowerCase(),name:(e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.innerText||e.getAttribute('type')||'').slice(0,200),x:r.x+r.width/2,y:r.y+r.height/2}}).filter(e=>e.x>=0&&e.x<=1100&&e.y>=0&&e.y<=700).slice(0,80)}))()`,
  );
  let image;
  for (const quality of [45, 25, 10]) {
    image = (
      await rpc('Page.captureScreenshot', { format: 'jpeg', quality, captureBeyondViewport: false })
    ).data;
    if (image.length <= 240000) break;
  }
  if (image.length > 240000) throw new Error('BROWSER_FRAME_TOO_LARGE');
  return { running: true, image, width: 1100, height: 700, ...info };
}
async function perform(input) {
  if (input.action === 'observe') return observe();
  if (input.action === 'start') {
    await start();
    return { ok: true };
  }
  if (!browser || browser.exitCode !== null) throw new Error('BROWSER_NOT_STARTED');
  if (!connected) await connectPage();
  switch (input.action) {
    case 'navigate': {
      if (!/^https?:\/\//i.test(input.url)) throw new Error('BROWSER_URL_INVALID');
      const result = await rpc('Page.navigate', { url: input.url });
      if (result.errorText) return { ok: false, error: 'BROWSER_NAVIGATION_FAILED' };
      // No arbitrary page JavaScript or DOM content is used as an instruction.
      await delay(150);
      break;
    }
    case 'click': {
      await rpc('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: input.button ?? 'left',
        clickCount: 1,
        x: input.x,
        y: input.y,
      });
      await rpc('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: input.button ?? 'left',
        clickCount: 1,
        x: input.x,
        y: input.y,
      });
      break;
    }
    case 'drag': {
      await rpc('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        buttons: 1,
        clickCount: 1,
        x: input.x,
        y: input.y,
      });
      try {
        for (let step = 1; step <= 8; step++) {
          await rpc('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            button: 'left',
            buttons: 1,
            x: input.x + ((input.endX - input.x) * step) / 8,
            y: input.y + ((input.endY - input.y) * step) / 8,
          });
          await delay(12);
        }
      } finally {
        await rpc('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          button: 'left',
          buttons: 0,
          clickCount: 1,
          x: input.endX,
          y: input.endY,
        });
      }
      break;
    }
    case 'text': {
      await rpc('Input.insertText', { text: input.text });
      break;
    }
    case 'key': {
      const codes = {
        a: 65,
        Enter: 13,
        Tab: 9,
        Backspace: 8,
        Delete: 46,
        Escape: 27,
        ArrowLeft: 37,
        ArrowUp: 38,
        ArrowRight: 39,
        ArrowDown: 40,
        Home: 36,
        End: 35,
        PageUp: 33,
        PageDown: 34,
      };
      const params = {
        key: input.key,
        code: input.key,
        windowsVirtualKeyCode: codes[input.key],
        nativeVirtualKeyCode: codes[input.key],
        modifiers: input.modifiers ?? 0,
      };
      await rpc('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
      await rpc('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
      break;
    }
    case 'scroll': {
      await rpc('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 550,
        y: 350,
        deltaX: input.deltaX ?? 0,
        deltaY: input.deltaY,
      });
      break;
    }
    case 'reload': {
      await rpc('Page.reload');
      break;
    }
    case 'back': {
      const history = await rpc('Page.getNavigationHistory');
      const entry = history.entries[history.currentIndex - 1];
      if (entry) await rpc('Page.navigateToHistoryEntry', { entryId: entry.id });
      break;
    }
    default: {
      throw new Error('BROWSER_ACTION_INVALID');
    }
  }
  return { ok: true };
}

/** Inside-container loopback only; no CDP endpoint is published to the host or page. */
export async function listenBrowser() {
  await writeFile('/tmp/qingzhou-browser-token', token, { mode: 0o600 });
  let queue = Promise.resolve();
  const server = createServer(async (req, res) => {
    const auth = String(req.headers.authorization ?? '');
    const expected = `Bearer ${token}`;
    if (
      auth.length !== expected.length ||
      !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/') {
      res.writeHead(404).end();
      return;
    }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 40000) throw new Error('BROWSER_INPUT_TOO_LARGE');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const work = queue.then(() => perform(input));
      queue = work.catch(() => undefined);
      const result = await work;
      res
        .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify(result));
    } catch (error) {
      const code = /^BROWSER_[A-Z_]+$/.test(error?.message)
        ? error.message
        : 'BROWSER_OPERATION_FAILED';
      process.stderr.write(`${code}\n`);
      res.writeHead(503).end(JSON.stringify({ code }));
    }
  });
  server.listen(9223, '127.0.0.1');
  return async () => {
    server.close();
    const current = browser;
    if (current && current.exitCode === null) {
      const exited = once(current, 'exit');
      if (connected) await rpc('Browser.close').catch(() => undefined);
      await Promise.race([exited, delay(3500)]);
      if (current.exitCode === null) {
        current.kill('SIGTERM');
        await Promise.race([exited, delay(500)]);
      }
    }
    socket?.close();
  };
}
