import {
  harnessDigest,
  type LearningBudgetRef,
  type LearningScope,
  type LearningUsage,
} from '@lobechat/agent-runtime';

export interface LearningAttempt {
  childId: string;
  measured?: Partial<Omit<LearningUsage, 'calls'>>;
  requestHash: string;
  reserved: LearningUsage;
  state: 'reserved' | 'completed' | 'unknown';
}
export interface LearningBudgetState {
  attempts: Record<string, LearningAttempt>;
  cancelled: boolean;
  children: Record<string, { limit: LearningUsage }>;
  exhausted: boolean;
  limit: LearningUsage;
  rootId: string;
  scope: LearningScope;
}
export interface LearningBudgetPort {
  allocate: (ref: LearningBudgetRef, limit: LearningUsage) => Promise<void>;
  cancel: (scope: LearningScope, rootId: string) => Promise<void>;
  open: (scope: LearningScope, rootId: string, limit: LearningUsage) => Promise<void>;
  read: (scope: LearningScope, rootId: string) => Promise<LearningBudgetState>;
  reserve: (
    ref: LearningBudgetRef,
    requestId: string,
    requestHash: string,
    usage: LearningUsage,
  ) => Promise<void>;
  settle: (
    ref: LearningBudgetRef,
    requestId: string,
    state: 'completed' | 'unknown',
    measured?: LearningAttempt['measured'],
  ) => Promise<void>;
}
export const learningBudgetError = (code: string) => Object.assign(new Error(code), { code });
export function assertLearningUsage(value: LearningUsage) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'calls,costMicros,tokens' ||
    !Object.values(value).every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    throw learningBudgetError('LEARNING_BUDGET_INVALID');
}
export const addLearningUsage = (a: LearningUsage, b: LearningUsage): LearningUsage => ({
  calls: a.calls + b.calls,
  tokens: a.tokens + b.tokens,
  costMicros: a.costMicros + b.costMicros,
});
export const exceedsLearningUsage = (a: LearningUsage, b: LearningUsage) =>
  a.calls > b.calls || a.tokens > b.tokens || a.costMicros > b.costMicros;
export const zeroLearningUsage = (): LearningUsage => ({ calls: 0, tokens: 0, costMicros: 0 });

/** Server-owned capability. Each paid attempt is persisted before dispatch, never replayed here. */
export class LearningBudgetBinding {
  constructor(
    readonly port: LearningBudgetPort,
    readonly ref: LearningBudgetRef,
  ) {}
  async assertActive() {
    const state = await this.port.read(this.ref.scope, this.ref.rootId);
    if (state.cancelled) throw learningBudgetError('LEARNING_BUDGET_CANCELLED');
    if (state.exhausted) throw learningBudgetError('LEARNING_BUDGET_EXCEEDED');
  }
  cancel() {
    return this.port.cancel(this.ref.scope, this.ref.rootId);
  }
  async perform<T>(
    input: {
      id: string;
      request: unknown;
      reserved: LearningUsage;
      signal?: AbortSignal;
      measure?: (value: T) => LearningAttempt['measured'];
    },
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (input.signal?.aborted) {
      await this.cancel();
      input.signal.throwIfAborted();
    }
    await this.port.reserve(this.ref, input.id, await harnessDigest(input.request), input.reserved);
    const controller = new AbortController();
    const cancel = () => {
      void this.cancel().then(
        () => controller.abort(learningBudgetError('LEARNING_BUDGET_CANCELLED')),
        () => controller.abort(learningBudgetError('LEARNING_BUDGET_UNAVAILABLE')),
      );
    };
    input.signal?.addEventListener('abort', cancel, { once: true });
    const poll = setInterval(() => {
      void this.assertActive().catch((error) => controller.abort(error));
    }, 200);
    try {
      await this.assertActive();
      if (input.signal?.aborted) {
        await this.cancel();
        throw learningBudgetError('LEARNING_BUDGET_CANCELLED');
      }
      controller.signal.throwIfAborted();
      const value = await run(controller.signal);
      await this.port.settle(this.ref, input.id, 'completed', input.measure?.(value));
      await this.assertActive();
      controller.signal.throwIfAborted();
      return value;
    } catch (error) {
      await this.port.settle(this.ref, input.id, 'unknown').catch(() => undefined);
      throw error;
    } finally {
      clearInterval(poll);
      input.signal?.removeEventListener('abort', cancel);
    }
  }
}
