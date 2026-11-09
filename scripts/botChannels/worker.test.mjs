import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
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
  BOT_WORKER_GATEWAY: '0',
  S3_ACCESS_KEY_ID: 'test-only',
  S3_SECRET_ACCESS_KEY: 'test-only',
  S3_ENDPOINT: 'http://127.0.0.1:1',
  S3_BUCKET: 'test-only',
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
test('control polling continues while regular execution and summary generation hold their HTTP requests', async () => {
  let regular = 0;
  let control = 0;
  let digest = 0;
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
    else if (req.url === '/api/agent/delivery/cron?lane=digest') digest++;
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
    assert.equal(digest, 1);
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

test('reports all four lanes, uses the correct gateway credential and stops cleanly without logging secrets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qingzhou-worker-'));
  const statusFile = path.join(directory, 'status.json');
  let invalid = 0;
  const server = createServer((req, res) => {
    const gateway = req.url === '/api/agent/gateway/start';
    if (
      req.headers.authorization !==
      `Bearer ${gateway ? environment.KEY_VAULTS_SECRET : environment.CRON_SECRET}`
    )
      invalid++;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        gateway
          ? { status: 'started' }
          : req.url?.includes('lane=digest')
            ? { success: true, digest: { status: 'empty' } }
            : { success: true },
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(process.execPath, ['scripts/botChannels/worker.mjs'], {
    env: {
      ...environment,
      APP_URL: `http://127.0.0.1:${server.address().port}`,
      BOT_WORKER_GATEWAY: '1',
      BOT_WORKER_STATUS_FILE: statusFile,
    },
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  try {
    let state;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      state = JSON.parse(await readFile(statusFile, 'utf8').catch(() => '{}'));
      if (Object.keys(state.lanes ?? {}).length === 4) break;
      await delay(25);
    }
    assert.equal(invalid, 0);
    assert.deepEqual(Object.keys(state.lanes).sort(), ['control', 'digest', 'gateway', 'regular']);
    assert.ok(Object.values(state.lanes).every((lane) => lane.ok));
    const closed = once(child, 'close');
    child.kill();
    const [code] = await closed;
    assert.equal(code, 0);
    const final = await readFile(statusFile, 'utf8');
    assert.ok(JSON.parse(final).stoppedAt);
    for (const key of ['CRON_SECRET', 'KEY_VAULTS_SECRET']) {
      assert.ok(!output.includes(environment[key]));
      assert.ok(!final.includes(environment[key]));
    }
  } finally {
    if (child.exitCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
