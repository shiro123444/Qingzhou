import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { type BrowserFrame, browserFrameSchema, type ComputerReceipt } from '@/types/agentComputer';

import type { ComputerDispatch } from '../provider';
import type { ProviderSession } from './journal';

export interface ProcessResult { code: number; stderr: string; stdout: string; }
export type DockerRunner = (args: string[], signal: AbortSignal, outputLimit?: number) => Promise<ProcessResult>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export const runDocker: DockerRunner = (args, signal, outputLimit=65500) => new Promise((resolve, reject) => {
  // Child env is deliberately smaller than the app-augmented ProcessEnv type.
  const env = Object.fromEntries(['PATH','HOME','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])) as NodeJS.ProcessEnv;
  const child = spawn('docker', args, { shell: false, stdio: ['ignore','pipe','pipe'], env, signal });
  const capture = () => {
    const chunks: Buffer[] = []; let length = 0; let truncated = false;
    return { add(chunk: Buffer) { const remaining = outputLimit - length; if (chunk.length > remaining) truncated = true; if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); length += Math.min(remaining, chunk.length); } }, read() { let text = Buffer.concat(chunks).toString('utf8'); while (Buffer.byteLength(text) > outputLimit) text = text.slice(0,-1); return text + (truncated ? '\n[output truncated]' : ''); } };
  };
  const out = capture(), err = capture();
  child.stdout.on('data', chunk => out.add(chunk)); child.stderr.on('data', chunk => err.add(chunk));
  child.once('error', () => reject(new Error('DOCKER_PROCESS_UNAVAILABLE')));
  child.once('close', (code, killed) => killed ? reject(new Error('DOCKER_PROCESS_INTERRUPTED')) : resolve({ code: code ?? -1, stdout: out.read(), stderr: err.read() }));
});

