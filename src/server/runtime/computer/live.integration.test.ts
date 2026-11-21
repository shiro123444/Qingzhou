// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';

import { getTestDB } from '@lobechat/database/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import type { ComputerActor } from '@/types/agentComputer';

import { runDocker } from './docker/driver';
import type { ComputerProviderRegistration } from './provider';
import { RemoteComputerProvider } from './remote';
import { NativeComputerRuntime } from './runtime';

// Live tests are deliberately excluded from normal regression execution.
const enabled = process.env.QINGZHOU_COMPUTER_ACCEPTANCE === '1';
describe.skipIf(!enabled)('SQL + Cordis + real HTTP + Docker acceptance', () => {
  let db: LobeChatDatabase;
  let registration: ComputerProviderRegistration;
  let loseNextReply = false;
  let resource: string | undefined;
  const scope = { userId: `live-computer-${randomUUID()}`, agentId: `live-agent-${randomUUID()}` };
  const runtime = (actor: ComputerActor = 'human') =>
    new NativeComputerRuntime(db, scope, registration, { actor, authorize: async () => undefined });
  beforeAll(async () => {
    if (process.env.TEST_SERVER_DB !== '0' || !process.env.DOCKER_HOST?.startsWith('unix://'))
      throw new Error('ISOLATED_TEST_DATABASE_AND_ENGINE_REQUIRED');
    const endpoint = process.env.QINGZHOU_COMPUTER_ENDPOINT!;
    const token = process.env.QINGZHOU_COMPUTER_TOKEN!;
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) || token.length < 24)
      throw new Error('TEST_PROVIDER_REQUIRED');
    db = await getTestDB();
    await db.insert(users).values({ id: scope.userId });
    await db.insert(agents).values({ id: scope.agentId, userId: scope.userId });
    registration = {
      id: 'computer.live-acceptance',
      binding: endpoint,
      capabilities: ['lifecycle', 'control', 'shell', 'receipt'],
      load: async () => {
        const remote = new RemoteComputerProvider(endpoint, token);
        return {
          execute: async (input, signal) => {
            const receipt = await remote.execute(input, signal);
            if (loseNextReply) {
              loseNextReply = false;
              throw new Error('INJECTED_LOST_REPLY_AFTER_REAL_ACTION');
            }
            return receipt;
          },
          lookup: (identity, signal) => remote.lookup(identity, signal),
        };
      },
    };
  }, 30000);
  afterAll(async () => {
    // The SQL projection omits provider handles; derive only this test's owned resource.
    if (db && registration) {
      const sessionId = (await runtime().store.view()).session?.id;
      if (sessionId)
        resource = `qz-cmp-${createHash('sha256').update(JSON.stringify(sessionId)).digest('hex').slice(0, 32)}`;
    }
    if (resource) {
      const container = await runDocker(
        ['container', 'inspect', resource],
        AbortSignal.timeout(5000),
      );
      if (container.code === 0)
        expect(
          (await runDocker(['container', 'rm', '--force', resource], AbortSignal.timeout(10000)))
            .code,
        ).toBe(0);
      const volume = await runDocker(
        ['volume', 'inspect', `${resource}-data`],
        AbortSignal.timeout(5000),
      );
      if (volume.code === 0)
        expect(
          (await runDocker(['volume', 'rm', `${resource}-data`], AbortSignal.timeout(10000))).code,
        ).toBe(0);
    }
  }, 30000);

  it('keeps inspection lazy, then executes through Cordis and stores a reusable SQL receipt', async () => {
    expect(await runtime().store.view()).toEqual({ commands: [] });
    await runtime().execute({ kind: 'ensure' }, 'ensure-live');
    const command = {
      kind: 'shell',
      command: 'printf q >> /workspace/sql-count; cat /workspace/sql-count',
    };
    const receipt = await runtime('agent').execute(command, 'sql-write');
    expect(receipt).toMatchObject({ exitCode: 0, stdout: 'q' });
    expect(await runtime('agent').execute(command, 'sql-write')).toEqual(receipt);
    expect((await runtime().store.view()).commands[0].status).toBe('done');
  }, 30000);

  it('enforces human handoff in the SQL runtime before allowing further Agent input', async () => {
    await runtime().execute({ kind: 'control', target: 'human' }, 'human-control');
    await expect(
      runtime('agent').execute(
        { kind: 'shell', command: 'touch /workspace/forbidden' },
        'blocked-agent',
      ),
    ).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
    await runtime().execute({ kind: 'control', target: 'agent' }, 'agent-control');
  }, 30000);

  it('quarantines a lost real reply and reconciles its durable receipt without replaying the shell', async () => {
    loseNextReply = true;
    await expect(
      runtime('agent').execute(
        { kind: 'shell', command: 'printf r >> /workspace/reconciled-count' },
        'lost-reply',
      ),
    ).rejects.toThrow('OUTCOME_UNKNOWN');
    const view = await runtime().store.view();
    expect(view.session?.state).toBe('unknown');
    await expect(runtime('agent').reconcile(view.commands[0].id)).rejects.toMatchObject({
      code: 'CONTROL_DENIED',
    });
    expect(await runtime().reconcile(view.commands[0].id)).toBe('done');
    expect((await runtime().store.view()).session?.state).toBe('ready');
    expect(
      await runtime('agent').execute(
        {
          kind: 'shell',
          command: 'cat /workspace/reconciled-count; test ! -e /workspace/forbidden',
        },
        'verify-once',
      ),
    ).toMatchObject({ exitCode: 0, stdout: 'r' });
  }, 30000);
});
