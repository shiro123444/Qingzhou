import { acquireAccountDataLease, ownedLearningDirectory } from '../learning-lifecycle/files';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AtomicInvocation } from '../atomic-runtime';
import { BoundedSerialImprovement } from '../improvement/serial';
import {
  trialDigest,
  trialJson,
  type TrialRequest,
  trialRequestSchema,
} from './trial-configuration';
import type { TrialProposalContext } from './trial-proposal';
import { captureTrialRound } from './trial-round-evidence';
import type {
  RepresentativeTrialRunner,
  TrialConfigurationSnapshot,
  TrialRunReport,
} from './trial-runner';

export const SERIAL_TRIAL_BUDGET = Object.freeze({
  maxProposals: 2,
  maxProbes: 2,
  maxRenders: 5,
  maxEvaluations: 2,
  maxTokens: 96000,
  maxCostMicros: 4000000,
  maxDurationMs: 360000,
  maxSnapshotBytes: 8 * 1024 * 1024,
  maxArtifactBytes: 8 * 1024 * 1024,
});
export interface SerialTrialContext {
  baseline?: TrialConfigurationSnapshot;
  experiences?: NonNullable<TrialRunReport['proposal']>['experiences'];
  id: string;
  incumbent?: {
    policy: NonNullable<TrialProposalContext['incumbentPolicy']>;
    page: { svg: string; notes?: string };
  };
  priorAttempt?: TrialProposalContext['priorAttempt'];
  round: 1 | 2;
}
/** File evidence remains domain-owned; the shared coordinator never sees SVGs or evaluation details. */
export class SerialPresentationTrialRunner {
  private engines: BoundedSerialImprovement<TrialRunReport, SerialTrialContext['incumbent']>[] = [];
  private runners: Pick<RepresentativeTrialRunner, 'run' | 'drain'>[] = [];
  constructor(
    private readonly options: {
      root: string;
      createRunner: (
        context: SerialTrialContext,
      ) => Promise<Pick<RepresentativeTrialRunner, 'run' | 'drain'>>;
    },
  ) {}
  async run(
    input: TrialRequest,
    invocation: Pick<AtomicInvocation, 'scope' | 'signal' | 'onEvent'>,
  ): Promise<TrialRunReport> {
    const directory = ownedLearningDirectory(
      invocation.scope.userId,
      this.options.root,
      trialDigest(invocation.scope.userId),
    );
    const lease = await acquireAccountDataLease(directory, invocation.signal);
    try {
      return await this.runOwned(input, invocation);
    } finally {
      void this.drain().then(
        () => lease?.release(),
        () => lease?.release(),
      );
    }
  }

