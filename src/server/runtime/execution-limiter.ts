const cancelled = () =>
  Object.assign(new Error('Operation cancelled while waiting for capacity'), {
    code: 'OPERATION_CANCELLED',
  });

interface WaitingCall {
  abort: () => void;
  reject: (error: Error) => void;
  resolve: (release: () => void) => void;
  signal?: AbortSignal;
}

/** Bounded, cancellable admission for expensive operations within one host. */
export class ExecutionLimiter {
  private active = 0;
  private readonly queue: WaitingCall[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueue: number,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64)
      throw new Error('Concurrency must be between 1 and 64');
    if (!Number.isInteger(maxQueue) || maxQueue < 0 || maxQueue > 4096)
      throw new Error('Queue capacity must be between 0 and 4096');
  }

  snapshot() {
    return { active: this.active, queued: this.queue.length };
  }

  private release() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      while (this.active < this.concurrency && this.queue.length) {
        const next = this.queue.shift()!;
        next.signal?.removeEventListener('abort', next.abort);
        if (next.signal?.aborted) {
          next.reject(cancelled());
          continue;
        }
        this.active++;
        next.resolve(this.release());
      }
    };
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve(this.release());
    }
    if (this.queue.length >= this.maxQueue)
      return Promise.reject(
        Object.assign(new Error('Operation capacity is busy; retry after active work finishes'), {
          code: 'CAPACITY_BUSY',
        }),
      );
    return new Promise((resolve, reject) => {
      const call: WaitingCall = {
        abort: () => {
          const index = this.queue.indexOf(call);
          if (index >= 0) this.queue.splice(index, 1);
          signal?.removeEventListener('abort', call.abort);
          reject(cancelled());
        },
        reject,
        resolve,
        signal,
      };
      this.queue.push(call);
      signal?.addEventListener('abort', call.abort, { once: true });
    });
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      if (signal?.aborted) throw cancelled();
      return await operation();
    } finally {
      release();
    }
  }
}
