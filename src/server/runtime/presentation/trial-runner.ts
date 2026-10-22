import { acquireAccountDataLease, ownedLearningDirectory } from '../learning-lifecycle/files';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { LearningBudgetRef } from '@lobechat/agent-runtime';
import { z } from 'zod';

import type { PresentationPlan, RuntimeScope } from '../../../../packages/runtime-contracts/src';
import { type AtomicInvocation, type AtomicPlugin, type AtomicRuntime } from '../atomic-runtime';
import type { LearningBudgetBinding } from '../improvement/budget';
import type { PresentationArtifactStore } from './artifact-store';
import type { CapabilityCapsule } from './capability-memory';
import type { PresentationJobRepository, StoredPresentationJob } from './file-storage';
import {
  type RepresentativeTrial,
  type RepresentativeTrialSelection,
  selectRepresentativeTrial,
} from './representative-trial';
import { presentationImageRefs } from './revision-assets';
import {
  freezeTrialValue,
  type TrialBudget,
  trialBudgetSchema,
  trialCapsules,
  trialDigest,
  trialJson,
  type TrialRequest,
  trialRequestSchema,
  type TrialSettings,
  trialSettingsSchema,
  type TrialUsage,
  trialUsageSchema,
} from './trial-configuration';
import {
  anonymizeTrialIds,
  type AnonymousTrialContext,
  type AnonymousTrialScores,
  anonymousTrialScoresSchema,
  trialEditableTexts,
} from './trial-evaluation';
import { TRIAL_POLICY_VERSION, type TrialPolicy, trialPolicySchema } from './trial-policy';
import {
  type TrialProposalContext,
  type TrialProposalExperience,
  trialProposalExperiencesSchema,
  trialProposalSchema,
} from './trial-proposal';

const invalid = (code: string) => Object.assign(new Error(code), { code });
const pageSchema = z
  .object({
    svg: z
      .string()
      .min(1)
      .max(10 * 1024 * 1024),
    notes: z.string().optional(),
  })
  .strict();
const probeResultSchema = z.object({ page: pageSchema, usage: trialUsageSchema }).strict();
const renderResultSchema = z
  .object({
    bytes: z.instanceof(Uint8Array),
    usage: trialUsageSchema,
  })
  .strict();

export interface TrialConfigurationSnapshot {
  budget: TrialBudget;
  capsules: CapabilityCapsule[];
  plugins: { id: string; version: string; tools: string[] }[];
  policy?: TrialPolicy;
  schemaVersion: 1;
  settings: TrialSettings;
  source: { jobId: string; versionId: string; slideId: string };
  sourceAssets: {
    ref: string;
    sha256: string;
    mimeType: string;
    base64: string;
    metadata?: Record<string, unknown>;
  }[];
  sourceInput: StoredPresentationJob['input'];
  sourcePlan: PresentationPlan;
}
export interface TrialStageContext {
  allowance: TrialUsage;
  configuration: TrialConfigurationSnapshot;
  configurationFingerprint: string;
  plan: PresentationPlan;
  scope: RuntimeScope;
  signal: AbortSignal;
  workspace: string;
}

