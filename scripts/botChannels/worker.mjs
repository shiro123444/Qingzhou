import { setTimeout as delay } from 'node:timers/promises';

import { appUrl, required } from './config.mjs';

const endpoint = `${appUrl()}/api/agent/delivery/cron`;
const token = required('CRON_SECRET');
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown.abort());

async function tick(control) {
  const signal = AbortSignal.any([
    shutdown.signal,
    AbortSignal.timeout(control ? 30_000 : 31 * 60_000),
  ]);
  try {
    const res = await fetch(endpoint + (control ? '?lane=control' : ''), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const report = await res.json();
    if (!report.success) throw new Error('Worker rejected tick');
    const inbound = report.inbound;
    if (inbound?.processed || inbound?.deferred || inbound?.recovered)
      console.log(
        `Inbound ${control ? 'control' : 'regular'}: processed=${inbound.processed}, deferred=${inbound.deferred}, recovered=${inbound.recovered}`,
      );
  } catch (error) {
    if (!shutdown.signal.aborted)
      console.error(
        `Delivery ${control ? 'control' : 'regular'} tick failed: ${error.message?.startsWith('HTTP ') ? error.message : 'request unavailable'}`,
      );
  }
}
async function loop(control) {
  while (!shutdown.signal.aborted) {
    await tick(control);
    await delay(control ? 2000 : 10_000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
}
console.log(
  'Bot delivery worker running. Ctrl+C stops it. A separate control lane keeps /stop available.',
);
await Promise.all([loop(false), loop(true)]);
