// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import type { ComputerDispatch } from '../provider';
import { DockerComputerDriver, type DockerRunner } from './driver';
import { ComputerProviderJournal } from './journal';
import { createComputerProviderHandler } from './service';

const token = 'provider-test-token-with-32-characters';
const paths: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of paths.splice(0)) await rm(path,{ recursive: true, force: true }); });
const dispatch = (overrides: Partial<ComputerDispatch> = {}): ComputerDispatch => ({ sessionId: 'session', commandId: 'command', revision: 1, expiresAt: new Date(Date.now()+60000).toISOString(), actor: 'human', command: { kind: 'ensure' }, ...overrides });
const request = (path: string, value: unknown, auth = token) => new Request(`https://provider.test/v1/computer/${path}`, { method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(value) });
async function filename() { const path = await mkdtemp(nodePath.join(tmpdir(),'qz-provider-')); paths.push(path); return nodePath.join(path,'receipts.sqlite'); }

it('persists completed receipts across reopen and refuses changed or newer concurrent actions', async () => {
  const file = await filename();
  let journal = new ComputerProviderJournal(file,'image:v1');
  const input = dispatch();
  const accepted = journal.claim(input);
  if (!('session' in accepted)) throw new Error('Missing session');
  const receipt = { resourceId: accepted.session.resourceId, state: 'ready' as const, control: 'agent' as const };
  journal.finish(input,receipt); journal.close();
  journal = new ComputerProviderJournal(file,'image:v1');
  expect(journal.lookup(input.sessionId,input.commandId,1)).toEqual({ status: 'done', receipt });
  expect(journal.claim(input)).toEqual({ cached: receipt });
  expect(() => journal.claim({ ...input, command: { kind: 'sleep' } })).toThrow('CONFLICT');
  journal.claim(dispatch({ commandId: 'second', revision: 2, resourceId: receipt.resourceId, command: { kind: 'control', target: 'human' } }));
  expect(() => journal.claim(dispatch({ commandId: 'third', revision: 3 }))).toThrow('BUSY');
  expect(journal.lookup(input.sessionId,input.commandId,1)).toEqual({ status: 'unknown' });
  journal.close();
  expect(() => new ComputerProviderJournal(file,'different-image')).toThrow('CONFLICT');
});

it('quarantines expired accepted work across restart without running it again', async () => {
  const file = await filename(); let clock = Date.now();
  let journal = new ComputerProviderJournal(file,'v1',() => clock);
  const input = dispatch(); journal.claim(input); journal.close();
  clock += 61000;
  journal = new ComputerProviderJournal(file,'v1',() => clock);
  expect(journal.lookup(input.sessionId,input.commandId,1)).toEqual({ status: 'unknown' });
  expect(() => journal.claim(input)).toThrow('UNKNOWN');
  expect(() => journal.finish(input,{ resourceId: 'late', state: 'ready', control: 'agent' })).toThrow('UNKNOWN');
  expect(() => journal.claim(dispatch({ commandId: 'new', revision: 2, expiresAt: new Date(clock+60000).toISOString() }))).toThrow('UNKNOWN');
  journal.close();
});

it('authenticates before dispatch and looks up results without touching the driver', async () => {
  const journal = new ComputerProviderJournal(':memory:','v1');
  const execute = vi.fn(async (_input: ComputerDispatch, session: { resourceId: string }) => ({ resourceId: session.resourceId, state: 'ready' as const, control: 'agent' as const }));
  const handle = createComputerProviderHandler(journal,{ execute },token);
  const input = dispatch();
  expect((await handle(request('invoke',input,'wrong'))).status).toBe(401);
  expect(execute).not.toHaveBeenCalled();
  const response = await handle(request('invoke',input));
  expect(response.status).toBe(200);
  expect((await handle(request('invoke',input))).status).toBe(200);
  const result = await handle(request('receipt',{ sessionId: input.sessionId, commandId: input.commandId, revision: 1 }));
  expect(await result.json()).toMatchObject({ status: 'done', receipt: { state: 'ready' } });
  expect(execute).toHaveBeenCalledOnce();
  expect((await handle(request('receipt',{ sessionId: 'other', commandId: input.commandId, revision: 1 }))).status).toBe(200);
  expect((await handle(request('invoke',{ ...input, owner: 'forged' }))).status).toBe(400);
  journal.close();
});