/** Trusted adapters receive only a copied plan and a private scratch directory. */
export function createTrialExecutionPlugin(backend: {
  version: string;
  probe: (context: TrialStageContext) => Promise<z.infer<typeof probeResultSchema>>;
  render: (context: TrialStageContext) => Promise<z.infer<typeof renderResultSchema>>;
  evaluate?: (context: AnonymousTrialContext) => Promise<AnonymousTrialScores>;
  propose?: (context: TrialProposalContext) => Promise<{ proposal: unknown; usage: TrialUsage }>;
}): AtomicPlugin {
  const operation = (stage: 'probe' | 'render') => ({
    name: `trials.${stage}`,
    description: `Run an isolated representative-page ${stage} in trusted trial context.`,
    input: z.object({}).strict(),
    execute: async (_: unknown, invocation: AtomicInvocation) => {
      const context = invocation.services?.representativeTrialStage as
        | TrialStageContext
        | undefined;
      if (!context || !invocation.signal) throw invalid('TRIAL_CONTEXT_REQUIRED');
      // Scope and cancellation always come from Cordis, never from a tool argument.
      return backend[stage](
        Object.freeze({
          ...context,
          scope: Object.freeze({ ...invocation.scope }),
          signal: invocation.signal,
        }),
      );
    },
  });
  return {
    id: 'trials',
    version: backend.version,
    operations: [
      operation('probe'),
      operation('render'),
      ...(backend.propose
        ? [
            {
              name: 'trials.propose',
              description: 'Propose one bounded configuration dimension in trusted trial context.',
              input: z.object({}).strict(),
              execute: (_: unknown, invocation: AtomicInvocation) => {
                const context = invocation.services?.representativeTrialProposal as
                  | TrialProposalContext
                  | undefined;
                if (!context || !invocation.signal) throw invalid('TRIAL_CONTEXT_REQUIRED');
                return backend.propose!(
                  Object.freeze({
                    ...context,
                    scope: Object.freeze({ ...invocation.scope }),
                    signal: invocation.signal,
                  }),
                );
              },
            },
          ]
        : []),
      ...(backend.evaluate
        ? [
            {
              name: 'trials.evaluate',
              description:
                'Evaluate anonymized rendered trial cases without configuration identities.',
              input: z.object({}).strict(),
              execute: (_: unknown, invocation: AtomicInvocation) => {
                const context = invocation.services?.representativeTrialEvaluation as
                  | AnonymousTrialContext
                  | undefined;
                if (!context || !invocation.signal) throw invalid('TRIAL_CONTEXT_REQUIRED');
                return backend.evaluate!(
                  Object.freeze({
                    ...context,
                    scope: Object.freeze({ ...invocation.scope }),
                    signal: invocation.signal,
                  }),
                );
              },
            },
          ]
        : []),
    ],
  };
}

export interface TrialRunReport {
  budgetRef?: LearningBudgetRef;
  calls: {
    operation: string;
    variantId?: string;
    status: 'started' | 'completed' | 'failed' | 'cancelled';
    reserved: TrialUsage;
    actual?: TrialUsage;
    elapsedMs: number;
  }[];
  charged: TrialUsage;
  comparison?: RepresentativeTrial;
  conditionFingerprint?: string;
  directory?: string;
  errorCode?: string;
  improvement?: {
    budget: {
      maxTokens: number;
      maxCostMicros: number;
      maxDurationMs: number;
      maxProposals: number;
      maxProbes: number;
      maxRenders: number;
      maxEvaluations: number;
    };
    charged: TrialUsage;
    protocol: 'bounded-serial-v1';
    rounds: TrialRunReport[];
    selectedRound: 1 | 2;
  };
  originalRetained: true;
  proposal?: {
    incumbent?: { policy: TrialPolicy; page: z.infer<typeof pageSchema> };
    priorAttempt?: TrialProposalContext['priorAttempt'];
    version: string;
    status: 'started' | 'accepted' | 'rejected';
    experiences: TrialProposalExperience[];
    output?: unknown;
    result?: z.infer<typeof trialProposalSchema>;
  };
  runId: string;
  schemaVersion: 1;
  selectedId: string;
  selection?: RepresentativeTrialSelection;
  status:
    | 'completed'
    | 'partial'
    | 'failed'
    | 'cancelled'
    | 'deadline-exceeded'
    | 'budget-exceeded';
  variants: {
    id: string;
    status: 'not-started' | 'completed' | 'failed' | 'cancelled';
    configurationFingerprint?: string;
    planSha256?: string;
    preview?: { file: string; sha256: string };
  }[];
}

export class RepresentativeTrialRunner {
  private readonly draining = new Set<Promise<unknown>>();

  constructor(
    private readonly options: {
      runtime: AtomicRuntime;
      repository: Pick<PresentationJobRepository, 'getJob'>;
      artifacts: Pick<PresentationArtifactStore, 'get'>;
      root: string;
      budget: TrialBudget;
      learningBudget?: LearningBudgetBinding;
      publishEvidence?: (scope: RuntimeScope, report: TrialRunReport) => Promise<void>;
      settings: (
        scope: RuntimeScope,
        source: StoredPresentationJob,
      ) => TrialSettings | Promise<TrialSettings>;
      proposalExperiences?: (
        scope: RuntimeScope,
        source: StoredPresentationJob,
        slideId: string,
      ) => Promise<TrialProposalExperience[]>;
      incumbent?: { policy: TrialPolicy; page: z.infer<typeof pageSchema> };
      priorAttempt?: TrialProposalContext['priorAttempt'];
    },
  ) {}

