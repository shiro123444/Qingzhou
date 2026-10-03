import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const environment = {
  ...process.env,
  APP_URL: 'http://127.0.0.1:3010',
  DATABASE_URL: 'postgres://test-only/unused',
  REDIS_URL: 'redis://test-only',
  KEY_VAULTS_SECRET: 'test-encryption-secret',
  CRON_SECRET: 'test-cron-secret',
  AUTH_SECRET: 'test-auth-secret',
  AGENT_RUNTIME_MODE: 'local',
};
test('configuration check reports presence without printing secrets', async () => {
  const child = spawn(process.execPath, ['scripts/botChannels/check.mjs'], { env: environment });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.match(output, /OK CRON_SECRET/);
  for (const key of [
    'DATABASE_URL',
    'REDIS_URL',
    'KEY_VAULTS_SECRET',
    'AUTH_SECRET',
    'CRON_SECRET',
  ])
    assert.ok(!output.includes(environment[key]));
});
test('configuration check fails when a required value is empty', async () => {
  const child = spawn(process.execPath, ['scripts/botChannels/check.mjs'], {
    env: { ...environment, CRON_SECRET: '' },
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
});
test('control polling continues while a regular local execution holds its HTTP request', async () => {
  let regular = 0;
  let control = 0;
  let invalid = 0;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${environment.CRON_SECRET}` || req.method !== 'POST')
      invalid++;
    if (req.url === '/api/agent/delivery/cron?lane=control') {
      control++;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ success: true, inbound: { processed: 0, deferred: 0, recovered: 0 } }),
      );
    } else if (req.url === '/api/agent/delivery/cron') regular++;
    else {
      invalid++;
      res.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const child = spawn(process.execPath, ['scripts/botChannels/worker.mjs'], {
    env: { ...environment, APP_URL: `http://127.0.0.1:${port}` },
  });
  try {
    const deadline = Date.now() + 10_000;
    while (control < 2 && Date.now() < deadline) await delay(50);
    assert.equal(regular, 1);
    assert.ok(control >= 2);
    assert.equal(invalid, 0);
  } finally {
    const closed = once(child, 'close');
    child.kill();
    await closed;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
