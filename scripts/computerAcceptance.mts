import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { parse } from 'dotenv';

import { DockerComputerDriver, runDocker } from '../src/server/runtime/computer/docker/driver';
import { ComputerProviderJournal } from '../src/server/runtime/computer/docker/journal';
import {
  computerManifest,
  ComputerToolIdentifier,
  computerToolInput,
} from '../src/server/runtime/computer/manifest';
import type { ComputerDispatch } from '../src/server/runtime/computer/provider';
import { RemoteComputerProvider } from '../src/server/runtime/computer/remote';

const args = new Set(process.argv.slice(2));
assert(
  [...args].every((arg) =>
    ['--check', '--all', '--docker', '--browser', '--model', '--postgres', '--strict'].includes(
      arg,
    ),
  ),
  'UNKNOWN_OPTION',
);
assert(args.size > 0, 'SELECT_CHECK_OR_EXPLICIT_LIVE_TESTS');
assert(!args.has('--strict') || args.has('--all'), 'STRICT_REQUIRES_ALL');
if (args.has('--check')) {
  assert(args.size === 1, 'CHECK_MUST_RUN_ALONE');
  console.info(
    'Acceptance modules loaded. No services, databases, containers or model requests started.',
  );
  process.exit(0);
}

const liveDocker = args.has('--all') || args.has('--docker') || args.has('--browser');
const liveModel = args.has('--all') || args.has('--model');
const liveBrowser = args.has('--all') || args.has('--browser');
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const directory = path.resolve('.data/computer-acceptance', runId);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
type Result = {
  id: string;
  status: 'passed' | 'failed' | 'not-run';
  ms?: number;
  evidence?: unknown;
  error?: string;
};
const results: Result[] = [];
const report = {
  runId,
  startedAt: new Date().toISOString(),
  finishedAt: '',
  verdict: 'running',
  node: process.version,
  mode: [...args],
  results,
  limitations: [
    'Browser login tests use an offline fixture; real account CAPTCHA and MFA are not automated.',
    'Live application SQL uses isolated PGlite; production deployment and host power-loss testing are separate from this acceptance run.',
  ],
};
const save = () =>
  writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
const safeCode = (error: unknown) =>
  error instanceof Error && /^[A-Z][A-Z0-9_: -]{1,100}$/.test(error.message)
    ? error.message
    : 'ASSERTION_OR_RUNTIME_FAILURE_SEE_CASE';
async function check(id: string, run: () => Promise<unknown>) {
  const started = Date.now();
  try {
    const evidence = await run();
    results.push({ id, status: 'passed', ms: Date.now() - started, evidence });
    console.info(`[PASS] ${id}`);
    return true;
  } catch (error) {
    results.push({ id, status: 'failed', ms: Date.now() - started, error: safeCode(error) });
    console.info(`[FAIL] ${id}: ${safeCode(error)}`);
    return false;
  } finally {
    await save();
  }
}
function notRun(id: string, reason: string) {
  results.push({ id, status: 'not-run', evidence: reason });
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const docker = async (arguments_: string[], ms = 10000) => {
  const value = await runDocker(arguments_, AbortSignal.timeout(ms));
  assert.equal(value.code, 0, 'DOCKER_COMMAND_FAILED');
  return value.stdout;
};
async function unusedPort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert(address && typeof address !== 'string', 'NO_TEST_PORT');
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}
async function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

// The browser fixture runs entirely inside the sandbox, with no host server or external login.
function browserFixture(mode: 'write' | 'read', nonce: string) {
  return `const http=require('node:http'),{execFile}=require('node:child_process');
  const mode=${JSON.stringify(mode)},nonce=${JSON.stringify(nonce)};
  const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><html><body><output id="proof"></output><script>'+${JSON.stringify(mode === 'write' ? `localStorage.setItem('qingzhou-proof',${JSON.stringify(nonce)});document.cookie='qingzhou-proof=${nonce}; Max-Age=86400; SameSite=Strict; Path=/';` : '')}+'document.getElementById("proof").textContent=JSON.stringify({storage:localStorage.getItem("qingzhou-proof"),cookie:document.cookie});</script></body></html>');});
  server.listen(18765,'127.0.0.1',()=>execFile('/usr/bin/chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--renderer-process-limit=2','--user-data-dir=/workspace/.browser-profile','--dump-dom','http://127.0.0.1:18765/'],{timeout:22000,maxBuffer:100000},(error,stdout,stderr)=>{server.close();if(error){process.stderr.write(stderr.slice(-5000));process.exitCode=1;}else{const expected='qingzhou-proof='+nonce;const ok=stdout.includes(nonce)&&stdout.includes(expected);console.log(JSON.stringify({mode,storageAndCookie:ok}));if(!ok)process.exitCode=2;}}));`;
}