  private async runOwned(
    input: TrialRequest,
    invocation: Pick<AtomicInvocation, 'scope' | 'signal' | 'onEvent'>,
  ): Promise<TrialRunReport> {
    const request = trialRequestSchema.parse(input);
    if (request.candidates.length !== 1 || Object.keys(request.candidates[0].patch).length)
      throw Object.assign(new Error('Invalid serial request'), { code: 'PRESENTATION_INVALID' });
    const signal = invocation.signal ?? new AbortController().signal;
    const id = randomUUID();
    let priorAttempt: SerialTrialContext['priorAttempt'];
    let retained: SerialTrialContext['incumbent'];
    let baseline: SerialTrialContext['baseline'];
    let experiences: SerialTrialContext['experiences'];
    const reports: TrialRunReport[] = [];
    const counts = (report: TrialRunReport) => ({
      proposals: report.calls.filter((call) => call.operation === 'trials.propose').length,
      probes: report.calls.filter((call) => call.operation === 'trials.probe').length,
      renders: report.calls.filter((call) => call.operation === 'trials.render').length,
      evaluations: report.calls.filter((call) => call.operation === 'trials.evaluate').length,
    });
    const engine = new BoundedSerialImprovement<TrialRunReport, SerialTrialContext['incumbent']>({
      domain: 'presentation',
      budget: {
        tokens: SERIAL_TRIAL_BUDGET.maxTokens,
        costMicros: SERIAL_TRIAL_BUDGET.maxCostMicros,
        proposals: 2,
        probes: 2,
        renders: 5,
        evaluations: 2,
      },
      roundAllowance: {
        tokens: 48000,
        costMicros: 2000000,
        proposals: 1,
        probes: 1,
        renders: 3,
        evaluations: 1,
      },
      incumbent: () => retained,
      run: async (round, incumbent, signal) => {
        const runner = await this.options.createRunner({
          id,
          round,
          incumbent,
          priorAttempt,
          baseline,
          experiences,
        });
        this.runners.push(runner);
        const report = await runner.run(
          {
            ...request,
            candidates: incumbent
              ? [
                  { id: 'incumbent', patch: {} },
                  { id: 'candidate', patch: {} },
                ]
              : [{ id: 'candidate', patch: {} }],
          },
          { ...invocation, signal },
        );
        reports.push(report);
        if (round === 1 && report.status === 'completed') {
          const variants = await captureTrialRound(report);
          baseline = variants.find((variant) => variant.id === 'baseline')?.configuration;
          if (!baseline) throw new Error('Missing frozen baseline');
          experiences = structuredClone(report.proposal?.experiences ?? []);
          const selected = variants.find((variant) => variant.id === report.selectedId);
          if (report.selectedId !== 'baseline' && selected?.configuration?.policy && selected.plan)
            retained = {
              policy: selected.configuration.policy,
              page: { svg: selected.plan.slides[0].svg, notes: selected.plan.slides[0].notes },
            };
          const attempted = variants.find((variant) => variant.id !== 'baseline');
          if (attempted?.plan)
            priorAttempt = {
              policy: attempted.configuration?.policy,
              svg: attempted.plan.slides[0].svg,
              notes: attempted.plan.slides[0].notes,
            };
        }
        return {
          counts: counts(report),
          usage: { tokens: report.charged.tokens, costMicros: report.charged.costMicros },
          result: report,
          status: report.status === 'partial' ? ('failed' as const) : report.status,
        };
      },
    });
    this.engines.push(engine);
    const summary = await engine.run(signal, (round, charged) =>
      invocation.onEvent?.({
        name: 'trials.serial',
        operationId: `${id}-${round}`,
        pluginVersion: 'bounded-serial-v1',
        timestamp: new Date().toISOString(),
        state: 'completed',
        jobId: id,
        detail: JSON.stringify({ round, ...charged }),
      }),
    );
    // A cancelled child may settle just after the coordinator; archive its partial evidence too.
    await engine.drain();
    const selected = summary.rounds[summary.selectedRound - 1]?.result;
    const base: TrialRunReport =
      selected && summary.status === 'completed'
        ? structuredClone(selected)
        : {
            runId: id,
            schemaVersion: 1,
            originalRetained: true,
            selectedId: 'baseline',
            calls: [],
            charged: summary.charged,
            status: summary.status,
            errorCode:
              summary.status === 'budget-exceeded'
                ? 'TRIAL_BUDGET'
                : summary.status === 'cancelled'
                  ? 'TRIAL_CANCELLED'
                  : summary.status === 'deadline-exceeded'
                    ? 'TRIAL_DEADLINE'
                    : 'TRIAL_EXECUTION_FAILED',
            variants: [],
          };
    const account = ownedLearningDirectory(
      invocation.scope.userId,
      this.options.root,
      trialDigest(invocation.scope.userId),
    );
    await mkdir(account, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(account, 'serial-'));
    if (selected && summary.status === 'completed') {
      // Verify every artifact before copying it into a new immutable final run. Child runs are never rewritten.
      const captured = await captureTrialRound(selected);
      if (
        captured.length !== selected.variants.length ||
        captured.some((variant) => !variant.configuration || !variant.plan || !variant.preview)
      )
        throw Object.assign(new Error('Incomplete serial evidence'), {
          code: 'TRIAL_EXECUTION_FAILED',
        });
      for (const [index, variant] of captured.entries()) {
        await writeFile(
          path.join(directory, `configuration-${index}.json`),
          trialJson(variant.configuration),
          { flag: 'wx', mode: 0o600 },
        );
        await writeFile(path.join(directory, `plan-${index}.json`), trialJson(variant.plan), {
          flag: 'wx',
          mode: 0o600,
        });
        await writeFile(
          path.join(directory, `preview-${index}.png`),
          Buffer.from(variant.preview!, 'base64'),
          { flag: 'wx', mode: 0o600 },
        );
        base.variants[index].preview = {
          ...base.variants[index].preview!,
          file: path.join(directory, `preview-${index}.png`),
        };
      }
      if (base.comparison) base.comparison.trialId = id;
    }
    base.charged = summary.charged;
    base.calls = reports.flatMap((report) => report.calls);
    base.runId = id;
    base.directory = directory;
    base.improvement = {
      protocol: 'bounded-serial-v1',
      budget: SERIAL_TRIAL_BUDGET,
      charged: summary.charged,
      selectedRound: summary.selectedRound,
      rounds: reports,
    };
    await writeFile(path.join(directory, 'report.json'), trialJson(base), {
      flag: 'wx',
      mode: 0o600,
    });
    return base;
  }
  async drain() {
    await Promise.all(this.engines.map((engine) => engine.drain()));
    await Promise.all(this.runners.map((runner) => runner.drain()));
  }
}
