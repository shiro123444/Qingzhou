// @vitest-environment node
import { getTestDB } from '@lobechat/database/test-utils';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import {
  agentComputerCommands as commands,
  agentComputerSessions as sessions,
  agents,
  users,
} from '@/database/schemas';
import { AgentComputerService } from '@/server/services/agentComputer';
import type { ComputerActor, ComputerReceipt } from '@/types/agentComputer';

import { ComputerProviderJournal } from './docker/journal';
import { createComputerProviderHandler } from './docker/service';
import type { ComputerDispatch, ComputerProviderRegistration } from './provider';
import { RemoteComputerProvider } from './remote';
import { NativeComputerRuntime } from './runtime';
import { ComputerStore } from './store';

const db = await getTestDB();
const scope = { userId: 'computer-owner', agentId: 'computer-agent' };
let resources: Map<string, ComputerReceipt>;
let calls: ComputerDispatch[];
let registration: ComputerProviderRegistration;
let invoke: ReturnType<
  typeof vi.fn<(dispatch: ComputerDispatch, signal: AbortSignal) => Promise<ComputerReceipt>>
>;
beforeAll(async () => {
  await db.insert(users).values([{ id: scope.userId }, { id: 'computer-other' }]);
  await db.insert(agents).values([
    { id: scope.agentId, userId: scope.userId },
    { id: 'second-agent', userId: scope.userId },
    { id: 'foreign-agent', userId: 'computer-other' },
  ]);
});
beforeEach(async () => {
  await db.delete(sessions);
  resources = new Map();
  calls = [];
  invoke = vi.fn(async (dispatch: ComputerDispatch) => {
    calls.push(dispatch);
    const prior = resources.get(dispatch.sessionId);
    const receipt: ComputerReceipt = {
      resourceId: prior?.resourceId ?? `resource-${dispatch.sessionId}`,
      state: dispatch.command.kind === 'sleep' ? 'sleeping' : 'ready',
      control:
        dispatch.command.kind === 'control' ? dispatch.command.target : (prior?.control ?? 'agent'),
      ...(dispatch.command.kind === 'shell'
        ? { exitCode: 0, stdout: 'private output', stderr: '' }
        : {}),
    };
    resources.set(dispatch.sessionId, receipt);
    return receipt;
  });
  registration = {
    id: 'computer.test',
    capabilities: ['lifecycle', 'control', 'shell'],
    binding: 'test/v1',
    load: vi.fn(async () => ({ execute: invoke })),
  };
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, scope.userId));
  await db.delete(users).where(eq(users.id, 'computer-other'));
});
const runtime = (actor: ComputerActor = 'human', agentId = scope.agentId) =>
  new NativeComputerRuntime(db, { ...scope, agentId }, registration, {
    actor,
    authorize: async () => undefined,
  });

it('does not allocate on inspection, then reuses the persistent assistant identity across runtime recreation', async () => {
  expect(await runtime().store.view()).toEqual({ commands: [] });
  expect(registration.load).not.toHaveBeenCalled();
  await runtime().execute({ kind: 'ensure' }, 'initialize', 0);
  const first = (await runtime().store.view()).session!;
  const receipt = await runtime('agent').execute({ kind: 'shell', command: 'pwd' }, 'op:call');
  const restarted = runtime('agent');
  expect(await restarted.execute({ kind: 'shell', command: 'pwd' }, 'op:call')).toEqual(receipt);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ sessionId: first.id, resourceId: `resource-${first.id}` });
  expect(calls[1]).not.toHaveProperty('owner');
  expect(JSON.stringify(await restarted.store.view())).not.toMatch(
    /resource-|private output|stdout|leaseOwner|request_key|command.*pwd/,
  );
  await restarted.execute({ kind: 'sleep' }, 'sleep');
  await runtime().execute({ kind: 'wake' }, 'wake');
  expect((await restarted.store.view()).session).toMatchObject({ id: first.id, state: 'ready' });
});