/** Shell input is always a container argument, never a host shell command. */
export class DockerComputerDriver {
  readonly binding: string;
  constructor(private readonly image: string, private readonly network = 'none', private readonly run: DockerRunner = runDocker) {
    if (!/^[a-z0-9][\w./:@-]{0,250}$/i.test(image) || !/^[a-z0-9][\w.-]{0,100}$/i.test(network)) throw new Error('DOCKER_CONFIG_INVALID');
    this.binding = hash(JSON.stringify({ image, network, version: 1 }));
  }
  private restrictions(volume: string): string[] {
    return ['--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','256','--memory','1g','--cpus','1','--network',this.network,'--tmpfs','/tmp:rw,nosuid,noexec,size=134217728','--mount',`type=volume,source=${volume},target=/workspace`];
  }
  private async inspect(resource: string, sessionId: string, signal: AbortSignal) {
    const result = await this.run(['container','inspect', resource], signal);
    if (result.code !== 0) return;
    let item;
    try { [item] = JSON.parse(result.stdout); } catch { throw new Error('DOCKER_INSPECT_INVALID'); }
    const labels = item?.Config?.Labels;
    if (labels?.['io.qingzhou.computer'] !== hash(sessionId) || item.Config.Image !== this.image || !item.Mounts?.some((mount: { Type: string; Name: string; Destination: string }) => mount.Type === 'volume' && mount.Name === `${resource}-data` && mount.Destination === '/workspace')) throw new Error('DOCKER_RESOURCE_MISMATCH');
    return item as { State: { Running: boolean } };
  }
  private async required(args: string[], signal: AbortSignal) { const result = await this.run(args, signal); if (result.code !== 0) throw new Error('DOCKER_OPERATION_FAILED'); return result; }
  private async verifyWorkspace(resource: string, signal: AbortSignal) {
    await this.required(['container','exec','--user','1000:1000',resource,'node','-e',"const fs=require('node:fs'); fs.accessSync('/workspace',fs.constants.W_OK); fs.mkdirSync('/workspace/.browser-profile',{recursive:true});"],signal);
  }
  async observe(identity: {sessionId:string;resourceId:string;revision:number}, signal:AbortSignal): Promise<BrowserFrame> {
    const current=await this.inspect(identity.resourceId,identity.sessionId,signal);
    if(!current?.State.Running) throw new Error('DOCKER_RESOURCE_NOT_RUNNING');
    const result=await this.run(['container','exec','--user','1000:1000',identity.resourceId,'node','/opt/qingzhou/browser-client.mjs',JSON.stringify({action:'observe'})],signal,400000);
    if(result.code!==0)throw new Error('BROWSER_OBSERVATION_FAILED');
    return browserFrameSchema.parse(JSON.parse(result.stdout));
  }
  async execute(dispatch: ComputerDispatch, session: ProviderSession, signal: AbortSignal): Promise<ComputerReceipt> {
    const resource = session.resourceId, volume = `${resource}-data`;
    if (resource !== `qz-cmp-${hash(JSON.stringify(dispatch.sessionId)).slice(0,32)}`) throw new Error('DOCKER_RESOURCE_INVALID');
    let current = await this.inspect(resource, dispatch.sessionId, signal);
    if (dispatch.command.kind === 'ensure') {
      if (session.state === 'new') {
        // Never adopt an orphan after losing the provider ledger or silently reset a workspace.
        if (current || (await this.run(['volume','inspect',volume], signal)).code === 0) throw new Error('DOCKER_ORPHAN_REQUIRES_REVIEW');
        await this.required(['volume','create','--label',`io.qingzhou.computer=${hash(dispatch.sessionId)}`,volume], signal);
        await this.required(['container','create','--pull=never','--name',resource,'--label',`io.qingzhou.computer=${hash(dispatch.sessionId)}`,...this.restrictions(volume),this.image,'node','/opt/qingzhou/idle.mjs'], signal);
        current = await this.inspect(resource, dispatch.sessionId, signal);
      }
      if (!current) throw new Error('DOCKER_RESOURCE_MISSING');
      if (!current.State.Running) await this.required(['container','start',resource], signal);
      await this.verifyWorkspace(resource,signal);
      return { resourceId: resource, state: 'ready', control: session.control };
    }
    if (!current) throw new Error('DOCKER_RESOURCE_MISSING');
    if (dispatch.command.kind === 'wake') {
      if (!current.State.Running) await this.required(['container','start',resource],signal);
      await this.verifyWorkspace(resource,signal);
      return { resourceId: resource, state: 'ready', control: session.control };
    }
    if (dispatch.command.kind === 'sleep') {
      if (current.State.Running) await this.required(['container','stop','--time','6',resource],signal);
      return { resourceId: resource, state: 'sleeping', control: session.control };
    }
    if (!current.State.Running) throw new Error('DOCKER_RESOURCE_NOT_RUNNING');
    if (dispatch.command.kind === 'control') return { resourceId: resource, state: 'ready', control: dispatch.command.target };
    if(dispatch.command.kind==='browser') {
      const result=await this.required(['container','exec','--user','1000:1000',resource,'node','/opt/qingzhou/browser-client.mjs',JSON.stringify(dispatch.command.input)],signal);
      const outcome=JSON.parse(result.stdout) as {ok:boolean;error?:string};
      return {resourceId:resource,state:'ready',control:session.control,exitCode:outcome.ok?0:1,...(!outcome.ok?{stderr:'BROWSER_NAVIGATION_FAILED'}:{})};
    }
    const task = `${resource}-cmd-${hash(dispatch.commandId).slice(0,16)}`;
    // PID 1 exiting terminates background descendants too. Workspace persists separately.
    const seconds = Math.max(0.1, Math.min(dispatch.command.timeoutMs, Date.parse(dispatch.expiresAt) - Date.now(), 30000) / 1000);
    try {
      const result = await this.run(['container','run','--pull=never','--rm','--name',task,'--label',`io.qingzhou.computer=${hash(dispatch.sessionId)}`,...this.restrictions(volume),this.image,'/usr/bin/timeout','--signal=KILL',`${seconds}s`,'/bin/sh','-lc',dispatch.command.command], signal);
      if (result.code < 0 || [125,126,127].includes(result.code)) throw new Error('DOCKER_EXECUTION_UNCERTAIN');
      return { resourceId: resource, state: 'ready', control: session.control, exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
    } catch {
      await this.run(['container','rm','--force',task], AbortSignal.timeout(5000)).catch(() => undefined);
      throw new Error('DOCKER_EXECUTION_UNCERTAIN');
    }
  }
}
