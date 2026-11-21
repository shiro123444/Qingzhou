import { createHash } from 'node:crypto';

import { z } from 'zod';

import type {
  BrowserFrame,
  ComputerActor,
  ComputerCommand,
  ComputerReceipt,
} from '@/types/agentComputer';

const output = z
  .string()
  .max(65536)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 65536);
export const computerReceiptSchema = z
  .object({
    resourceId: z.string().min(1).max(256),
    state: z.enum(['ready', 'sleeping']),
    control: z.enum(['agent', 'human']),
    exitCode: z.number().int().optional(),
    stdout: output.optional(),
    stderr: output.optional(),
  })
  .strict();

export class ComputerError extends Error {
  constructor(
    public readonly code:
      | 'DISABLED'
      | 'NOT_FOUND'
      | 'BUSY'
      | 'STALE'
      | 'CONTROL_DENIED'
      | 'OUTCOME_UNKNOWN'
      | 'REQUEST_CONFLICT'
      | 'CANCELLED'
      | 'PROVIDER_CHANGED'
      | 'INVALID_RESPONSE'
      | 'AUTHORITY_REQUIRED',
  ) {
    super(`COMPUTER_${code}`);
  }
}
export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ComputerDispatch {
  actor: ComputerActor;
  command: ComputerCommand;
  commandId: string;
  expiresAt: string;
  resourceId?: string;
  revision: number;
  sessionId: string;
}
export interface ComputerProvider {
  execute: (dispatch: ComputerDispatch, signal: AbortSignal) => Promise<ComputerReceipt>;
  lookup?: (
    identity: { sessionId: string; commandId: string; revision: number },
    signal: AbortSignal,
  ) => Promise<
    { status: 'done'; receipt: ComputerReceipt } | { status: 'pending' | 'unknown' | 'missing' }
  >;
  observe?: (
    identity: { sessionId: string; resourceId: string; revision: number },
    signal: AbortSignal,
  ) => Promise<BrowserFrame>;
}
export interface ComputerProviderRegistration {
  binding: string;
  capabilities: readonly ('lifecycle' | 'control' | 'shell' | 'receipt' | 'browser')[];
  id: string;
  load: () => Promise<ComputerProvider>;
}

/** Deployment-owned selection; no endpoint, credential or provider handle is public. */
export function getComputerProviderRegistration(): ComputerProviderRegistration | undefined {
  if (process.env.QINGZHOU_COMPUTER_ENABLED !== '1') return;
  const endpoint = process.env.QINGZHOU_COMPUTER_ENDPOINT;
  const token = process.env.QINGZHOU_COMPUTER_TOKEN;
  if (!endpoint || !token?.trim() || /[\r\n]/.test(token)) throw new ComputerError('DISABLED');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ComputerError('DISABLED');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new ComputerError('DISABLED');
  const base = url.toString().replace(/\/$/, '');
  return {
    id: 'computer.remote',
    capabilities: ['lifecycle', 'control', 'shell', 'receipt', 'browser'],
    binding: digest(['computer.remote/v1', base]),
    load: async () => {
      const { RemoteComputerProvider } = await import('./remote');
      return new RemoteComputerProvider(base, token);
    },
  };
}
