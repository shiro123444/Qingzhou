/** The domain adapter owns artifacts and evaluation; this protocol owns admission and cancellation. */
export interface ImprovementUsage {
  costMicros: number;
  tokens: number;
}
export interface ImprovementCounts {
  evaluations: number;
  probes: number;
  proposals: number;
  renders: number;
}
export interface ImprovementStep<Result> {
  counts: ImprovementCounts;
  result: Result;
  status: 'completed' | 'failed' | 'budget-exceeded' | 'cancelled' | 'deadline-exceeded';
  usage: ImprovementUsage;
}
export interface SerialImprovementResult<Result> {
  charged: ImprovementUsage;
  counts: ImprovementCounts;
  rounds: ImprovementStep<Result>[];
  selectedRound: 1 | 2;
  status: ImprovementStep<Result>['status'];
}
const fail = (code: string) => Object.assign(new Error(code), { code });
const valid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Exactly one initial round and at most one serial refinement. No parallel search or retry. */
export class BoundedSerialImprovement<Result, Incumbent> {
  private pending = new Set<Promise<unknown>>();
  constructor(
    private readonly adapter: {
      domain: string;
      budget: ImprovementUsage & ImprovementCounts;
      roundAllowance: ImprovementUsage & ImprovementCounts;
      incumbent: (result: Result) => Incumbent | undefined;
      run: (
        round: 1 | 2,
        incumbent: Incumbent | undefined,
        signal: AbortSignal,
      ) => Promise<ImprovementStep<Result>>;
    },
  ) {
    if (
      !adapter.domain.trim() ||
      !Object.values(adapter.budget).every(valid) ||
      !Object.values(adapter.roundAllowance).every(valid)
    )
      throw fail('IMPROVEMENT_INVALID');
  }
  async run(
    signal: AbortSignal,
    onProgress?: (round: 1 | 2, charged: ImprovementUsage) => void,
  ): Promise<SerialImprovementResult<Result>> {
    const report: SerialImprovementResult<Result> = {
      charged: { tokens: 0, costMicros: 0 },
      counts: { proposals: 0, probes: 0, renders: 0, evaluations: 0 },
      rounds: [],
      selectedRound: 1,
      status: 'failed',
    };
    let incumbent: Incumbent | undefined;
    for (const round of [1, 2] as const) {
      if (signal.aborted) {
        const code = (signal.reason as { code?: string })?.code;
        report.status =
          code === 'TRIAL_DEADLINE' || code === 'IMPROVEMENT_DEADLINE'
            ? 'deadline-exceeded'
            : 'cancelled';
        return report;
      }
      const allowance = this.adapter.roundAllowance;
      if (
        report.charged.tokens + allowance.tokens > this.adapter.budget.tokens ||
        report.charged.costMicros + allowance.costMicros > this.adapter.budget.costMicros ||
        Object.entries(report.counts).some(
          ([key, value]) =>
            value + allowance[key as keyof ImprovementCounts] >
            this.adapter.budget[key as keyof ImprovementCounts],
        )
      ) {
        report.status = 'budget-exceeded';
        break;
      }
      report.charged.tokens += allowance.tokens;
      report.charged.costMicros += allowance.costMicros;
      for (const key of ['proposals', 'probes', 'renders', 'evaluations'] as const)
        report.counts[key] += allowance[key];
      onProgress?.(round, { ...report.charged });
      const task = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return this.adapter.run(round, incumbent, signal);
      });
      this.pending.add(task);
      void task.then(
        () => this.pending.delete(task),
        () => this.pending.delete(task),
      );
      let abort!: () => void;
      let step: ImprovementStep<Result>;
      try {
        step = await Promise.race([
          task,
          new Promise<never>((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          }),
        ]);
        signal.throwIfAborted();
      } catch {
        // Unknown use remains reserved. The caller drains before releasing its shared worker lease.
        const code = (signal.reason as { code?: string })?.code;
        report.status = signal.aborted
          ? code === 'TRIAL_DEADLINE' || code === 'IMPROVEMENT_DEADLINE'
            ? 'deadline-exceeded'
            : 'cancelled'
          : 'failed';
        return report;
      } finally {
        signal.removeEventListener('abort', abort);
      }
      if (!Object.values(step.usage).every(valid) || !Object.values(step.counts).every(valid)) {
        report.status = 'failed';
        break;
      }
      report.rounds.push(step);
      report.charged.tokens += step.usage.tokens - allowance.tokens;
      report.charged.costMicros += step.usage.costMicros - allowance.costMicros;
      for (const key of ['proposals', 'probes', 'renders', 'evaluations'] as const)
        report.counts[key] += step.counts[key] - allowance[key];
      onProgress?.(round, { ...report.charged });
      if (
        Object.entries(step.counts).some(
          ([key, value]) => value > allowance[key as keyof ImprovementCounts],
        ) ||
        step.usage.tokens > allowance.tokens ||
        step.usage.costMicros > allowance.costMicros ||
        report.charged.tokens > this.adapter.budget.tokens ||
        report.charged.costMicros > this.adapter.budget.costMicros ||
        Object.entries(report.counts).some(
          ([key, value]) => value > this.adapter.budget[key as keyof ImprovementCounts],
        )
      ) {
        report.status = 'budget-exceeded';
        break;
      }
      if (
        step.status === 'cancelled' ||
        step.status === 'deadline-exceeded' ||
        step.status === 'budget-exceeded'
      ) {
        report.status = step.status;
        break;
      }
      if (step.status === 'completed') {
        report.status = 'completed';
        report.selectedRound = round;
        incumbent = this.adapter.incumbent(step.result);
      } else if (round === 1) {
        // A failed initial stage is not permission to spend another full round.
        report.status = 'failed';
        break;
      }
    }
    return report;
  }
  async drain() {
    await Promise.allSettled(this.pending);
  }
}
