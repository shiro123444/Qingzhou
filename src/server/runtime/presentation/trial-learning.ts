import { ownedLearningDirectory } from '../learning-lifecycle/files';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type {
  LearningEpisodeView,
  TrialExecution,
  TrialReviewChoice,
  TrialReviewResult,
} from '@/types/presentationTrial';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { AtomicOperation } from '../atomic-runtime';
import type { captureLearningEpisode } from '../improvement/episode';
import type { LearningCapture } from '../improvement/learning-commands';
import { captureLearningCommand } from '../improvement/production';
import type { FilePresentationStorage, StoredPresentationJob } from './file-storage';
import { selectRepresentativeTrial } from './representative-trial';
import { trialDigest, trialJson } from './trial-configuration';
import { writeTrialImmutable } from './trial-immutable';
import { trialPolicySchema } from './trial-policy';
import type { TrialProposalExperience } from './trial-proposal';
import type { FileTrialEvidenceStore, TrialEvidence } from './trial-review';
import { type CapturedVariant, captureTrialRound } from './trial-round-evidence';
import type { TrialConfigurationSnapshot, TrialRunReport } from './trial-runner';

const fail = () =>
  Object.assign(new Error('Invalid learning evidence'), { code: 'PRESENTATION_INVALID' });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface LearningEpisodeRecord {
  cue: LearningEpisodeView['cue'];
  episodeId: string;
  // Private replay bundle. Complete configurations are retained, never replaced by the lesson.
  evidence: {
    archiveDigest?: string;
    source?: StoredPresentationJob;
    report?: TrialRunReport;
    execution?: Pick<TrialExecution, 'state' | 'errorCode' | 'startedAt' | 'charged'>;
    choice?: TrialReviewChoice;
    variants: CapturedVariant[];
    improvementRounds?: { report: TrialRunReport; variants: CapturedVariant[] }[];
  };
  executionId?: string;
  kind: 'attempt' | 'decision';
  lesson: LearningEpisodeView['lesson'];
  outcome: string;
  owner: string;
  reason?: string;
  reasonProvided: boolean;
  result?: LearningEpisodeView['result'];
  runId?: string;
  schemaVersion: 1;
  selectedVariantId?: string;
  source: LearningEpisodeView['source'];
  status: 'pending-validation';
}
export interface TrialLearningWriter {
  prepareAttempt: (
    scope: RuntimeScope,
    execution: TrialExecution,
    source: StoredPresentationJob,
  ) => Promise<void>;
  proposalExperiences?: (
    scope: RuntimeScope,
    jobId: string,
    slideId: string,
  ) => Promise<TrialProposalExperience[]>;
  recordAttempt: (
    scope: RuntimeScope,
    execution: TrialExecution,
    report?: TrialRunReport,
  ) => Promise<string>;
  recordDecision: (
    scope: RuntimeScope,
    choice: TrialReviewChoice,
    result: TrialReviewResult,
    archive: { digest: string; body: TrialEvidence },
  ) => Promise<string>;
}
const cue = (
  source: Pick<StoredPresentationJob, 'plan'> | undefined,
  slideId: string,
): LearningEpisodeView['cue'] => {
  const slide = source?.plan?.slides.find((slide) => slide.slideId === slideId);
  const role = slide?.metadata?.pageRole;
  return {
    domain: 'presentation',
    ...(source?.plan
      ? { title: source.plan.title.slice(0, 300), aspectRatio: source.plan.aspectRatio }
      : {}),
    ...(slide ? { slideNumber: slide.order } : {}),
    ...(typeof role === 'string' ? { pageRole: role.slice(0, 120) } : {}),
  };
};
const lesson = (observation: string): LearningEpisodeView['lesson'] => ({
  applicability: 'source-page-only',
  observation,
  transfer: 'unverified',
});
const configurationPaths = (
  before: TrialConfigurationSnapshot,
  after: TrialConfigurationSnapshot,
) => {
  const project = (value: TrialConfigurationSnapshot) => ({
    policy: value.policy ?? null,
    settings: value.settings,
    capsules: value.capsules,
    plugins: value.plugins,
    budget: value.budget,
  });
  const walk = (left: unknown, right: unknown, prefix: string): string[] => {
    if (trialJson(left) === trialJson(right)) return [];
    if (
      left &&
      right &&
      typeof left === 'object' &&
      typeof right === 'object' &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const a = left as Record<string, unknown>,
        b = right as Record<string, unknown>;
      return [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .sort()
        .flatMap((key) =>
          !(key in a) || !(key in b)
            ? [`${prefix}${key}`]
            : walk(a[key], b[key], `${prefix}${key}.`),
        );
    }
    return [prefix.replace(/\.$/u, '')];
  };
  return walk(project(before), project(after), '');
};
/** Separate observational library: no capability promotion, composition or model invocation. */
export class FileTrialLearningStore implements TrialLearningWriter {
  constructor(
    private readonly options: {
      root: string;
      evidence: FileTrialEvidenceStore;
      storage: FilePresentationStorage;
    },
  ) {}
  private directory(scope: RuntimeScope) {
    if (!scope.userId?.trim() || !scope.sessionId?.trim()) throw fail();
    return ownedLearningDirectory(
      scope.userId,
      this.options.root,
      trialDigest([scope.userId, scope.sessionId]),
    );
  }
  private episodeFile(scope: RuntimeScope, episodeId: string) {
    if (!/^episode-[a-f0-9]{64}$/u.test(episodeId)) throw fail();
    return path.join(this.directory(scope), 'episodes', `${episodeId}.json`);
  }
  private async optional<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
  }
  private async commit(scope: RuntimeScope, record: LearningEpisodeRecord) {
    await writeTrialImmutable(this.episodeFile(scope, record.episodeId), {
      digest: trialDigest(record),
      record,
    });
    // Append a shared projection beside the existing archive. Legacy IDs and archive digests stay intact.
    const configured = record.evidence.variants.filter((variant) => variant.configuration);
    const selectedIndex = configured.findIndex(
      (variant) => variant.id === record.selectedVariantId,
    );
    const protocol = await captureLearningCommand({
      type: record.evidence.choice && record.result ? 'artifact-fork' : 'observation',
      id: record.episodeId,
      domain: 'presentation',
      scope: {
        userId: scope.userId!,
        subject: { kind: 'presentation', sessionId: scope.sessionId!, jobId: record.source.jobId },
      },
      ...(record.evidence.report?.budgetRef ? { budgetRef: record.evidence.report.budgetRef } : {}),
      evidenceRef: record.episodeId,
      configurations: configured.map((variant) => ({
        domain: 'presentation',
        configuration: variant.configuration,
      })),
      baselineIndex: configured.findIndex((variant) => variant.id === 'baseline'),
      candidateIndex:
        record.selectedVariantId && record.selectedVariantId !== 'baseline'
          ? selectedIndex
          : configured.findIndex((variant) => variant.id !== 'baseline'),
      ...(record.evidence.choice && record.result
        ? {
            selection: {
              action: record.result.status === 'created' ? ('adopt' as const) : ('keep' as const),
              selectedIndex,
              sourceVersionId: record.source.versionId,
              resultVersionId: record.result.versionId,
              requestId: record.evidence.choice.requestId,
              ...(record.reasonProvided ? { reason: record.reason } : {}),
            },
          }
        : {}),
      outcome:
        record.outcome === 'candidate-adopted'
          ? 'candidate'
          : record.outcome === 'baseline-kept'
            ? 'baseline'
            : record.outcome === 'cancelled'
              ? 'cancelled'
              : record.outcome === 'failed'
                ? 'failed'
                : 'unknown',
      applicability: 'source-page-only',
    });
    await writeTrialImmutable(
      path.join(this.directory(scope), 'protocol-v2', `${record.episodeId}.json`),
      protocol,
    );
    const jobs = new Set([record.source.jobId, ...(record.result ? [record.result.jobId] : [])]);
    for (const jobId of jobs)
      await writeTrialImmutable(
        path.join(
          this.directory(scope),
          'index',
          `${trialDigest([jobId, record.source.slideId])}-${record.episodeId}.json`,
        ),
        { episodeId: record.episodeId },
      );
    return record.episodeId;
  }
  /** On-demand projection also supports old archives without rewriting their evidence. */
  async readProtocol(scope: RuntimeScope, episodeId: string) {
    const record = await this.readStored(scope, episodeId);
    if (!record) return;
    await this.commit(scope, record);
    return this.optional<LearningCapture>(
      path.join(this.directory(scope), 'protocol-v2', `${episodeId}.json`),
    );
  }
  async readLegacyProtocol(scope: RuntimeScope, episodeId: string) {
    if (!(await this.readStored(scope, episodeId))) return;
    return this.optional<Awaited<ReturnType<typeof captureLearningEpisode>>>(
      path.join(this.directory(scope), 'protocol', `${episodeId}.json`),
    );
  }
  async prepareAttempt(
    scope: RuntimeScope,
    execution: TrialExecution,
    source: StoredPresentationJob,
  ) {
    if (
      source.job.jobId !== execution.source.jobId ||
      source.job.versionId !== execution.source.versionId
    )
      throw fail();
    const body = {
      source,
      subject: execution.source,
      executionId: execution.executionId,
      owner: trialDigest([scope.userId, scope.sessionId]),
    };
    await writeTrialImmutable(
      path.join(this.directory(scope), 'seeds', `${trialDigest(execution.executionId)}.json`),
      { digest: trialDigest(body), body },
    );
  }

  async recordAttempt(scope: RuntimeScope, execution: TrialExecution, report?: TrialRunReport) {
    if (['running', 'cancelling'].includes(execution.state)) throw fail();
    const episodeId = `episode-${trialDigest(['attempt', execution.executionId])}`;
    const existing = await this.readStored(scope, episodeId);
    if (existing) return this.commit(scope, existing);
    const envelope = await this.optional<{
      digest: string;
      body: {
        source: StoredPresentationJob;
        subject: TrialExecution['source'];
        executionId: string;
        owner: string;
      };
    }>(path.join(this.directory(scope), 'seeds', `${trialDigest(execution.executionId)}.json`));
    const seed = envelope?.body;
    if (
      envelope &&
      (!seed ||
        envelope.digest !== trialDigest(seed) ||
        seed.owner !== trialDigest([scope.userId, scope.sessionId]) ||
        trialDigest(seed.subject) !== trialDigest(execution.source) ||
        seed.executionId !== execution.executionId)
    )
      throw fail();
    const outcome =
      execution.errorCode === 'TRIAL_SOURCE_CHANGED'
        ? 'source-conflict'
        : execution.state === 'completed'
          ? 'comparison-ready'
          : execution.state;
    return this.commit(scope, {
      schemaVersion: 1,
      episodeId,
      owner: trialDigest([scope.userId, scope.sessionId]),
      kind: 'attempt',
      status: 'pending-validation',
      source: execution.source,
      cue: cue(seed?.source, execution.source.slideId),
      lesson: lesson(outcome),
      outcome,
      reasonProvided: false,
      ...(report ? { runId: report.runId } : {}),
      executionId: execution.executionId,
      evidence: {
        source: seed?.source,
        report,
        execution: {
          state: execution.state,
          errorCode: execution.errorCode,
          charged: execution.charged,
          startedAt: execution.startedAt,
        },
        variants: await captureTrialRound(report),
        ...(report?.improvement
          ? {
              improvementRounds: await Promise.all(
                report.improvement.rounds.map(async (round) => ({
                  report: round,
                  variants: await captureTrialRound(round),
                })),
              ),
            }
          : {}),
      },
    });
  }
  async recordDecision(
    scope: RuntimeScope,
    choice: TrialReviewChoice,
    result: TrialReviewResult,
    archive: { digest: string; body: TrialEvidence },
  ) {
    const { body, digest } = archive,
      comparison = body.report.comparison;
    if (
      !comparison ||
      digest !== trialDigest(body) ||
      body.owner !== trialDigest([scope.userId, scope.sessionId]) ||
      digest !== choice.evidenceDigest ||
      comparison.source.jobId !== choice.jobId ||
      comparison.source.versionId !== choice.expectedVersionId ||
      selectRepresentativeTrial({ ...comparison, userChoice: choice.variantId }).selectedId !==
        choice.variantId ||
      (result.status === 'kept') !== (choice.variantId === 'baseline')
    )
      throw fail();
    const decisionDigest = trialDigest(choice);
    const expectedJob =
      result.status === 'kept'
        ? choice.jobId
        : `presentation-trial-${trialDigest([choice.jobId, choice.requestId]).slice(0, 40)}`;
    const expectedVersion =
      result.status === 'kept' ? choice.expectedVersionId : `trial-version-${decisionDigest}`;
    if (result.jobId !== expectedJob || result.versionId !== expectedVersion) throw fail();
    const variants = body.report.variants.map((variant, index) => ({
      id: variant.id,
      configuration: body.configurations[index],
      plan: body.plans[index],
      preview: body.previews[index].base64,
      evaluation: [comparison.baseline, ...comparison.candidates].find(
        (candidate) => candidate.id === variant.id,
      )?.evaluation,
    }));
    const baseline = variants[0].configuration;
    const source = { plan: baseline.sourcePlan };
    const outcome = result.status === 'kept' ? 'baseline-kept' : 'candidate-adopted';
    const episodeId = `episode-${trialDigest(['decision', trialDigest(choice)])}`;
    const saved = await this.commit(scope, {
      schemaVersion: 1,
      episodeId,
      owner: trialDigest([scope.userId, scope.sessionId]),
      kind: 'decision',
      status: 'pending-validation',
      source: comparison.source,
      cue: cue(source, comparison.source.slideId),
      lesson: lesson(outcome),
      outcome,
      reasonProvided: Boolean(choice.reason),
      ...(choice.reason ? { reason: choice.reason } : {}),
      selectedVariantId: choice.variantId,
      result: { jobId: result.jobId, versionId: result.versionId, status: result.status },
      runId: choice.runId,
      evidence: {
        archiveDigest: digest,
        choice,
        report: body.report,
        variants,
        ...(body.improvementRounds ? { improvementRounds: body.improvementRounds } : {}),
      },
    });
    await writeTrialImmutable(
      path.join(this.directory(scope), 'decisions', `${trialDigest(choice)}.json`),
      { episodeId: saved },
    );
    return saved;
  }
  /** Trusted server read for replay and tests. HTTP exposes only the projection below. */
  async readStored(
    scope: RuntimeScope,
    episodeId: string,
  ): Promise<LearningEpisodeRecord | undefined> {
    const stored = await this.optional<{ digest: string; record: LearningEpisodeRecord }>(
      this.episodeFile(scope, episodeId),
    );
    if (!stored) return;
    if (
      stored.digest !== trialDigest(stored.record) ||
      stored.record.owner !== trialDigest([scope.userId, scope.sessionId]) ||
      stored.record.episodeId !== episodeId ||
      stored.record.status !== 'pending-validation'
    )
      throw fail();
    return stored.record;
  }
  /** Trusted contamination audit, including prepared attempts that never completed. */
  async validationSources(scope: RuntimeScope): Promise<StoredPresentationJob[]> {
    const result: StoredPresentationJob[] = [];
    const seeds = path.join(this.directory(scope), 'seeds');
    const files = await readdir(seeds).catch((error) => {
      if (missing(error)) return [];
      throw error;
    });
    if (files.length > 1000) throw fail();
    for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))) {
      const envelope = await this.optional<{
        digest: string;
        body: { owner: string; source: StoredPresentationJob };
      }>(path.join(seeds, file));
      if (
        !envelope ||
        envelope.digest !== trialDigest(envelope.body) ||
        envelope.body.owner !== trialDigest([scope.userId, scope.sessionId])
      )
        throw fail();
      result.push(envelope.body.source);
    }
    // Older completed decisions may predate prepared attempt seeds.
    const episodes = path.join(this.directory(scope), 'episodes');
    const records = await readdir(episodes).catch((error) => {
      if (missing(error)) return [];
      throw error;
    });
    if (records.length > 1000) throw fail();
    for (const file of records.filter((name) => /^episode-[a-f0-9]{64}\.json$/u.test(name))) {
      const record = await this.readStored(scope, file.slice(0, -5));
      for (const variant of record?.evidence.variants ?? []) {
        if (variant.configuration)
          result.push({
            input: variant.configuration.sourceInput,
            plan: variant.configuration.sourcePlan,
            job: {
              jobId: variant.configuration.source.jobId,
              versionId: variant.configuration.source.versionId,
              state: 'completed',
              createdAt: '',
              updatedAt: '',
            },
          });
      }
    }
    return result;
  }
  private async reconcile(scope: RuntimeScope, jobId?: string) {
    for (const pending of await this.options.evidence.learningDecisions(scope)) {
      const { choice, result } = pending;
      if (jobId && choice.jobId !== jobId && result.jobId !== jobId) continue;
      const completed = await this.optional<{ episodeId: string }>(
        path.join(this.directory(scope), 'decisions', `${trialDigest(choice)}.json`),
      );
      if (completed?.episodeId === `episode-${trialDigest(['decision', trialDigest(choice)])}`)
        continue;
      // A candidate intent becomes experience only after immutable job publication.
      if (!pending.committed) {
        if (result.status !== 'created') continue;
        const job = await this.options.storage.getJob(scope, result.jobId);
        if (job?.plan?.designSpec?.trialDecisionDigest !== trialDigest(choice)) continue;
      }
      await this.recordDecision(
        scope,
        choice,
        result,
        await this.options.evidence.read(scope, choice.runId),
      );
    }
  }
  async list(scope: RuntimeScope, jobId: string, slideId: string) {
    await this.reconcile(scope, jobId);
    const dir = path.join(this.directory(scope), 'index'),
      prefix = `${trialDigest([jobId, slideId])}-`;
    const files = await readdir(dir).catch((error) => {
      if (missing(error)) return [];
      throw error;
    });
    const episodes = [];
    for (const file of files.filter((file) => file.startsWith(prefix) && file.endsWith('.json'))) {
      const index = await this.optional<{ episodeId: string }>(path.join(dir, file));
      const record = index && (await this.readStored(scope, index.episodeId));
      if (
        record &&
        (record.source.jobId === jobId || record.result?.jobId === jobId) &&
        record.source.slideId === slideId
      )
        episodes.push({
          mtime: (await stat(path.join(dir, file))).mtimeMs,
          episodeId: record.episodeId,
          kind: record.kind,
          status: record.status,
          outcome: record.outcome,
        });
    }
    return {
      episodes: episodes
        .sort((a, b) => b.mtime - a.mtime || a.episodeId.localeCompare(b.episodeId))
        .slice(0, 20)
        .map(({ mtime: _mtime, ...episode }) => episode),
    };
  }
  /** Same-page lineage only. Never expose evaluator scores, raw pages or full prompts to the proposer. */
  async proposalExperiences(
    scope: RuntimeScope,
    jobId: string,
    slideId: string,
  ): Promise<TrialProposalExperience[]> {
    const { episodes } = await this.list(scope, jobId, slideId);
    const result: TrialProposalExperience[] = [];
    for (const entry of episodes.slice(0, 3)) {
      const record = await this.readStored(scope, entry.episodeId);
      if (!record) continue;
      const candidate = record.evidence.variants.find((item) => item.id !== 'baseline');
      const policy = trialPolicySchema.safeParse(candidate?.configuration?.policy);
      result.push({
        episodeId: record.episodeId,
        status: 'pending-validation',
        applicability: 'source-page-only',
        outcome: record.outcome,
        ...(record.reasonProvided ? { reason: record.reason?.slice(0, 1000) } : {}),
        ...(policy.success ? { attemptedPolicy: policy.data } : {}),
      });
    }
    return result;
  }
  async read(scope: RuntimeScope, episodeId: string): Promise<LearningEpisodeView> {
    let record = await this.readStored(scope, episodeId);
    if (!record) {
      await this.reconcile(scope);
      record = await this.readStored(scope, episodeId);
    }
    if (!record)
      throw Object.assign(new Error('Learning episode not found'), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    const base = record.evidence.variants[0];
    const variants = [];
    for (const variant of record.evidence.variants) {
      let previewUri: string | undefined;
      if (variant.preview) {
        const bytes = Buffer.from(variant.preview, 'base64'),
          artifactId = `learning-preview-${sha(bytes)}`;
        await this.options.storage.put(scope, {
          artifactId,
          name: `${variant.id}.png`,
          type: 'image',
          mimeType: 'image/png',
          bytes,
        });
        previewUri = `/api/runtime/presentation/artifacts/${artifactId}?raw=true`;
      }
      variants.push({
        id: variant.id,
        ...(variant.configuration
          ? { configurationDigest: trialDigest(variant.configuration) }
          : {}),
        configurationCompared: Boolean(base?.configuration && variant.configuration),
        changedPaths:
          base?.configuration && variant.configuration
            ? configurationPaths(base.configuration, variant.configuration)
            : [],
        ...(base?.plan && variant.plan
          ? {
              pageChanged: base.plan.slides[0].svg !== variant.plan.slides[0].svg,
              notesChanged: base.plan.slides[0].notes !== variant.plan.slides[0].notes,
            }
          : {}),
        previewUri,
        gates: variant.evaluation?.gates,
        quality: variant.evaluation?.quality,
        available: {
          configuration: Boolean(variant.configuration),
          plan: Boolean(variant.plan),
          preview: Boolean(variant.preview),
          evaluation: Boolean(variant.evaluation),
        },
      });
    }
    return {
      episodeId,
      failureCode: record.evidence.execution?.errorCode ?? record.evidence.report?.errorCode,
      kind: record.kind,
      status: record.status,
      source: record.source,
      cue: record.cue,
      lesson: record.lesson,
      outcome: record.outcome,
      reasonProvided: record.reasonProvided,
      reason: record.reason,
      selectedVariantId: record.selectedVariantId,
      result: record.result,
      runId: record.runId,
      executionId: record.executionId,
      variants,
    };
  }
  operations(): AtomicOperation[] {
    return [
      {
        name: 'presentation.learning.list',
        description: 'List owned pending trial experiences; never promotes capabilities.',
        input: z
          .object({ jobId: z.string().min(1).max(200), slideId: z.string().min(1).max(200) })
          .strict(),
        execute: (input, ctx) => this.list(ctx.scope, input.jobId, input.slideId),
      },
      {
        name: 'presentation.learning.read',
        description: 'Inspect owned evidence-backed pending experience.',
        input: z.object({ episodeId: z.string().regex(/^episode-[a-f0-9]{64}$/u) }).strict(),
        execute: (input, ctx) => this.read(ctx.scope, input.episodeId),
      },
    ];
  }
}
