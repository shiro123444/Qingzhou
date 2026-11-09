import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { appUrl, required } from './config.mjs';

const endpoint = `${appUrl()}/api/agent/delivery/cron`;
const token = required('CRON_SECRET');
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown.abort());
const stateFile = process.env.BOT_WORKER_STATUS_FILE;
const state = { pid: process.pid, startedAt: new Date().toISOString(), lanes: {} };
let writing = Promise.resolve();
let lastWrite = 0;

function saveState(force = false) {
  if (!stateFile || (!force && Date.now() - lastWrite < 15_000)) return;
  lastWrite = Date.now();
  const content = JSON.stringify(state, null, 2);
  writing = writing
    .then(async () => {
      await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      const temporary = `${stateFile}.${process.pid}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, stateFile);
    })
    .catch(() => console.error('Worker health status could not be saved'));
}

const lanes = [
  { name: 'regular', url: endpoint, token, interval: 10_000, timeout: 31 * 60_000 },
  { name: 'control', url: `${endpoint}?lane=control`, token, interval: 2000, timeout: 30_000 },
  { name: 'digest', url: `${endpoint}?lane=digest`, token, interval: 60_000, timeout: 90_000 },
];
if (process.env.BOT_WORKER_GATEWAY === '1')
  lanes.push({
    name: 'gateway',
    url: `${appUrl()}/api/agent/gateway/start`,
    token: required('KEY_VAULTS_SECRET'),
    interval: 60_000,
    timeout: 60_000,
  });

async function tick(lane) {
  const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(lane.timeout)]);
  try {
    const res = await fetch(lane.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lane.token}` },
      body: lane.name === 'gateway' ? '{}' : undefined,
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const report = await res.json();
    if (lane.name === 'gateway' ? report.status !== 'started' : !report.success)
      throw new Error('Worker rejected tick');
    if (report.digest?.status === 'failed') throw new Error('digest_failed');
    const first = !state.lanes[lane.name];
    state.lanes[lane.name] = {
      ok: true,
      checkedAt: new Date().toISOString(),
      result: report.digest?.status ?? 'ok',
    };
    saveState(first);
    const inbound = report.inbound;
    if (inbound?.processed || inbound?.deferred || inbound?.recovered)
      console.log(
        `Inbound ${lane.name}: processed=${inbound.processed}, deferred=${inbound.deferred}, recovered=${inbound.recovered}`,
      );
    if (report.digest && report.digest.status !== 'idle')
      console.log(`Digest: ${report.digest.status}`);
  } catch (error) {
    if (!shutdown.signal.aborted) {
      const code =
        error.message?.startsWith('HTTP ') || error.message === 'digest_failed'
          ? error.message
          : 'request unavailable';
      state.lanes[lane.name] = { ok: false, checkedAt: new Date().toISOString(), result: code };
      saveState(true);
      console.error(`Delivery ${lane.name} tick failed: ${code}`);
    }
  }
}
async function loop(lane) {
  while (!shutdown.signal.aborted) {
    await tick(lane);
    await delay(lane.interval, undefined, { signal: shutdown.signal }).catch(() => {});
  }
}
console.log(
  'Bot worker running: delivery, control and daily-summary lanes are independent. Ctrl+C stops it.',
);
await Promise.all(lanes.map(loop));
state.stoppedAt = new Date().toISOString();
saveState(true);
await writing;
