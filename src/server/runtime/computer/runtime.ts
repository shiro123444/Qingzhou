import { z } from 'zod';

import type { LobeChatDatabase } from '@/database/type';
import {
  type ComputerActor,
  type ComputerCommand,
  computerCommandSchema,
  type ComputerReceipt,
  type ComputerScope,
} from '@/types/agentComputer';

import { withComputerProvider } from './host';
import {
  ComputerError,
  type ComputerProviderRegistration,
  computerReceiptSchema,
} from './provider';
import { ComputerStore } from './store';

export interface ComputerAuthority {
  actor: ComputerActor;
  assertHeld?: () => void;
  /** Required trusted policy/approval boundary; never supplied through tool arguments. */
  authorize: (command: ComputerCommand) => Promise<void>;
  signal?: AbortSignal;
}
/** Bound to an owned assistant and trusted caller, independently of any browser page. */
export class NativeComputerRuntime {
  readonly store: ComputerStore;
  constructor(
    db: LobeChatDatabase,
    scope: ComputerScope,
    private readonly registration: ComputerProviderRegistration,
    private readonly authority: ComputerAuthority,
  ) {
    this.store = new ComputerStore(db, scope, registration.binding);
  }
  async execute(
    input: unknown,
    requestId: string,
    expectedRevision?: number,
  ): Promise<ComputerReceipt> {
    const command = computerCommandSchema.parse(input);
    const capability =
      command.kind === 'browser'
        ? 'browser'
        : command.kind === 'shell'
          ? 'shell'
          : command.kind === 'control'
            ? 'control'
            : 'lifecycle';
    if (!this.registration.capabilities.includes(capability))
      throw new ComputerError('CONTROL_DENIED');
    z.string().min(1).max(200).parse(requestId);
    if (typeof this.authority.authorize !== 'function')
      throw new ComputerError('AUTHORITY_REQUIRED');
    const check = () => {
      this.authority.signal?.throwIfAborted();
      this.authority.assertHeld?.();
    };
    check();
    await this.authority.authorize(command);
    check();
    const accepted = await this.store.claim(
      command,
      this.authority.actor,
      requestId,
      expectedRevision,
    );
    if ('cached' in accepted) return accepted.cached;
    const lease = accepted.lease;
    const controller = new AbortController();
    const timeout = Math.max(
      1,
      Math.min(
        30000,
        command.kind === 'shell' ? command.timeoutMs : 30000,
        Date.parse(lease.expiresAt) - Date.now(),
      ),
    );
    const timer = setTimeout(() => controller.abort(new ComputerError('OUTCOME_UNKNOWN')), timeout);
    const signal = this.authority.signal
      ? AbortSignal.any([controller.signal, this.authority.signal])
      : controller.signal;
    let onAbort: (() => void) | undefined;
    try {
      const abort = new Promise<never>((_, reject) => {
        onAbort = () => reject(new ComputerError('OUTCOME_UNKNOWN'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      const work = withComputerProvider(this.registration, async (provider) => {
        signal.throwIfAborted();
        check();
        await this.store.dispatch(lease);
        signal.throwIfAborted();
        check();
        const raw = await provider.execute(
          {
            sessionId: lease.sessionId,
            commandId: lease.commandId,
            resourceId: lease.resourceId,
            revision: lease.revision,
            expiresAt: lease.expiresAt,
            actor: this.authority.actor,
            command,
          },
          signal,
        );
        const receipt = computerReceiptSchema.parse(raw);
        const expectedControl = command.kind === 'control' ? command.target : lease.control;
        if (
          (lease.resourceId && receipt.resourceId !== lease.resourceId) ||
          (expectedControl && receipt.control !== expectedControl) ||
          (command.kind === 'sleep' ? receipt.state !== 'sleeping' : receipt.state !== 'ready') ||
          (command.kind === 'shell' && receipt.exitCode === undefined)
        )
          throw new ComputerError('INVALID_RESPONSE');
        signal.throwIfAborted();
        check();
        await this.store.finish(lease, receipt);
        return receipt;
      });
      return await Promise.race([work, abort]);
    } catch (error) {
      await this.store.fail(lease);
      if (error instanceof ComputerError) throw error;
      throw new ComputerError('OUTCOME_UNKNOWN');
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
  async reconcile(commandId: string): Promise<'done' | 'pending' | 'unknown' | 'missing'> {
    if (this.authority.actor !== 'human' || !this.registration.capabilities.includes('receipt'))
      throw new ComputerError('CONTROL_DENIED');
    const identity = await this.store.receiptIdentity(commandId);
    const timeout = AbortSignal.timeout(5000);
    const signal = this.authority.signal
      ? AbortSignal.any([timeout, this.authority.signal])
      : timeout;
    const result = await withComputerProvider(this.registration, async (provider) => {
      if (!provider.lookup) throw new ComputerError('DISABLED');
      return provider.lookup(identity, signal);
    });
    signal.throwIfAborted();
    if (result.status === 'done')
      await this.store.reconcile(
        commandId,
        identity.revision,
        computerReceiptSchema.parse(result.receipt),
      );
    return result.status;
  }
}
