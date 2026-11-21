import { createHash, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { browserFrameSchema, computerCommandSchema } from '@/types/agentComputer';

import { type ComputerDispatch,computerReceiptSchema } from '../provider';
import type { DockerComputerDriver } from './driver';
import type { ComputerProviderJournal} from './journal';
import { ProviderJournalError } from './journal';

const identity = { sessionId: z.string().min(1).max(256), commandId: z.string().min(1).max(256), revision: z.number().int().min(1) };
const dispatchSchema = z.object({ ...identity, resourceId: z.string().min(1).max(256).optional(), expiresAt: z.string().datetime(), actor: z.enum(['agent','human']), command: computerCommandSchema }).strict();
const lookupSchema = z.object(identity).strict();
const consoleSchema=z.object({sessionId:identity.sessionId,revision:identity.revision,resourceId:z.string().min(1).max(256)}).strict();
const sha = (value: string) => createHash('sha256').update(value).digest();

// JSON escaping can expand a bounded raw string sixfold; keep both receipts transportable.
function transportOutput(value: string | undefined) {
  if (value === undefined || Buffer.byteLength(JSON.stringify(value)) <= 60000) return value;
  const marker = '\n[output truncated for transport]';
  let low = 0, high = value.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (Buffer.byteLength(JSON.stringify(value.slice(0,middle) + marker)) <= 60000) low = middle; else high = middle - 1; }
  if (low && /[\uD800-\uDBFF]/.test(value[low-1])) low--;
  return value.slice(0,low) + marker;
}

/** Importing this handler never listens on a socket or starts Docker. */
export function createComputerProviderHandler(journal: ComputerProviderJournal, driver: Pick<DockerComputerDriver, 'execute'> & Partial<Pick<DockerComputerDriver,'observe'>>, token: string) {
  if (token.length < 24 || /[\r\n]/.test(token)) throw new Error('COMPUTER_PROVIDER_TOKEN_INVALID');
  return async (request: Request): Promise<Response> => {
    const respond = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
    if (!timingSafeEqual(sha(request.headers.get('authorization') ?? ''), sha(`Bearer ${token}`))) return respond({ code: 'UNAUTHORIZED' },401);
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || !['/v1/computer/invoke','/v1/computer/receipt','/v1/computer/frame'].includes(path)) return respond({ code: 'NOT_FOUND' },404);
    let raw: unknown;
    try {
      if (Number(request.headers.get('content-length')) > 100000) throw new Error('Invalid provider request');
      if (!request.body) throw new Error('Invalid provider request');
      const reader = request.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
      try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 100000) throw new Error('Invalid provider request'); chunks.push(value); } }
      finally { await reader.cancel().catch(() => undefined); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return respond({ code: 'INVALID_REQUEST' },400); }
    if(path.endsWith('/frame')) {
      const parsed=consoleSchema.safeParse(raw);
      if(!parsed.success)return respond({code:'INVALID_REQUEST'},400);
      try {
        journal.consoleSession(parsed.data);
        if(!driver.observe)return respond({code:'BROWSER_UNAVAILABLE'},503);
        const frame=browserFrameSchema.parse(await driver.observe(parsed.data,AbortSignal.timeout(10000)));
        journal.consoleSession(parsed.data);
        return respond({...parsed.data,frame});
      }catch{return respond({code:'STALE_OR_UNAVAILABLE'},409);}
    }
    if (path.endsWith('/receipt')) {
      const parsed = lookupSchema.safeParse(raw);
      if (!parsed.success) return respond({ code: 'INVALID_REQUEST' },400);
      const id = parsed.data;
      try { return respond({ ...id, ...journal.lookup(id.sessionId, id.commandId, id.revision) }); } catch { return respond({ code: 'PROVIDER_UNAVAILABLE' },503); }
    }
    const parsed = dispatchSchema.safeParse(raw);
    if (!parsed.success) return respond({ code: 'INVALID_REQUEST' },400);
    const dispatch: ComputerDispatch = parsed.data;
    let claimed = false;
    try {
      const accepted = journal.claim(dispatch);
      if ('cached' in accepted) return respond({ sessionId: dispatch.sessionId, commandId: dispatch.commandId, revision: dispatch.revision, ...accepted.cached });
      claimed = true;
      const deadline = Math.max(1, Math.min(30000, Date.parse(dispatch.expiresAt) - Date.now()));
      // A disconnected HTTP client does not cancel an accepted action. Receipt stays queryable.
      const signal = AbortSignal.timeout(deadline);
      const rawReceipt = await driver.execute(dispatch, accepted.session, signal);
      const receipt = computerReceiptSchema.parse({ ...rawReceipt, stdout: transportOutput(rawReceipt.stdout), stderr: transportOutput(rawReceipt.stderr) });
      signal.throwIfAborted();
      if (receipt.resourceId !== accepted.session.resourceId || receipt.control !== (dispatch.command.kind === 'control' ? dispatch.command.target : accepted.session.control) || receipt.state !== (dispatch.command.kind === 'sleep' ? 'sleeping' : 'ready') || (dispatch.command.kind === 'shell' && receipt.exitCode === undefined)) throw new Error('INVALID_RECEIPT');
      journal.finish(dispatch, receipt);
      return respond({ sessionId: dispatch.sessionId, commandId: dispatch.commandId, revision: dispatch.revision, ...receipt });
    } catch (error) {
      if (claimed) journal.fail(dispatch);
      if (error instanceof ProviderJournalError) return respond({ code: error.code }, error.code === 'INVALID' ? 400 : 409);
      return respond({ code: 'OUTCOME_UNKNOWN' },503);
    }
  };
}