  /** After runs return, wait for abandoned calls before disposing the shared runtime. */
  async drain(): Promise<void> {
    await Promise.all(this.draining);
  }

  async run(
    input: TrialRequest,
    invocation: Pick<AtomicInvocation, 'scope' | 'signal' | 'onEvent'>,
  ): Promise<TrialRunReport> {
    const directory = ownedLearningDirectory(
      invocation.scope.userId,
      path.join(this.options.root, 'runs'),
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
    const budget = trialBudgetSchema.parse(this.options.budget);
    let paidAttempt = 0;
    const scope = z
      .object({ userId: z.string().trim().min(1), sessionId: z.string().trim().min(1) })
      .strict()
      .parse(invocation.scope);
    const controller = new AbortController();
    const signal = controller.signal;
    const cancel = () => controller.abort(invalid('TRIAL_CANCELLED'));
    invocation.signal?.addEventListener('abort', cancel, { once: true });
    if (invocation.signal?.aborted) cancel();
    const timer = setTimeout(
      () => controller.abort(invalid('TRIAL_DEADLINE')),
      budget.maxDurationMs,
    );
    const inFlight = new Set<Promise<unknown>>();
    const releases: (() => void)[] = [];
    const report: TrialRunReport = {
      runId: randomUUID(),
      schemaVersion: 1,
      status: 'failed',
      originalRetained: true,
      selectedId: 'baseline',
      calls: [],
      charged: { tokens: 0, costMicros: 0 },
      ...(this.options.learningBudget ? { budgetRef: this.options.learningBudget.ref } : {}),
      variants: ['baseline', ...request.candidates.map(({ id }) => id)].map((id) => ({
        id,
        status: 'not-started',
      })),
    };
    const active = () => {
      if (signal.aborted) throw signal.reason;
    };
    const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
      active();
      const task = Promise.resolve().then(() => {
        active();
        return operation();
      });
      inFlight.add(task);
      void task.then(
        () => inFlight.delete(task),
        () => inFlight.delete(task),
      );
      let abort!: () => void;
      try {
        return await Promise.race([
          task,
          new Promise<never>((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          }),
        ]);
      } finally {
        signal.removeEventListener('abort', abort);
      }
    };
    const write = async (file: string, value: unknown) => {
      active();
      const text = trialJson(value);
      if (Buffer.byteLength(text) > budget.maxSnapshotBytes)
        throw invalid('TRIAL_SNAPSHOT_TOO_LARGE');
      await guarded(() => writeFile(file, text, { flag: 'wx', mode: 0o600 }));
      active();
    };
    const invoke = async <T>(
      operation: string,
      args: unknown,
      allowance: TrialUsage,
      services?: AtomicInvocation['services'],
      variantId?: string,
    ): Promise<T> => {
      active();
      if (
        report.charged.tokens + allowance.tokens > budget.maxTokens ||
        report.charged.costMicros + allowance.costMicros > budget.maxCostMicros
      )
        throw invalid('TRIAL_BUDGET');
      report.charged.tokens += allowance.tokens;
      report.charged.costMicros += allowance.costMicros;
      const entry: TrialRunReport['calls'][number] = {
        operation,
        variantId,
        reserved: { ...allowance },
        status: 'started',
        elapsedMs: 0,
      };
      report.calls.push(entry);
      const started = performance.now();
      try {
        const dispatch = (dispatchSignal: AbortSignal) =>
          this.options.runtime.invoke<T>(operation, args, {
            scope,
            signal: dispatchSignal,
            services,
            jobId: report.runId,
            onEvent: invocation.onEvent,
          });
        const shared = this.options.learningBudget;
        const paid = ['trials.propose', 'trials.probe', 'trials.evaluate'].includes(operation);
        const result = await guarded(() =>
          shared && paid
            ? shared.perform(
                {
                  id: `${paidAttempt++}:${operation}:${variantId ?? ''}`,
                  request: args,
                  reserved: {
                    calls: 1,
                    tokens: allowance.tokens,
                    costMicros: allowance.costMicros,
                  },
                  signal,
                  measure: (value) => {
                    const usage = (value as { usage?: TrialUsage })?.usage;
                    return usage
                      ? {
                          tokens: usage.tokens,
                          ...(usage.costBasis === 'provider-reported'
                            ? { costMicros: usage.costMicros }
                            : {}),
                        }
                      : undefined;
                  },
                },
                dispatch,
              )
            : dispatch(signal),
        );
        active();
        entry.status = 'completed';
        return result;
      } catch (error) {
        if (error instanceof Error && error.message === 'LEARNING_BUDGET_CANCELLED')
          controller.abort(invalid('TRIAL_CANCELLED'));
        if (error instanceof Error && error.message === 'LEARNING_BUDGET_EXCEEDED')
          throw invalid('TRIAL_BUDGET');
        entry.status = signal.aborted ? 'cancelled' : 'failed';
        throw error;
      } finally {
        entry.elapsedMs = Math.round(performance.now() - started);
      }
    };
    const settleUsage = (usage: TrialUsage, allowance: TrialUsage) => {
      const last = report.calls.at(-1)!;
      last.actual = usage;
      report.charged.tokens -= allowance.tokens - usage.tokens;
      report.charged.costMicros -= allowance.costMicros - usage.costMicros;
      if (usage.tokens > allowance.tokens || usage.costMicros > allowance.costMicros)
        throw invalid('TRIAL_USAGE_EXCEEDED');
    };
    const zero = { tokens: 0, costMicros: 0 };
    try {
      active();
      if (
        request.candidates.length - (this.options.incumbent ? 1 : 0) > budget.maxProbes ||
        request.candidates.length + 1 > budget.maxRenders
      )
        throw invalid('TRIAL_BUDGET');
      const pluginIds = await guarded(() => this.options.runtime.pluginIds());
      for (const id of pluginIds)
        await guarded(async () => {
          releases.push(await this.options.runtime.acquire(id));
        });
      const plugins = (await guarded(() => this.options.runtime.snapshot(scope))).plugins.map(
        ({ id, version, permissions }) => ({ id, version, tools: [...permissions.tools].sort() }),
      );
      if (trialDigest(plugins.map(({ id }) => id).sort()) !== trialDigest(pluginIds))
        throw invalid('TRIAL_PLUGIN_SET_CHANGED');
      const stored = await guarded(() => this.options.repository.getJob(scope, request.jobId));
      if (
        !stored?.plan ||
        stored.job.jobId !== request.jobId ||
        stored.job.state !== 'completed' ||
        stored.job.versionId !== request.expectedVersionId
      )
        throw invalid('TRIAL_SOURCE_UNAVAILABLE');
      const sourceText = trialJson({
        input: stored.input,
        plan: stored.plan,
        job: {
          jobId: stored.job.jobId,
          versionId: stored.job.versionId,
          state: stored.job.state,
          createdAt: stored.job.createdAt,
          updatedAt: stored.job.updatedAt,
        },
      });
      if (Buffer.byteLength(sourceText) > budget.maxSnapshotBytes)
        throw invalid('TRIAL_SNAPSHOT_TOO_LARGE');
      const source = freezeTrialValue(JSON.parse(sourceText) as StoredPresentationJob);
      const sourcePlan = source.plan!;
      const sourceSlide = sourcePlan.slides.find(({ slideId }) => slideId === request.slideId);
      if (!sourceSlide) throw invalid('TRIAL_SOURCE_UNAVAILABLE');
      const settings = trialSettingsSchema.parse(
        await guarded(async () => this.options.settings(scope, source)),
      );
      const incumbent =
        this.options.incumbent &&
        freezeTrialValue({
          policy: trialPolicySchema.parse(this.options.incumbent.policy),
          page: pageSchema.parse(this.options.incumbent.page),
        });
      if (
        incumbent &&
        (!settings.proposal ||
          request.candidates.length !== 2 ||
          request.candidates[0].id !== 'incumbent' ||
          request.candidates.some((item) => Object.keys(item.patch).length))
      )
        throw invalid('TRIAL_PROPOSAL_CONFIGURATION');
      if (settings.models.planner.maxOutputTokens > settings.probeAllowance.tokens)
        throw invalid('TRIAL_BUDGET');
      if (settings.proposal) {
        if (
          settings.proposal.version !== TRIAL_POLICY_VERSION ||
          budget.maxProposals !== 1 ||
          !plugins.some(({ tools }) => tools.includes('trials.propose')) ||
          request.candidates.length !== (incumbent ? 2 : 1) ||
          request.candidates.some((item) => Object.keys(item.patch).length !== 0)
        )
          throw invalid('TRIAL_PROPOSAL_CONFIGURATION');
        const allowances = [
          settings.proposal.allowance,
          settings.probeAllowance,
          settings.evaluation?.allowance ?? zero,
        ];
        if (
          allowances.reduce((sum, item) => sum + item.tokens, 0) > budget.maxTokens ||
          allowances.reduce((sum, item) => sum + item.costMicros, 0) > budget.maxCostMicros
        )
          throw invalid('TRIAL_BUDGET');
      }
      if (plugins.find(({ id }) => id === 'trials')?.version !== settings.executorVersion)
        throw invalid('TRIAL_EXECUTOR_MISMATCH');
      if (
        settings.evaluation &&
        (!(budget.maxEvaluations ?? 0) ||
          !settings.models.observer ||
          !plugins.some(({ tools }) => tools.includes('trials.evaluate')))
      )
        throw invalid('TRIAL_EVALUATION_UNAVAILABLE');
      if (
        settings.evaluation &&
        settings.models.observer!.maxOutputTokens > settings.evaluation.allowance.tokens
      )
        throw invalid('TRIAL_BUDGET');
      if (
        trialDigest(sourcePlan.designSpec?.learnedCapabilityIds ?? []) !==
        trialDigest(settings.baselineCapsuleIds)
      )
        throw invalid('TRIAL_CAPABILITY_MISMATCH');
      const resolve = async (ids: string[]) => {
        const capsules = trialCapsules(
          await invoke('presentation.memory.compose', { ids, includeObserved: true }, zero),
        );
        if (trialDigest(capsules.map(({ id }) => id).sort()) !== trialDigest([...ids].sort()))
          throw invalid('TRIAL_CAPABILITY_MISMATCH');
        return capsules;
      };
      const baselineCapsules = await resolve(settings.baselineCapsuleIds);
      const compositions = [baselineCapsules];
      for (const candidate of request.candidates) {
        if (
          !('layoutCapsuleIds' in candidate.patch) ||
          candidate.patch.layoutCapsuleIds === undefined
        ) {
          compositions.push(baselineCapsules);
          continue;
        }
        const layouts = await resolve(candidate.patch.layoutCapsuleIds);
        if (layouts.some(({ kind }) => kind !== 'layout'))
          throw invalid('TRIAL_LAYOUT_PATCH_REQUIRED');
        const combined = [...baselineCapsules.filter(({ kind }) => kind !== 'layout'), ...layouts];
        if (combined.length > 6) throw invalid('TRIAL_CAPABILITY_MISMATCH');
        compositions.push(combined);
      }
      const sourceAssets: TrialConfigurationSnapshot['sourceAssets'] = [];
      for (const ref of new Set(presentationImageRefs(sourceSlide.svg))) {
        if (ref.startsWith('data:image/')) continue;
        const match = /^\/api\/runtime\/presentation\/artifacts\/([^?]+)(?:\?raw=true)?$/u.exec(
          ref,
        );
        if (!match) throw invalid('TRIAL_ASSET_UNAVAILABLE');
        const asset = await guarded(() =>
          this.options.artifacts.get(scope, decodeURIComponent(match[1])),
        );
        if (
          !asset?.bytes ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType ?? '')
        )
          throw invalid('TRIAL_ASSET_UNAVAILABLE');
        if (asset.bytes.byteLength > budget.maxSnapshotBytes)
          throw invalid('TRIAL_SNAPSHOT_TOO_LARGE');
        sourceAssets.push({
          ref,
          mimeType: asset.mimeType!,
          sha256: createHash('sha256').update(asset.bytes).digest('hex'),
          base64: Buffer.from(asset.bytes).toString('base64'),
          metadata: asset.metadata,
        });
      }
      const condition = {
        schemaVersion: 1 as const,
        source: {
          jobId: request.jobId,
          versionId: request.expectedVersionId,
          slideId: request.slideId,
        },
        sourcePlan,
        sourceInput: source.input,
        sourceAssets,
        settings,
        budget,
        plugins,
      };
      report.conditionFingerprint = trialDigest(condition);
      const baselineConfiguration = freezeTrialValue(
        JSON.parse(
          trialJson({ ...condition, capsules: baselineCapsules }),
        ) as TrialConfigurationSnapshot,
      );
      const accountRoot = ownedLearningDirectory(
        scope.userId,
        path.join(this.options.root, 'runs'),
        trialDigest(scope.userId),
      );
      await guarded(() => mkdir(accountRoot, { recursive: true, mode: 0o700 }));
      report.directory = await guarded(() => mkdtemp(path.join(accountRoot, 'trial-')));
      await write(path.join(report.directory, 'request.json'), request);
      report.variants[0].configurationFingerprint = trialDigest(baselineConfiguration);
      await write(path.join(report.directory, 'configuration-0.json'), baselineConfiguration);
      let proposedPolicy: TrialPolicy | undefined;
      if (settings.proposal) {
        const experiences = freezeTrialValue(
          trialProposalExperiencesSchema.parse(
            await guarded(
              async () => this.options.proposalExperiences?.(scope, source, request.slideId) ?? [],
            ),
          ),
        );
        report.proposal = {
          version: settings.proposal.version,
          status: 'started',
          experiences,
          ...(incumbent ? { incumbent } : {}),
          ...(this.options.priorAttempt
            ? { priorAttempt: structuredClone(this.options.priorAttempt) }
            : {}),
        };
        await write(path.join(report.directory, 'proposal-input.json'), report.proposal);
        const workspace = path.join(report.directory, 'scratch-proposal');
        await guarded(() => mkdir(workspace, { mode: 0o700 }));
        const result = z
          .object({ proposal: z.unknown(), usage: trialUsageSchema })
          .strict()
          .parse(
            await invoke('trials.propose', {}, settings.proposal.allowance, {
              representativeTrialProposal: {
                allowance: Object.freeze({ ...settings.proposal.allowance }),
                configuration: baselineConfiguration,
                configurationFingerprint: report.variants[0].configurationFingerprint,
                plan: freezeTrialValue({
                  ...structuredClone(sourcePlan),
                  slides: [{ ...structuredClone(sourceSlide), ...incumbent?.page }],
                }),
                scope,
                signal,
                workspace,
                experiences,
                ...(incumbent ? { incumbentPolicy: incumbent.policy } : {}),
                ...(this.options.priorAttempt
                  ? { priorAttempt: freezeTrialValue(structuredClone(this.options.priorAttempt)) }
                  : {}),
              } satisfies TrialProposalContext,
            }),
          );
        settleUsage(result.usage, settings.proposal.allowance);
        // Keep the actual parsed reply, including rejected proposals, as private data.
        // It is never executed, projected to the UI or fed back wholesale as instructions.
        await write(path.join(report.directory, 'proposal-output.json'), result.proposal);
        report.proposal.output = JSON.parse(trialJson(result.proposal));
        const parsed = trialProposalSchema.safeParse(result.proposal);
        if (
          !parsed.success ||
          parsed.data.experienceIds.some((id) => !experiences.some((item) => item.episodeId === id))
        )
          throw invalid('TRIAL_PROPOSAL_INVALID_OUTPUT');
        report.proposal.result = parsed.data;
        const priorPolicy = incumbent?.policy ?? this.options.priorAttempt?.policy;
        if (priorPolicy && Object.keys(parsed.data.patch)[0] !== Object.keys(priorPolicy)[0])
          throw invalid('TRIAL_PROPOSAL_DIMENSION');
        if (priorPolicy && trialDigest(parsed.data.patch) === trialDigest(priorPolicy))
          throw invalid('TRIAL_PROPOSAL_NO_CHANGE');
        report.proposal.status = 'accepted';
        proposedPolicy = parsed.data.patch;
        await write(path.join(report.directory, 'proposal-result.json'), report.proposal);
      }
      const configurations = compositions.map((capsules, index) => {
        if (index === 0) return baselineConfiguration;
        const patch = request.candidates[index - 1].patch;
        const policy =
          (incumbent && index === 1 ? incumbent.policy : proposedPolicy) ??
          ('layoutCapsuleIds' in patch || Object.keys(patch).length === 0
            ? undefined
            : trialPolicySchema.parse(patch));
        return freezeTrialValue(
          JSON.parse(
            trialJson({
              ...condition,
              capsules,
              ...(policy ? { policy } : {}),
            }),
          ) as TrialConfigurationSnapshot,
        );
      });
      // Validate all snapshots and patches before any probe/render effect.
      if (
        configurations.some(
          (configuration) => Buffer.byteLength(trialJson(configuration)) > budget.maxSnapshotBytes,
        )
      )
        throw invalid('TRIAL_SNAPSHOT_TOO_LARGE');
      for (const [index, configuration] of configurations.entries()) {
        if (index === 0) continue;
        report.variants[index].configurationFingerprint = trialDigest(configuration);
        await write(path.join(report.directory, `configuration-${index}.json`), configuration);
      }
      const renderedCases: { id: string; svg: string; notes: string; bytes: Uint8Array }[] = [];
      for (const [index, variant] of report.variants.entries()) {
        active();
        const workspace = path.join(report.directory, `scratch-${index}`);
        await guarded(() => mkdir(workspace, { mode: 0o700 }));
        const designSpec = structuredClone(sourcePlan.designSpec ?? {});
        delete designSpec.templateVisualReview;
        delete designSpec.learnedCapabilityIds;
        const metadata = structuredClone(sourceSlide.metadata ?? {});
        delete metadata.capabilityUses;
        delete metadata.visualDirection;
        const plan: PresentationPlan = {
          planId: `${report.runId}-${index}`,
          title: sourcePlan.title,
          aspectRatio: sourcePlan.aspectRatio,
          sourceVersionIds: [...sourcePlan.sourceVersionIds],
          designSpec,
          slides: [
            {
              ...structuredClone(sourceSlide),
              ...(index > 0 && incumbent ? incumbent.page : {}),
              metadata,
              order: 1,
              slideId: 'trial-page',
            },
          ],
        };
        const context = (allowance: TrialUsage): AtomicInvocation['services'] => ({
          representativeTrialStage: {
            configuration: configurations[index],
            configurationFingerprint: variant.configurationFingerprint!,
            plan: freezeTrialValue(structuredClone(plan)),
            allowance: Object.freeze({ ...allowance }),
            workspace,
            scope: Object.freeze({ ...scope }),
            signal,
          } satisfies TrialStageContext,
        });
        const callOffset = report.calls.length;
        try {
          if (index > 0 && !(incumbent && index === 1)) {
            const result = probeResultSchema.parse(
              await invoke(
                'trials.probe',
                {},
                settings.probeAllowance,
                context(settings.probeAllowance),
                variant.id,
              ),
            );
            settleUsage(result.usage, settings.probeAllowance);
            plan.slides = [{ ...plan.slides[0], ...result.page }];
          }
          const rendered = renderResultSchema.parse(
            await invoke('trials.render', {}, zero, context(zero), variant.id),
          );
          const previewBytes = Buffer.from(rendered.bytes);
          settleUsage(rendered.usage, zero);
          if (
            previewBytes.byteLength > budget.maxArtifactBytes ||
            !previewBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          )
            throw invalid('TRIAL_INVALID_PREVIEW');
          active();
          await write(path.join(report.directory, `plan-${index}.json`), plan);
          variant.planSha256 = trialDigest(plan);
          const file = path.join(report.directory, `preview-${index}.png`);
          await guarded(() => writeFile(file, previewBytes, { flag: 'wx', mode: 0o600 }));
          active();
          variant.preview = {
            file,
            sha256: createHash('sha256').update(previewBytes).digest('hex'),
          };
          variant.status = 'completed';
          renderedCases.push({
            id: variant.id,
            svg: plan.slides[0].svg,
            notes: plan.slides[0].notes ?? '',
            bytes: previewBytes,
          });
        } catch (error) {
          const attempted = report.calls.length > callOffset;
          if (!signal.aborted && attempted && report.calls.at(-1)?.status === 'completed')
            report.calls.at(-1)!.status = 'failed';
          variant.status = signal.aborted ? 'cancelled' : attempted ? 'failed' : 'not-started';
          if (
            signal.aborted ||
            ['TRIAL_BUDGET', 'TRIAL_USAGE_EXCEEDED'].includes(
              (error as { code?: string }).code ?? '',
            )
          )
            throw error;
          if (index === 0) throw invalid('TRIAL_BASELINE_FAILED');
        }
      }
      report.status = report.variants.every(({ status }) => status === 'completed')
        ? 'completed'
        : 'partial';
      if (settings.evaluation && renderedCases.length > 1) {
        const mapping = anonymizeTrialIds(
          renderedCases.map(({ id }) => id),
          report.conditionFingerprint!,
        );
        await write(path.join(report.directory, 'identity-map.json'), mapping);
        const evaluationContext: AnonymousTrialContext = {
          allowance: settings.evaluation.allowance,
          cases: mapping.map(({ id, label }) => {
            const rendered = renderedCases.find((item) => item.id === id)!;
            return {
              label,
              svg: rendered.svg,
              notes: rendered.notes,
              bytes: new Uint8Array(rendered.bytes),
            };
          }),
          model: settings.models.observer!,
          scope,
          signal,
          sourceTexts: trialEditableTexts(sourceSlide.svg),
          sourceNotes: sourceSlide.notes ?? '',
          sourceImageRefs: presentationImageRefs(sourceSlide.svg),
          title: sourcePlan.title,
          version: settings.evaluation.version,
          visualConstraints: settings.evaluation.visualConstraints ?? '',
        };
        const evaluated = anonymousTrialScoresSchema.parse(
          await invoke('trials.evaluate', {}, settings.evaluation.allowance, {
            representativeTrialEvaluation: evaluationContext,
          }),
        );
        settleUsage(evaluated.usage, settings.evaluation.allowance);
        if (
          trialDigest(evaluated.cases.map(({ label }) => label).sort()) !==
          trialDigest(mapping.map(({ label }) => label).sort())
        )
          throw invalid('TRIAL_EVALUATION_IDENTITY');
        const variants = report.variants.map((variant) => {
          const label = mapping.find(({ id }) => id === variant.id)?.label;
          const scored = evaluated.cases.find((item) => item.label === label);
          return {
            id: variant.id,
            status: variant.status === 'completed' ? ('completed' as const) : ('failed' as const),
            appliedCapsuleIds: [],
            ...(scored
              ? {
                  evaluation: {
                    gates: scored.gates,
                    quality: scored.quality,
                    conditionFingerprint: report.conditionFingerprint!,
                    evaluatorVersion: settings.evaluation!.version,
                    artifact: {
                      ref: path.basename(variant.preview!.file),
                      sha256: variant.preview!.sha256,
                    },
                  },
                }
              : {}),
          };
        });
        const comparison: RepresentativeTrial = {
          schemaVersion: 1,
          trialId: report.runId,
          source: condition.source,
          conditionFingerprint: report.conditionFingerprint!,
          baseline: { ...variants[0], id: 'baseline' },
          candidates: variants.slice(1),
          ...(incumbent ? { incumbentId: 'incumbent' } : {}),
          rejectedCandidateIds: [],
        };
        report.selection = selectRepresentativeTrial(comparison);
        report.comparison = comparison;
        report.selectedId = report.selection.selectedId;
        await write(path.join(report.directory, 'comparison.json'), {
          comparison,
          selection: report.selection,
        });
      }
    } catch (error) {
      if (report.proposal?.status === 'started') report.proposal.status = 'rejected';
      report.selectedId = 'baseline';
      delete report.selection;
      delete report.comparison;
      if (
        (report.calls.at(-1)?.operation === 'trials.evaluate' ||
          report.proposal?.status === 'rejected') &&
        report.calls.at(-1)?.status === 'completed'
      )
        report.calls.at(-1)!.status = signal.aborted ? 'cancelled' : 'failed';
      const code = (error as { code?: string })?.code;
      report.errorCode = code?.startsWith('TRIAL_') ? code : 'TRIAL_EXECUTION_FAILED';
      report.status = signal.aborted
        ? signal.reason?.code === 'TRIAL_DEADLINE'
          ? 'deadline-exceeded'
          : 'cancelled'
        : ['TRIAL_BUDGET', 'TRIAL_USAGE_EXCEEDED'].includes(code ?? '')
          ? 'budget-exceeded'
          : 'failed';
    } finally {
      clearTimeout(timer);
      invocation.signal?.removeEventListener('abort', cancel);
      // Keep plugin implementations pinned until even an uncooperative call has settled.
      const drained = Promise.allSettled(inFlight).then(() => {
        for (const release of releases.reverse()) release();
      });
      this.draining.add(drained);
      void drained.then(() => this.draining.delete(drained));
    }
    const result = JSON.parse(trialJson(report)) as TrialRunReport;
    if (report.directory)
      await writeFile(path.join(report.directory, 'report.json'), trialJson(result), {
        flag: 'wx',
        mode: 0o600,
      });
    if (result.status === 'completed' && result.comparison)
      await this.options.publishEvidence?.(scope, result);
    return result;
  }
}