it('bounds shell execution to a nonprivileged disposable container and never passes a host shell', async () => {
  const journal = new ComputerProviderJournal(':memory:','v1');
  const input = dispatch();
  const claimed = journal.claim(input); if (!('session' in claimed)) throw new Error('Invalid provider request');
  const resource = claimed.session.resourceId;
  const inspect = JSON.stringify([{ Config: { Image: 'qingzhou-computer:local', Labels: {} }, Mounts: [], State: { Running: true } }]);
  const run = vi.fn<DockerRunner>().mockImplementation(async args => {
    if (args[1] === 'inspect') return { code: 1, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const driver = new DockerComputerDriver('qingzhou-computer:local','none',run);
  // Existing unlabeled containers cannot be adopted.
  run.mockResolvedValueOnce({ code: 0, stdout: inspect, stderr: '' });
  await expect(driver.execute(input,claimed.session,new AbortController().signal)).rejects.toThrow('DOCKER_RESOURCE_MISMATCH');
  const { createHash } = await import('node:crypto');
  const label = createHash('sha256').update(input.sessionId).digest('hex');
  run.mockImplementation(async args => args[1] === 'inspect' ? { code: 0, stdout: JSON.stringify([{ Config: { Image: 'qingzhou-computer:local', Labels: { 'io.qingzhou.computer':label } }, Mounts: [{ Type:'volume',Name:`${resource}-data`,Destination:'/workspace' }], State: { Running:true } }]), stderr: '' } : { code:0,stdout:'result',stderr:'' });
  const command = 'echo $(cat /host/private); echo `whoami`';
  await driver.execute({ ...input, actor: 'agent', command: { kind:'shell', command, timeoutMs:1000 } },{ ...claimed.session,state:'ready' },new AbortController().signal);
  const args = run.mock.calls.at(-1)![0];
  expect(args).toEqual(expect.arrayContaining(['run','--rm','--user','1000:1000','--read-only','--cap-drop','ALL','/usr/bin/timeout']));
  expect(args.at(-1)).toBe(command);
  expect(args).not.toContain('--privileged');
  expect(args.join(' ')).not.toMatch(/docker\.sock|apiKey|provider-test-token/);
  journal.close();
});

it('keeps escaped output within the wire budget so the durable receipt remains readable', async () => {
  const journal = new ComputerProviderJournal(':memory:','v1');
  const handle = createComputerProviderHandler(journal,{ execute:async (_input, session) => ({ resourceId:session.resourceId,state:'ready',control:'agent',stdout:'\0'.repeat(60000),stderr:'\n'.repeat(60000) }) },token);
  const input = dispatch();
  const response = await handle(request('invoke',input));
  expect(response.status).toBe(200);
  const raw = await response.text(); expect(Buffer.byteLength(raw)).toBeLessThan(150000);
  expect(JSON.parse(raw).stdout).toContain('truncated for transport');
  const lookup = await handle(request('receipt',{ sessionId:input.sessionId,commandId:input.commandId,revision:1 }));
  expect(Buffer.byteLength(await lookup.text())).toBeLessThan(150000);
  journal.close();
});

it('creates one owned persistent workspace and verifies non-root access without recreating it on wake', async () => {
  const journal = new ComputerProviderJournal(':memory:','v1');
  const input = dispatch(); const claimed = journal.claim(input); if (!('session' in claimed)) throw new Error('Missing session');
  const { createHash } = await import('node:crypto');
  const label = createHash('sha256').update(input.sessionId).digest('hex');
  let created = false, running = false;
  const run = vi.fn<DockerRunner>().mockImplementation(async args => {
    if (args[0] === 'volume' && args[1] === 'inspect') return { code:1,stdout:'',stderr:'' };
    if (args[0] === 'container' && args[1] === 'inspect') return created ? { code:0,stdout:JSON.stringify([{ Config:{ Image:'qingzhou-computer:local',Labels:{ 'io.qingzhou.computer':label } },Mounts:[{ Type:'volume',Name:`${claimed.session.resourceId}-data`,Destination:'/workspace' }],State:{ Running:running } }]),stderr:'' } : { code:1,stdout:'',stderr:'' };
    if (args[1] === 'create' && args[0] === 'container') created = true;
    if (args[1] === 'start') running = true;
    return { code:0,stdout:'',stderr:'' };
  });
  const driver = new DockerComputerDriver('qingzhou-computer:local','none',run);
  const receipt = await driver.execute(input,claimed.session,new AbortController().signal);
  await driver.execute({ ...input,command:{ kind:'wake' } },{ ...claimed.session,state:'sleeping' },new AbortController().signal);
  expect(receipt.state).toBe('ready');
  expect(run.mock.calls.filter(([args]) => args[0] === 'container' && args[1] === 'create')).toHaveLength(1);
  expect(run.mock.calls.some(([args]) => args.includes('--pull=never'))).toBe(true);
  expect(run.mock.calls.filter(([args]) => args[1] === 'exec').every(([args]) => args.includes('1000:1000'))).toBe(true);
  journal.close();
});