async function dockerTests() {
  const failuresBefore = results.filter((result) => result.status === 'failed').length;
  // Require an explicit socket to avoid modifying an unrelated default Docker engine.
  assert(process.env.DOCKER_HOST?.startsWith('unix://'), 'EXPLICIT_TEST_DOCKER_HOST_REQUIRED');
  const image = process.env.QINGZHOU_COMPUTER_IMAGE || 'qingzhou-computer:local';
  const imageId = (await docker(['image', 'inspect', '--format', '{{.Id}}', image])).trim();
  assert(/^sha256:[a-f0-9]{64}$/.test(imageId), 'IMMUTABLE_IMAGE_REQUIRED');
  const version = (await docker(['version', '--format', '{{.Server.Version}}'])).trim();
  const token = randomBytes(32).toString('hex');
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const sessionId = `acceptance-${runId}`;
  const resource = `qz-cmp-${createHash('sha256').update(JSON.stringify(sessionId)).digest('hex').slice(0, 32)}`;
  const volume = `${resource}-data`;
  await writeFile(
    path.join(directory, 'resources.json'),
    JSON.stringify({ imageId, resource, volume, port }, null, 2),
    { mode: 0o600 },
  );
  let child: ReturnType<typeof spawn> | undefined;
  let revision = 0;
  const log: string[] = [];
  const stop = async () => {
    if (!child) return;
    const current = child;
    child = undefined;
    if (current.exitCode === null && current.signalCode === null) {
      const exited = once(current, 'exit');
      current.kill('SIGTERM');
      const timer = setTimeout(() => current.kill('SIGKILL'), 35000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
  };
  const start = async () => {
    // No application env/key vault/model token is forwarded to the provider process.
    const env = Object.fromEntries(
      ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG'].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]!]] : [],
      ),
    );
    const provider = spawn(process.execPath, ['--import', 'tsx', 'scripts/computerProvider.mts'], {
      env: {
        ...env,
        QINGZHOU_COMPUTER_TOKEN: token,
        QINGZHOU_COMPUTER_IMAGE: imageId,
        QINGZHOU_COMPUTER_PORT: String(port),
        QINGZHOU_COMPUTER_STATE_DIR: path.join(directory, 'provider'),
        QINGZHOU_COMPUTER_NETWORK: 'none',
      } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = provider;
    provider.stdout!.on('data', (chunk) => log.push(String(chunk)));
    provider.stderr!.on('data', (chunk) => log.push(String(chunk)));
    provider.on('error', () => log.push('PROVIDER_PROCESS_ERROR'));
    for (let i = 0; i < 100; i++) {
      if (await portOpen(port)) return;
      if (provider.exitCode !== null) break;
      await delay(100);
    }
    throw new Error('PROVIDER_START_FAILED');
  };
  const remote = new RemoteComputerProvider(endpoint, token);
  const identity = ({ sessionId: session, commandId, revision: version }: ComputerDispatch) => ({
    sessionId: session,
    commandId,
    revision: version,
  });
  const command = (
    value: ComputerDispatch['command'],
    actor: ComputerDispatch['actor'] = 'human',
  ): ComputerDispatch => ({
    actor,
    command: value,
    commandId: randomUUID(),
    sessionId,
    revision: ++revision,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    ...(revision > 1 ? { resourceId: resource } : {}),
  });
  const invoke = (input: ComputerDispatch) => remote.execute(input, AbortSignal.timeout(32000));
  const shell = async (value: string) => {
    const receipt = await invoke(
      command({ kind: 'shell', command: value, timeoutMs: 30000 }, 'agent'),
    );
    if (receipt.exitCode !== 0)
      await writeFile(
        path.join(directory, 'sandbox-failure.json'),
        JSON.stringify(
          { exitCode: receipt.exitCode, stdout: receipt.stdout, stderr: receipt.stderr },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    assert.equal(receipt.exitCode, 0, 'SANDBOX_COMMAND_FAILED');
    return receipt;
  };
  try {
    await start();
    const ready = await check('docker.ensure.non-root-isolation', async () => {
      const receipt = await invoke(command({ kind: 'ensure' }));
      assert.equal(receipt.resourceId, resource, 'WRONG_RESOURCE');
      const inspect = JSON.parse(await docker(['container', 'inspect', resource]))[0];
      assert.equal(inspect.Config.User, '1000:1000', 'WRONG_USER');
      assert.equal(inspect.HostConfig.ReadonlyRootfs, true, 'ROOT_NOT_READ_ONLY');
      assert.equal(inspect.HostConfig.NetworkMode, 'none', 'NETWORK_NOT_ISOLATED');
      assert(
        !inspect.Mounts.some((mount: { Type: string }) => mount.Type === 'bind'),
        'HOST_BIND_PRESENT',
      );
      return { imageId, version, user: inspect.Config.User, network: 'none', readonlyRootfs: true };
    });
    if (!ready) throw new Error('ENSURE_FAILED_DEPENDENTS_NOT_RUN');
    const workflowPassed = await check('runtime.sql-cordis-http-docker', async () => {
      const runner = spawn(
        process.execPath,
        [
          'node_modules/vitest/vitest.mjs',
          'run',
          '--silent=passed-only',
          '--reporter=default',
          '--reporter=json',
          `--outputFile=${path.join(directory, 'runtime-live.json')}`,
          'src/server/runtime/computer/live.integration.test.ts',
          'src/server/runtime/computer/workflow.live.integration.test.ts',
          'src/server/runtime/computer/console.live.integration.test.ts',
        ],
        {
          env: {
            ...process.env,
            TEST_SERVER_DB: '0',
            NODE_OPTIONS: '--no-experimental-webstorage',
            QINGZHOU_COMPUTER_ACCEPTANCE: '1',
            QINGZHOU_COMPUTER_ENDPOINT: endpoint,
            QINGZHOU_COMPUTER_TOKEN: token,
            QINGZHOU_COMPUTER_ACCEPTANCE_DIR: directory,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const output: Buffer[] = [];
      runner.stdout.on('data', (chunk) => output.push(chunk));
      runner.stderr.on('data', (chunk) => output.push(chunk));
      const timer = setTimeout(() => runner.kill('SIGTERM'), 150000);
      try {
        const [code] = await once(runner, 'exit');
        await writeFile(path.join(directory, 'runtime-live.log'), Buffer.concat(output), {
          mode: 0o600,
        });
        assert.equal(code, 0, 'SQL_CORDIS_HTTP_DOCKER_FAILED');
        const summary = JSON.parse(
          await readFile(path.join(directory, 'runtime-live.json'), 'utf8'),
        );
        assert.equal(summary.numPassedTests, 7, 'LIVE_TESTS_MISSING');
        assert.equal(summary.numPendingTests, 0, 'LIVE_TESTS_SKIPPED');
        return {
          tests: 7,
          database: 'isolated-in-memory-PGlite',
          provider: 'real-loopback-HTTP',
          containers: 'real-Docker',
        };
      } finally {
        clearTimeout(timer);
      }
    });
    if (workflowPassed) {
      await check('browser.interactive-takeover-console', async () => ({
        evidence: 'runtime-live.json',
        screenshot: 'browser-takeover.png',
        component: 'production React panel',
        input: 'real click and text',
        handoff: 'old human revision revoked',
      }));
      await check('agent.computer-tools-approval-chain', async () => ({
        evidence: 'runtime-live.json',
        handler: 'production HumanInterventionHandler',
        executor: 'native Computer tool and real Docker',
        checks: 'pending blocked; approval resumes; same call writes once; headless pauses',
      }));
    }
    await check('docker.http.authentication-and-validation', async () => {
      const input = command({ kind: 'wake' });
      const response = await fetch(`${endpoint}/v1/computer/invoke`, {
        method: 'POST',
        headers: { authorization: 'Bearer invalid' },
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 401, 'BAD_AUTH_ACCEPTED');
      await response.body?.cancel();
      const malformed = await fetch(`${endpoint}/v1/computer/invoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...input, owner: 'forged' }),
      });
      assert.equal(malformed.status, 400, 'FORGED_INPUT_ACCEPTED');
      await malformed.body?.cancel();
    });
    await check('docker.shell.persistence-and-idempotency', async () => {
      const input = command(
        {
          kind: 'shell',
          command: 'printf x >> /workspace/executions; id -u; cat /workspace/executions',
          timeoutMs: 30000,
        },
        'agent',
      );
      const receipt = await invoke(input);
      assert.equal(receipt.exitCode, 0, 'SHELL_FAILED');
      assert.equal(receipt.stdout?.trim(), '1000\nx', 'WRONG_SHELL_RESULT');
      assert.deepEqual(await invoke(input), receipt, 'REPLAY_RECEIPT_CHANGED');
      assert.equal(
        (await shell('cat /workspace/executions')).stdout,
        'x',
        'COMMAND_EXECUTED_TWICE',
      );
    });
    await check('docker.sleep-wake.preserves-workspace', async () => {
      assert.equal((await invoke(command({ kind: 'sleep' }))).state, 'sleeping', 'DID_NOT_SLEEP');
      assert.equal((await invoke(command({ kind: 'wake' }))).state, 'ready', 'DID_NOT_WAKE');
      assert.equal((await shell('cat /workspace/executions')).stdout, 'x', 'WORKSPACE_LOST');
    });
    await check('docker.control.human-fences-agent', async () => {
      assert.equal(
        (await invoke(command({ kind: 'control', target: 'human' }))).control,
        'human',
        'HANDOFF_FAILED',
      );
      await assert.rejects(
        invoke(
          command(
            { kind: 'shell', command: 'touch /workspace/forbidden-agent-write', timeoutMs: 1000 },
            'agent',
          ),
        ),
      );
      await invoke(command({ kind: 'control', target: 'agent' }));
      await shell('test ! -e /workspace/forbidden-agent-write');
    });
    await check('docker.receipt.provider-restart-no-replay', async () => {
      const input = command(
        { kind: 'shell', command: 'printf y >> /workspace/restart-count', timeoutMs: 30000 },
        'agent',
      );
      const receipt = await invoke(input);
      await stop();
      await start();
      assert.deepEqual(
        await remote.lookup(identity(input), AbortSignal.timeout(5000)),
        { status: 'done', receipt },
        'DURABLE_RECEIPT_LOST',
      );
      assert.deepEqual(await invoke(input), receipt, 'RESTART_REPLAY_CHANGED');
      assert.equal(
        (await shell('cat /workspace/restart-count')).stdout,
        'y',
        'RESTART_REPLAYED_ACTION',
      );
    });
    await check('docker.receipt.disconnected-client', async () => {
      const input = command(
        {
          kind: 'shell',
          command: 'sleep 1; printf z >> /workspace/disconnect-count',
          timeoutMs: 10000,
        },
        'agent',
      );
      const abort = new AbortController();
      const pending = invokeWithSignal(input, abort.signal);
      void pending.catch(() => undefined);
      // Wait for durable acceptance before disconnecting the client.
      let accepted = false;
      for (let i = 0; i < 40; i++) {
        const lookup = await remote.lookup(identity(input), AbortSignal.timeout(5000));
        if (lookup.status === 'pending') {
          accepted = true;
          break;
        }
        await delay(50);
      }
      abort.abort();
      await assert.rejects(pending);
      assert(accepted, 'COMMAND_NOT_ACCEPTED_BEFORE_DISCONNECT');
      let done = false;
      for (let i = 0; i < 50; i++) {
        const lookup = await remote.lookup(identity(input), AbortSignal.timeout(5000));
        if (lookup.status === 'done') {
          done = true;
          break;
        }
        assert.equal(lookup.status, 'pending', 'DISCONNECT_BECAME_UNKNOWN');
        await delay(100);
      }
      assert(done, 'DISCONNECTED_RECEIPT_NOT_SAVED');
      assert.equal(
        (await shell('cat /workspace/disconnect-count')).stdout,
        'z',
        'DISCONNECTED_ACTION_REPLAYED',
      );
    });
    if (liveBrowser) {
      const nonce = randomBytes(12).toString('hex');
      const written = await check('browser.chromium.real-profile-write', async () => {
        const result = await shell(`node -e ${shellQuote(browserFixture('write', nonce))}`);
        assert(JSON.parse(result.stdout!).storageAndCookie, 'BROWSER_WRITE_FAILED');
        return { chromium: true, cookieAndLocalStorage: true, network: 'container-loopback-only' };
      });
      if (written)
        await check('browser.chromium.profile-survives-sleep-and-provider-restart', async () => {
          await invoke(command({ kind: 'sleep' }));
          await stop();
          await start();
          await invoke(command({ kind: 'wake' }));
          const result = await shell(`node -e ${shellQuote(browserFixture('read', nonce))}`);
          assert(JSON.parse(result.stdout!).storageAndCookie, 'BROWSER_PROFILE_LOST');
        });
      else
        notRun(
          'browser.chromium.profile-survives-sleep-and-provider-restart',
          'Profile write failed',
        );
    } else notRun('browser.chromium', 'Select --browser or --all');
    // This verifies a shell time limit and descendant cleanup, without poisoning later tests.
    await check('docker.shell.timeout-kills-descendants', async () => {
      const input = command(
        {
          kind: 'shell',
          command: '(sleep 3; touch /workspace/escaped-child) & wait',
          timeoutMs: 300,
        },
        'agent',
      );
      const receipt = await invoke(input);
      assert.notEqual(receipt.exitCode, 0, 'TIMEOUT_NOT_ENFORCED');
      await delay(3200);
      await shell('test ! -e /workspace/escaped-child');
      return { exitCode: receipt.exitCode, descendantDidNotWrite: true };
    });
  } finally {
    await stop();
    await writeFile(path.join(directory, 'provider.log'), log.join(''), { mode: 0o600 });
    await check('cleanup.provider-and-owned-containers', async () => {
      // Only names from this run are removed; never prune an engine or unrelated volumes.
      const names = (
        await docker([
          'container',
          'ls',
          '-a',
          '--filter',
          `label=io.qingzhou.computer=${createHash('sha256').update(sessionId).digest('hex')}`,
          '--format',
          '{{.Names}}',
        ])
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      for (const name of names) {
        assert(name === resource || name.startsWith(`${resource}-cmd-`), 'CLEANUP_SCOPE_INVALID');
        await docker(['container', 'rm', '--force', name]);
      }
      const existing = await runDocker(['volume', 'inspect', volume], AbortSignal.timeout(5000));
      if (existing.code === 0) await docker(['volume', 'rm', volume]);
      assert.equal(await portOpen(port), false, 'PROVIDER_STILL_LISTENING');
      return { providerStopped: true, removedContainers: names.length, volumeRemoved: true };
    });
  }
  if (results.filter((result) => result.status === 'failed').length > failuresBefore)
    throw new Error('DOCKER_SUITE_HAS_FAILED_CASES');
  function invokeWithSignal(input: ComputerDispatch, signal: AbortSignal) {
    return remote.execute(input, signal);
  }
}

async function modelTests() {
  const failuresBefore = results.filter((result) => result.status === 'failed').length;
  const snapshot = path.join(directory, 'credential-snapshot');
  // Never open the primary PGlite files in a second process or migrate them as a side effect.
  assert.equal(await portOpen(55432), false, 'STOP_PRIMARY_DATABASE_BEFORE_COLD_SNAPSHOT');
  const config = parse(await readFile('.env.development.local'));
  const account = JSON.parse(await readFile('.data/local-preview/account.json', 'utf8')) as {
    userId: string;
  };
  assert(account.userId && config.KEY_VAULTS_SECRET, 'SAVED_ACCOUNT_AND_VAULT_SECRET_REQUIRED');
  await cp('.data/local-preview/postgres', snapshot, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await chmod(snapshot, 0o700);
  const tooling = createRequire(path.resolve('.data/local-preview/tooling/package.json'));
  const { PGlite } = tooling('@electric-sql/pglite') as {
    PGlite: new (
      file: string,
      options: { extensions: Record<string, unknown> },
    ) => {
      waitReady: Promise<void>;
      query: <T>(sql: string, values: unknown[]) => Promise<{ rows: T[] }>;
      close: () => Promise<void>;
    };
  };
  const { vector } = tooling('@electric-sql/pglite-pgvector');
  const db = new PGlite(snapshot, { extensions: { vector } });
  try {
    await db.waitReady;
    const model = process.env.QINGZHOU_COMPUTER_MODEL || 'deepseek-v4.1-flash';
    assert(/^deepseek[-/]/i.test(model), 'DEEPSEEK_MODEL_REQUIRED');
    const rows = await db.query<{ id: string; key_vaults: string }>(
      `SELECT p.id,p.key_vaults FROM ai_providers p INNER JOIN ai_models m ON m.provider_id=p.id AND m.user_id=p.user_id WHERE p.user_id=$1 AND p.enabled=true AND m.id=$2 AND m.enabled=true AND m.type='chat' AND m.source='remote'`,
      [account.userId, model],
    );
    const candidates: { provider: string; apiKey: string; baseURL: string }[] = [];
    for (const row of rows.rows) {
      try {
        const [iv, tag, ciphertext] = row.key_vaults
          .split(':')
          .map((value) => Buffer.from(value, 'hex'));
        const key = Buffer.from(config.KEY_VAULTS_SECRET, 'base64');
        assert([16, 24, 32].includes(key.length), 'INVALID_VAULT_KEY_LENGTH');
        const algorithm =
          key.length === 16 ? 'aes-128-gcm' : key.length === 24 ? 'aes-192-gcm' : 'aes-256-gcm';
        const decipher = createDecipheriv(algorithm, key, iv);
        decipher.setAuthTag(tag);
        const vault = JSON.parse(
          Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(),
        );
        if (
          vault.baseURL?.replace(/\/$/, '') === 'https://cli.tinimodel.com/v1' &&
          typeof vault.apiKey === 'string' &&
          vault.apiKey.trim()
        )
          candidates.push({
            provider: row.id,
            apiKey: vault.apiKey,
            baseURL: vault.baseURL.replace(/\/$/, ''),
          });
      } catch {
        /* A bad vault is unavailable, never printed or copied into a report. */
      }
    }
    const preferred = process.env.QINGZHOU_COMPUTER_MODEL_PROVIDER;
    const selected = preferred
      ? candidates.find((candidate) => candidate.provider === preferred)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    assert(selected, 'UNAMBIGUOUS_SAVED_GATEWAY_REQUIRED');
    const headers = {
      'Authorization': `Bearer ${selected.apiKey}`,
      'Content-Type': 'application/json',
    };
    const listed = await check('model.gateway.live-model-catalog', async () => {
      const response = await fetch(`${selected.baseURL}/models`, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(response.status, 200, `MODEL_CATALOG_HTTP_${response.status}`);
      const value = (await response.json()) as { data: { id: string }[] };
      const ids = [...new Set(value.data.map((item) => item.id))];
      assert(ids.includes(model), 'EXACT_MODEL_NOT_RETURNED');
      return {
        provider: selected.provider,
        model,
        remoteModelCount: ids.length,
        baseURL: selected.baseURL,
      };
    });
    if (!listed) {
      notRun('model.deepseek.live-completion', 'Exact model unavailable in live catalog');
      throw new Error('MODEL_CATALOG_FAILED_COMPLETION_NOT_RUN');
    }
    await check('model.deepseek.live-completion', async () => {
      const nonce = `QZ_${randomBytes(8).toString('hex')}`;
      const response = await fetch(`${selected.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: 2048,
          messages: [
            {
              role: 'user',
              content: `Connection acceptance test. Reply with exactly ${nonce}. No explanation.`,
            },
          ],
        }),
      });
      assert.equal(response.status, 200, `MODEL_COMPLETION_HTTP_${response.status}`);
      const body = (await response.json()) as {
        model: string;
        choices: { message: { content: string }; finish_reason: string }[];
        usage: unknown;
      };
      assert.equal(
        body.choices[0]?.message.content?.trim(),
        nonce,
        'MODEL_NONCE_RESPONSE_MISMATCH',
      );
      return {
        requestedModel: model,
        returnedModel: body.model,
        finishReason: body.choices[0].finish_reason,
        usage: body.usage,
        nonceMatched: true,
      };
    });
    await check('model.deepseek.computer-tool-calling', async () => {
      const nonce = `QZ_${randomBytes(8).toString('hex')}`,
        command = `printf ${nonce}`,
        name = `${ComputerToolIdentifier}____execute`;
      const api = computerManifest().api.find((item) => item.name === 'execute')!;
      const response = await fetch(`${selected.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: 2048,
          tools: [
            {
              type: 'function',
              function: { name, description: api.description, parameters: api.parameters },
            },
          ],
          tool_choice: { type: 'function', function: { name } },
          messages: [
            {
              role: 'user',
              content: `Acceptance test: call the function with exactly ${JSON.stringify({ command: { kind: 'shell', command, timeoutMs: 1000 } })}. This is a tool syntax test.`,
            },
          ],
        }),
      });
      assert.equal(response.status, 200, `MODEL_TOOL_HTTP_${response.status}`);
      const body = (await response.json()) as {
        choices: {
          message: { tool_calls: { function: { name: string; arguments: string } }[] };
          finish_reason: string;
        }[];
        usage: unknown;
      };
      const calls = body.choices[0]?.message.tool_calls;
      assert.equal(calls?.length, 1, 'MODEL_TOOL_CALL_MISSING');
      assert.equal(calls[0].function.name, name, 'MODEL_TOOL_NAME_CHANGED');
      const parsed = computerToolInput.parse(JSON.parse(calls[0].function.arguments));
      assert.equal(parsed.command.kind, 'shell', 'MODEL_TOOL_KIND_CHANGED');
      assert(
        parsed.command.kind === 'shell' && parsed.command.command === command,
        'MODEL_TOOL_ARGUMENTS_CHANGED',
      );
      return {
        model,
        tool: name,
        argumentsMatched: true,
        usage: body.usage,
        finishReason: body.choices[0].finish_reason,
      };
    });
  } finally {
    await db.close();
    await rm(snapshot, { recursive: true, force: true });
  }
  if (results.filter((result) => result.status === 'failed').length > failuresBefore)
    throw new Error('MODEL_SUITE_HAS_FAILED_CASES');
}

async function publicWebTests() {
  const imageId = (
    await docker([
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      process.env.QINGZHOU_COMPUTER_IMAGE ?? 'qingzhou-computer:local',
    ])
  ).trim();
  const driver = new DockerComputerDriver(imageId, 'bridge'),
    sessionId = randomUUID(),
    resourceId = `qz-cmp-${createHash('sha256').update(JSON.stringify(sessionId)).digest('hex').slice(0, 32)}`;
  let session: {
      resourceId: string;
      state: 'new' | 'ready' | 'sleeping';
      control: 'human' | 'agent';
    } = { resourceId, state: 'new', control: 'agent' },
    revision = 0;
  const invoke = async (command: ComputerDispatch['command']) => {
    const receipt = await driver.execute(
      {
        sessionId,
        commandId: randomUUID(),
        revision: ++revision,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        actor: 'human',
        command,
      },
      session,
      AbortSignal.timeout(30000),
    );
    session = { resourceId, state: receipt.state, control: receipt.control };
    return receipt;
  };
  try {
    await invoke({ kind: 'ensure' });
    await invoke({ kind: 'browser', input: { action: 'start' } });
    assert.equal(
      (await invoke({ kind: 'browser', input: { action: 'navigate', url: 'https://example.org' } }))
        .exitCode,
      0,
      'PUBLIC_WEB_NAVIGATION_FAILED',
    );
    let matched = false;
    for (let i = 0; i < 30; i++) {
      const frame = await driver.observe(
        { sessionId, resourceId, revision },
        AbortSignal.timeout(10000),
      );
      if (frame.running && frame.title === 'Example Domain' && frame.text.length > 20) {
        matched = true;
        break;
      }
      await delay(100);
    }
    assert(matched, 'PUBLIC_WEB_PAGE_NOT_LOADED');
    return {
      url: 'https://example.org',
      https: true,
      network: 'bridge',
      titleAndBodyVerified: true,
    };
  } finally {
    await docker(['container', 'rm', '--force', resourceId]);
    await docker(['volume', 'rm', `${resourceId}-data`]);
  }
}

async function postgresTests() {
  assert(process.env.DOCKER_HOST?.startsWith('unix://'), 'EXPLICIT_TEST_DOCKER_HOST_REQUIRED');
  const name = `qz-accept-pg-${randomUUID()}`,
    password = randomBytes(24).toString('hex');
  try {
    await docker(
      [
        'container',
        'run',
        '-d',
        '--name',
        name,
        '--env',
        `POSTGRES_PASSWORD=${password}`,
        '--env',
        'POSTGRES_DB=qingzhou_accept_computer',
        '--publish',
        '127.0.0.1::5432',
        '--tmpfs',
        '/var/lib/postgresql:rw,size=536870912',
        'postgres:18-alpine',
      ],
      30000,
    );
    let ready = false;
    for (let i = 0; i < 100; i++) {
      const result = await runDocker(
        ['container', 'exec', name, 'pg_isready', '-U', 'postgres'],
        AbortSignal.timeout(3000),
      );
      if (result.code === 0) {
        ready = true;
        break;
      }
      await delay(100);
    }
    assert(ready, 'POSTGRES_NOT_READY');
    const mapping = (await docker(['container', 'port', name, '5432'])).trim();
    assert(/^127\.0\.0\.1:\d+$/.test(mapping), 'POSTGRES_MUST_BIND_LOOPBACK');
    const url = `postgresql://postgres:${password}@${mapping}/qingzhou_accept_computer`;
    const runner = spawn(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--silent=passed-only',
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${path.join(directory, 'postgres-live.json')}`,
        'src/server/runtime/computer/postgres.live.integration.test.ts',
      ],
      {
        env: {
          ...process.env,
          TEST_SERVER_DB: '0',
          NODE_OPTIONS: '--no-experimental-webstorage',
          QINGZHOU_COMPUTER_POSTGRES_TEST_URL: url,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const chunks: Buffer[] = [];
    runner.stdout.on('data', (chunk) => chunks.push(chunk));
    runner.stderr.on('data', (chunk) => chunks.push(chunk));
    const timer = setTimeout(() => runner.kill('SIGTERM'), 60000);
    try {
      const [code] = await once(runner, 'exit');
      await writeFile(path.join(directory, 'postgres-live.log'), Buffer.concat(chunks), {
        mode: 0o600,
      });
      assert.equal(code, 0, 'REAL_POSTGRES_COMPUTER_FAILED');
      const summary = JSON.parse(
        await readFile(path.join(directory, 'postgres-live.json'), 'utf8'),
      );
      assert.equal(summary.numPassedTests, 2, 'POSTGRES_TESTS_MISSING');
      return {
        database: 'PostgreSQL 18',
        passed: 2,
        coverage:
          'concurrent claims; ownership fencing; uncertain dispatch retained across reconnect',
        schema: 'Computer migrations on minimal owned-account fixture',
      };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await docker(['container', 'rm', '--force', '--volumes', name]);
  }
}

try {
  if (liveDocker) await check('suite.docker-live', dockerTests);
  else notRun('suite.docker-live', 'Select --docker, --browser or --all');
  if (liveBrowser) await check('browser.public-https-access', publicWebTests);
  if (liveModel) await check('suite.model-live', modelTests);
  else notRun('suite.model-live', 'Select --model or --all');
  if (args.has('--all') || args.has('--postgres'))
    await check('database.postgres.real-concurrency-and-recovery', postgresTests);
  await check('journal.expired-work-never-replayed', async () => {
    let clock = Date.now();
    const file = path.join(directory, 'expired.sqlite');
    let journal = new ComputerProviderJournal(file, 'acceptance-clock', () => clock);
    const input: ComputerDispatch = {
      sessionId: randomUUID(),
      commandId: randomUUID(),
      revision: 1,
      actor: 'human',
      command: { kind: 'ensure' },
      expiresAt: new Date(clock + 1000).toISOString(),
    };
    journal.claim(input);
    journal.close();
    clock += 2000;
    journal = new ComputerProviderJournal(file, 'acceptance-clock', () => clock);
    try {
      assert.equal(
        journal.lookup(input.sessionId, input.commandId, 1).status,
        'unknown',
        'EXPIRED_NOT_QUARANTINED',
      );
      assert.throws(() => journal.claim(input), /UNKNOWN/);
    } finally {
      journal.close();
    }
  });
} finally {
  for (const id of ['browser.interactive-takeover-console', 'agent.computer-tools-approval-chain'])
    if (!results.some((result) => result.id === id))
      notRun(id, 'Live workflow suite not run or failed; no pass is inferred');
  report.finishedAt = new Date().toISOString();
  const failed = results.some((result) => result.status === 'failed');
  const incomplete = results.some((result) => result.status === 'not-run');
  report.verdict = failed
    ? 'failed'
    : incomplete
      ? 'implemented-checks-passed-with-open-gaps'
      : 'passed';
  await save();
  console.info(`Report: ${path.relative(process.cwd(), path.join(directory, 'report.json'))}`);
  // Release gating must fail while product acceptance gaps remain unimplemented.
  process.exitCode = failed || (args.has('--strict') && incomplete) ? 1 : 0;
}