it('isolates assistants and refuses foreign ownership, model-supplied context and missing authority', async () => {
  await expect(
    runtime('human', 'foreign-agent').execute({ kind: 'ensure' }, 'foreign'),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    runtime().execute({ kind: 'ensure', userId: 'computer-other' }, 'forged'),
  ).rejects.toThrow();
  const unauthorized = new NativeComputerRuntime(db, scope, registration, {
    actor: 'agent',
    authorize: async () => {
      throw new Error('approval required');
    },
  });
  await expect(unauthorized.execute({ kind: 'ensure' }, 'unapproved')).rejects.toThrow(
    'approval required',
  );
  expect(registration.load).not.toHaveBeenCalled();
  await runtime().execute({ kind: 'ensure' }, 'first');
  await runtime('human', 'second-agent').execute({ kind: 'ensure' }, 'second');
  expect(calls[0].sessionId).not.toBe(calls[1].sessionId);
});

it('serializes execution and rejects takeover while a command is in flight', async () => {
  await runtime().execute({ kind: 'ensure' }, 'init');
  let enter!: () => void, finish!: (receipt: ComputerReceipt) => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  invoke.mockImplementationOnce(async () => {
    enter();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const work = runtime('agent').execute({ kind: 'shell', command: 'long command' }, 'running');
  await entered;
  await expect(
    runtime().execute({ kind: 'control', target: 'human' }, 'takeover'),
  ).rejects.toMatchObject({ code: 'BUSY' });
  await expect(
    runtime('agent').execute({ kind: 'shell', command: 'other' }, 'competing'),
  ).rejects.toMatchObject({ code: 'BUSY' });
  finish(resources.values().next().value!);
  // Missing shell exit code is uncertain, never reported as a completed command.
  await expect(work).rejects.toThrow();
  expect((await runtime().store.view()).session?.state).toBe('unknown');
});

it('hands control to the human and requires an explicit provider acknowledgement to return it', async () => {
  await runtime().execute({ kind: 'ensure' }, 'init', 0);
  await runtime().execute({ kind: 'control', target: 'human' }, 'takeover', 1);
  await expect(
    runtime('agent').execute({ kind: 'shell', command: 'echo no' }, 'agent-blocked'),
  ).rejects.toMatchObject({ code: 'CONTROL_DENIED' });
  await runtime().execute({ kind: 'shell', command: 'manual action' }, 'human-input');
  await expect(
    runtime().execute({ kind: 'control', target: 'agent' }, 'stale', 1),
  ).rejects.toMatchObject({ code: 'STALE' });
  await runtime().execute({ kind: 'control', target: 'agent' }, 'return', 3);
  await runtime('agent').execute({ kind: 'shell', command: 'resume' }, 'agent-resume');
  expect((await runtime().store.view()).session).toMatchObject({ control: 'agent', revision: 5 });
});

it('cancels expired undispatched work without replay and quarantines expired dispatches against late commits', async () => {
  const store = runtime().store;
  const prepared = await store.claim({ kind: 'ensure' }, 'human', 'prepared');
  expect(prepared).toHaveProperty('lease');
  await db.update(sessions).set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` });
  await expect(store.claim({ kind: 'ensure' }, 'human', 'prepared')).rejects.toMatchObject({
    code: 'CANCELLED',
  });
  await runtime().execute({ kind: 'ensure' }, 'new-request');
  const accepted = await store.claim(
    { kind: 'shell', command: 'write', timeoutMs: 30000 },
    'agent',
    'uncertain',
  );
  if (!('lease' in accepted)) throw new Error('Missing lease');
  await store.dispatch(accepted.lease);
  await db.update(sessions).set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` });
  const recreated = new ComputerStore(db, scope, registration.binding);
  await expect(recreated.claim({ kind: 'ensure' }, 'human', 'newer')).rejects.toMatchObject({
    code: 'OUTCOME_UNKNOWN',
  });
  await expect(
    store.finish(accepted.lease, {
      resourceId: accepted.lease.resourceId!,
      state: 'ready',
      control: 'agent',
      exitCode: 0,
    }),
  ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  expect((await db.select().from(sessions))[0].state).toBe('unknown');
  expect((await db.select().from(commands)).map((c) => c.status).sort()).toEqual([
    'cancelled',
    'done',
    'unknown',
  ]);
});

it('cancels provider load failures but quarantines a lost result after dispatch, never retrying it', async () => {
  vi.mocked(registration.load).mockRejectedValueOnce(new Error('private token'));
  await expect(runtime().execute({ kind: 'ensure' }, 'load-failed')).rejects.toThrow(
    'COMPUTER_OUTCOME_UNKNOWN',
  );
  expect((await runtime().store.view()).commands[0].status).toBe('cancelled');
  await runtime().execute({ kind: 'ensure' }, 'init');
  invoke.mockRejectedValueOnce(new Error('private provider response'));
  await expect(
    runtime('agent').execute({ kind: 'shell', command: 'send' }, 'one-dispatch'),
  ).rejects.toThrow('COMPUTER_OUTCOME_UNKNOWN');
  const count = invoke.mock.calls.length;
  await expect(
    runtime('agent').execute({ kind: 'shell', command: 'send' }, 'one-dispatch'),
  ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  expect(invoke).toHaveBeenCalledTimes(count);
});

it('refuses changed request input and pins the provider binding and remote resource identity', async () => {
  await runtime().execute({ kind: 'ensure' }, 'init');
  await expect(runtime().execute({ kind: 'sleep' }, 'init')).rejects.toMatchObject({
    code: 'REQUEST_CONFLICT',
  });
  const changed = { ...registration, binding: 'another-endpoint', load: vi.fn() };
  const moved = new NativeComputerRuntime(db, scope, changed, {
    actor: 'human',
    authorize: async () => undefined,
  });
  expect((await moved.store.view()).bindingChanged).toBe(true);
  await expect(moved.execute({ kind: 'ensure' }, 'moved')).rejects.toMatchObject({
    code: 'PROVIDER_CHANGED',
  });
  expect(changed.load).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce({
    resourceId: 'another-computer',
    state: 'ready',
    control: 'agent',
    exitCode: 0,
  });
  await expect(
    runtime('agent').execute({ kind: 'shell', command: 'pwd' }, 'wrong-resource'),
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect((await runtime().store.view()).session?.state).toBe('unknown');
});

it('quarantines cancellation after dispatch and rejects a late provider completion', async () => {
  await runtime().execute({ kind: 'ensure' }, 'init');
  const controller = new AbortController();
  let entered!: () => void, release!: (receipt: ComputerReceipt) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  invoke.mockImplementationOnce(async () => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const agent = new NativeComputerRuntime(db, scope, registration, {
    actor: 'agent',
    authorize: async () => undefined,
    signal: controller.signal,
  });
  const work = agent.execute({ kind: 'shell', command: 'external action' }, 'cancelled-dispatch');
  await started;
  controller.abort();
  await expect(work).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  release({ ...resources.values().next().value!, exitCode: 0 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await agent.store.view()).session?.state).toBe('unknown');
  expect((await agent.store.view()).commands[0].status).toBe('unknown');
});

it('exposes account-scoped management without credentials and releases only undispatched expired work on inspection', async () => {
  const service = new AgentComputerService(db, scope.userId, registration);
  expect(await service.get(scope.agentId)).toEqual({ enabled: true, commands: [] });
  expect(registration.load).not.toHaveBeenCalled();
  await expect(service.get('foreign-agent')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    service.manage({
      agentId: scope.agentId,
      command: { kind: 'shell', command: 'pwd' },
      requestId: 'no-shell-route',
      expectedRevision: 0,
    }),
  ).rejects.toThrow();
  await runtime().store.claim({ kind: 'ensure' }, 'human', 'expired-preparation', 0);
  await db.update(sessions).set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` });
  const recovered = await service.get(scope.agentId);
  expect(recovered.commands[0].status).toBe('cancelled');
  expect(recovered.session).toMatchObject({ state: 'new', busy: false });
  expect(registration.load).not.toHaveBeenCalled();
  const view = await service.manage({
    agentId: scope.agentId,
    command: { kind: 'ensure' },
    requestId: 'after-recovery',
    expectedRevision: recovered.session!.revision,
  });
  expect(view.session?.state).toBe('ready');
  expect(JSON.stringify(view)).not.toMatch(/resource-|leaseOwner|providerBinding|stdout/);
});

it('recovers a lost HTTP response by querying the durable provider receipt without replaying the command', async () => {
  const journal = new ComputerProviderJournal(':memory:', 'wire-test');
  const execute = vi.fn(
    async (input: ComputerDispatch, session: { resourceId: string; control: ComputerActor }) => ({
      resourceId: session.resourceId,
      state: 'ready' as const,
      control: session.control,
      ...(input.command.kind === 'shell' ? { exitCode: 0, stdout: 'saved once' } : {}),
    }),
  );
  const token = 'wire-test-token-with-at-least-32-characters';
  const handler = createComputerProviderHandler(journal, { execute }, token);
  let loseNextReply = false;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const response = await handler(new Request(String(url), init));
    if (loseNextReply && String(url).endsWith('/invoke')) {
      loseNextReply = false;
      throw new Error('lost reply after durable receipt');
    }
    return response;
  });
  const wire: ComputerProviderRegistration = {
    id: 'computer.wire',
    binding: 'wire',
    capabilities: ['lifecycle', 'control', 'shell', 'receipt'],
    load: async () => new RemoteComputerProvider('https://wire.test', token),
  };
  const make = (actor: ComputerActor) =>
    new NativeComputerRuntime(db, scope, wire, { actor, authorize: async () => undefined });
  try {
    await make('human').execute({ kind: 'ensure' }, 'wire-init');
    loseNextReply = true;
    await expect(
      make('agent').execute({ kind: 'shell', command: 'write artifact' }, 'wire-shell'),
    ).rejects.toThrow('OUTCOME_UNKNOWN');
    const view = await make('human').store.view();
    expect(view.session?.state).toBe('unknown');
    expect(await make('human').reconcile(view.commands[0].id)).toBe('done');
    expect((await make('human').store.view()).session).toMatchObject({
      state: 'ready',
      control: 'agent',
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.at(-1)![0]).toBe('https://wire.test/v1/computer/receipt');
  } finally {
    fetch.mockRestore();
    journal.close();
  }
});

it('does not release quarantine for pending or mismatched receipts or let an agent reconcile itself', async () => {
  await runtime().execute({ kind: 'ensure' }, 'init');
  invoke.mockRejectedValueOnce(new Error('lost result'));
  await expect(
    runtime('agent').execute({ kind: 'shell', command: 'act' }, 'uncertain'),
  ).rejects.toThrow();
  const command = (await runtime().store.view()).commands[0];
  const lookup = vi.fn().mockResolvedValue({ status: 'pending' });
  registration = {
    ...registration,
    capabilities: [...registration.capabilities, 'receipt'],
    load: async () => ({ execute: invoke, lookup }),
  };
  expect(await runtime().reconcile(command.id)).toBe('pending');
  expect((await runtime().store.view()).session?.state).toBe('unknown');
  await expect(runtime('agent').reconcile(command.id)).rejects.toMatchObject({
    code: 'CONTROL_DENIED',
  });
  lookup.mockResolvedValue({
    status: 'done',
    receipt: { resourceId: 'wrong-machine', state: 'ready', control: 'agent', exitCode: 0 },
  });
  await expect(runtime().reconcile(command.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect((await runtime().store.view()).commands[0].status).toBe('unknown');
});
