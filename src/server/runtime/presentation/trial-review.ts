import { ownedLearningDirectory } from '../learning-lifecycle/files';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { TrialReviewResult, TrialReviewView } from '@/types/presentationTrial';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { AtomicOperation } from '../atomic-runtime';
import type { PresentationArtifactStore } from './artifact-store';
import type { FilePresentationStorage, StoredPresentationJob } from './file-storage';
import { validatePresentationPlan } from './planner';
import { representativeTrialSchema, selectRepresentativeTrial } from './representative-trial';
import { trialDigest } from './trial-configuration';
import { writeTrialImmutable as immutable } from './trial-immutable';
import type { TrialLearningWriter } from './trial-learning';
import { type CapturedVariant, captureTrialRound } from './trial-round-evidence';
import type { TrialConfigurationSnapshot, TrialRunReport } from './trial-runner';

const fail = (code: string, message = code) => Object.assign(new Error(message), { code });
const shaBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const id = z.string().min(1).max(200);
export const trialReviewChoiceSchema = z
  .object({
    jobId: id,
    runId: id,
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    expectedVersionId: id,
    variantId: id,
    requestId: z.string().uuid(),
    confirmed: z.literal(true),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export interface TrialEvidence {
  configurations: TrialConfigurationSnapshot[];
  improvementRounds?: { report: TrialRunReport; variants: CapturedVariant[] }[];
  owner: string;
  plans: NonNullable<StoredPresentationJob['plan']>[];
  previews: { id: string; base64: string }[];
  report: TrialRunReport;
}
export class FileTrialEvidenceStore {
  constructor(private readonly root: string) {}
  private directory(scope: RuntimeScope) {
    if (!scope.userId?.trim() || !scope.sessionId?.trim()) throw fail('PRESENTATION_INVALID');
    return ownedLearningDirectory(
      scope.userId,
      this.root,
      trialDigest([scope.userId, scope.sessionId]),
    );
  }
  /** Called only by the trusted runner, never by a browser or model operation. */
  async publish(scope: RuntimeScope, report: TrialRunReport) {
    if (report.status !== 'completed' || !report.directory || !report.comparison) return;
    const configurations: TrialEvidence['configurations'] = [],
      plans: TrialEvidence['plans'] = [],
      previews: TrialEvidence['previews'] = [];
    for (const [index, variant] of report.variants.entries()) {
      const configuration = JSON.parse(
        await readFile(path.join(report.directory, `configuration-${index}.json`), 'utf8'),
      ) as TrialConfigurationSnapshot;
      const plan = validatePresentationPlan(
        JSON.parse(await readFile(path.join(report.directory, `plan-${index}.json`), 'utf8')),
      );
      const bytes = await readFile(path.join(report.directory, `preview-${index}.png`));
      if (
        trialDigest(configuration) !== variant.configurationFingerprint ||
        trialDigest(plan) !== variant.planSha256 ||
        shaBytes(bytes) !== variant.preview?.sha256
      )
        throw fail('PRESENTATION_INVALID', 'Trial evidence changed');
      configurations.push(configuration);
      plans.push(plan);
      previews.push({ id: variant.id, base64: bytes.toString('base64') });
    }
    const body: TrialEvidence = {
      owner: trialDigest([scope.userId, scope.sessionId]),
      report,
      configurations,
      plans,
      previews,
      ...(report.improvement
        ? {
            improvementRounds: await Promise.all(
              report.improvement.rounds.map(async (round) => ({
                report: round,
                variants: await captureTrialRound(round),
              })),
            ),
          }
        : {}),
    };
    await immutable(path.join(this.directory(scope), 'runs', `${trialDigest(report.runId)}.json`), {
      digest: trialDigest(body),
      body,
    });
    await immutable(
      path.join(this.directory(scope), 'index', `${trialDigest(report.runId)}.json`),
      {
        runId: report.runId,
        source: report.comparison.source,
      },
    );
  }
  async read(scope: RuntimeScope, runId: string): Promise<{ digest: string; body: TrialEvidence }> {
    const file = path.join(this.directory(scope), 'runs', `${trialDigest(runId)}.json`);
    const raw = await readFile(file, 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw fail('PRESENTATION_NOT_FOUND');
      throw error;
    });
    const record = JSON.parse(raw) as { digest: string; body: TrialEvidence };
    if (
      record.digest !== trialDigest(record.body) ||
      record.body.owner !== trialDigest([scope.userId, scope.sessionId]) ||
      record.body.report.runId !== runId
    )
      throw fail('PRESENTATION_INVALID', 'Trial integrity check failed');
    const comparison = representativeTrialSchema.parse(record.body.report.comparison);
    if (
      trialDigest(selectRepresentativeTrial(comparison)) !==
      trialDigest(record.body.report.selection)
    )
      throw fail('PRESENTATION_INVALID');
    return record;
  }
  async list(scope: RuntimeScope, jobId: string, slideId: string) {
    const dir = path.join(this.directory(scope), 'index');
    const files = await readdir(dir).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    const found: { runId: string }[] = [];
    for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))) {
      const summary = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as {
        runId: string;
        source: { jobId: string; slideId: string };
      };
      if (
        `${trialDigest(summary.runId)}.json` === file &&
        summary.source.jobId === jobId &&
        summary.source.slideId === slideId
      )
        found.push({ runId: summary.runId });
    }
    return found.slice(-20).reverse();
  }
  async prepareDecision(
    scope: RuntimeScope,
    choice: z.infer<typeof trialReviewChoiceSchema>,
    result: TrialReviewResult,
  ) {
    await immutable(
      path.join(
        this.directory(scope),
        'decision-intents',
        `${trialDigest([choice.jobId, choice.requestId])}.json`,
      ),
      { digest: trialDigest(choice), choice, result },
    );
  }
  async learningDecisions(scope: RuntimeScope) {
    const found = new Map<
      string,
      {
        choice: z.infer<typeof trialReviewChoiceSchema>;
        result: TrialReviewResult;
        committed: boolean;
      }
    >();
    for (const kind of ['decision-intents', 'choices']) {
      const dir = path.join(this.directory(scope), kind);
      const files = await readdir(dir).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });
      for (const file of files.filter((file) => /^[a-f0-9]{64}\.json$/u.test(file))) {
        const raw = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
        // Old receipts without a choice are preserved; they cannot reconstruct user intent.
        if (!raw.choice) continue;
        const choice = trialReviewChoiceSchema.parse(raw.choice);
        const result = z
          .object({ status: z.enum(['created', 'kept']), jobId: id, versionId: id })
          .strict()
          .parse(raw.result);
        const digest = trialDigest(choice);
        const expectedJob =
          result.status === 'kept'
            ? choice.jobId
            : `presentation-trial-${trialDigest([choice.jobId, choice.requestId]).slice(0, 40)}`;
        const expectedVersion =
          result.status === 'kept' ? choice.expectedVersionId : `trial-version-${digest}`;
        if (
          raw.digest !== digest ||
          file !== `${trialDigest([choice.jobId, choice.requestId])}.json` ||
          result.jobId !== expectedJob ||
          result.versionId !== expectedVersion
        )
          throw fail('PRESENTATION_INVALID');
        found.set(digest, { choice, result, committed: kind === 'choices' });
      }
    }
    return [...found.values()];
  }
  decisionFile(scope: RuntimeScope, jobId: string, requestId: string) {
    return path.join(this.directory(scope), 'choices', `${trialDigest([jobId, requestId])}.json`);
  }
}
export class PresentationTrialReview {
  constructor(
    private readonly evidence: FileTrialEvidenceStore,
    private readonly storage: FilePresentationStorage,
    private readonly artifacts: PresentationArtifactStore = storage,
    private readonly learning?: TrialLearningWriter,
  ) {}
  async list(scope: RuntimeScope, jobId: string, slideId: string) {
    if (!(await this.storage.getJob(scope, jobId))) throw fail('PRESENTATION_NOT_FOUND');
    return { trials: await this.evidence.list(scope, jobId, slideId) };
  }
  async read(scope: RuntimeScope, runId: string): Promise<TrialReviewView> {
    const { digest, body } = await this.evidence.read(scope, runId);
    const comparison = body.report.comparison!;
    if (!(await this.storage.getJob(scope, comparison.source.jobId)))
      throw fail('PRESENTATION_NOT_FOUND');
    const variants = [];
    for (const [index, variant] of [comparison.baseline, ...comparison.candidates].entries()) {
      const bytes = Buffer.from(body.previews[index].base64, 'base64');
      if (shaBytes(bytes) !== variant.evaluation?.artifact.sha256)
        throw fail('PRESENTATION_INVALID');
      const artifactId = `trial-preview-${variant.evaluation.artifact.sha256}`;
      await this.artifacts.put(scope, {
        artifactId,
        name: `${variant.id}.png`,
        type: 'image',
        mimeType: 'image/png',
        bytes,
        metadata: { trialRunId: runId },
      });
      const eligible = selectRepresentativeTrial({ ...comparison, userChoice: variant.id });
      variants.push({
        id: variant.id,
        selectable: variant.id === 'baseline' || eligible.selectedId === variant.id,
        previewUri: `/api/runtime/presentation/artifacts/${artifactId}?raw=true`,
        gates: variant.evaluation.gates,
        quality: variant.evaluation.quality,
      });
    }
    return {
      runId,
      evidenceDigest: digest,
      source: comparison.source,
      recommendedId: body.report.selectedId,
      ...(body.report.improvement
        ? {
            improvement: {
              rounds: body.report.improvement.rounds.length,
              selectedRound: body.report.improvement.selectedRound,
              charged: body.report.improvement.charged,
              refinementFailed: body.report.improvement.rounds[1]?.status !== 'completed',
            },
          }
        : {}),
      ...(body.report.proposal?.result
        ? {
            proposal: {
              dimension: Object.keys(body.report.proposal.result.patch)[0] as NonNullable<
                TrialReviewView['proposal']
              >['dimension'],
              value: Object.values(body.report.proposal.result.patch)[0]!,
              rationale: body.report.proposal.result.rationale,
              experienceCount: body.report.proposal.result.experienceIds.length,
            },
          }
        : {}),
      variants,
    };
  }
  async choose(
    scope: RuntimeScope,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<TrialReviewResult> {
    const input = trialReviewChoiceSchema.safeParse(raw);
    if (!input.success) throw fail('PRESENTATION_INVALID');
    const choice = input.data;
    const { digest, body } = await this.evidence.read(scope, choice.runId);
    const comparison = body.report.comparison!,
      config = body.configurations[0];
    if (
      digest !== choice.evidenceDigest ||
      comparison.source.jobId !== choice.jobId ||
      comparison.source.versionId !== choice.expectedVersionId ||
      ![comparison.baseline, ...comparison.candidates].some((item) => item.id === choice.variantId)
    )
      throw fail('PRESENTATION_CONFLICT');
    const selected = selectRepresentativeTrial({ ...comparison, userChoice: choice.variantId });
    if (selected.selectedId !== choice.variantId)
      throw fail('PRESENTATION_INVALID', 'Candidate did not pass comparison gates');
    const decisionDigest = trialDigest(choice),
      filename = this.evidence.decisionFile(scope, choice.jobId, choice.requestId);
    const targetId = `presentation-trial-${trialDigest([choice.jobId, choice.requestId]).slice(0, 40)}`;
    const complete = async (result: TrialReviewResult): Promise<TrialReviewResult> => {
      if (!this.learning) return result;
      try {
        const learningEpisodeId = await this.learning.recordDecision(scope, choice, result, {
          digest,
          body,
        });
        return { ...result, learningEpisodeId, learningStatus: 'recorded' };
      } catch {
        // Receipts and candidate intents recover learning after a committed edit.
        return { ...result, learningStatus: 'pending' };
      }
    };
    // Keep the source lock through the commit even if the HTTP request disconnects.
    // Cancellation is checked at each stage and again immediately before publication.
    signal?.throwIfAborted();
    const lease = await this.storage.acquireLease(scope, choice.jobId);
    if (!lease) throw fail('PRESENTATION_CONFLICT');
    try {
      signal?.throwIfAborted();
      lease.signal.throwIfAborted();
      const previous = await readFile(filename, 'utf8')
        .then((text) => JSON.parse(text) as { digest: string; result: TrialReviewResult })
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
      if (previous) {
        if (previous.digest !== decisionDigest) throw fail('PRESENTATION_CONFLICT');
        return complete(previous.result);
      }
      const existing = await this.storage.getJob(scope, targetId);
      if (existing) {
        if (existing.plan?.designSpec?.trialDecisionDigest !== decisionDigest)
          throw fail('PRESENTATION_CONFLICT');
        const result: TrialReviewResult = {
          status: 'created',
          jobId: existing.job.jobId,
          // Replay the version created by this decision, even if its job was
          // subsequently edited. Never relabel a later edit as this trial result.
          versionId: `trial-version-${decisionDigest}`,
        };
        await immutable(filename, { digest: decisionDigest, result, choice });
        return complete(result);
      }
      // CAS under the exact execution lease used by live edits, messages and deletion.
      const current = await this.storage.getJob(scope, choice.jobId);
      if (
        !current?.plan ||
        current.job.state !== 'completed' ||
        current.job.versionId !== choice.expectedVersionId ||
        trialDigest({ input: current.input, plan: current.plan }) !==
          trialDigest({ input: config.sourceInput, plan: config.sourcePlan })
      )
        throw fail('PRESENTATION_CONFLICT', 'The source has changed; compare its latest version');
      let result: TrialReviewResult;
      if (choice.variantId === 'baseline')
        result = { status: 'kept', jobId: choice.jobId, versionId: choice.expectedVersionId };
      else {
        const index = body.report.variants.findIndex(({ id }) => id === choice.variantId);
        const candidate = body.plans[index].slides[0];
        const versionId = `trial-version-${decisionDigest}`,
          now = new Date().toISOString();
        const plan = structuredClone(current.plan);
        plan.planId = `trial-plan-${decisionDigest}`;
        plan.slides = plan.slides.map((slide) =>
          slide.slideId === comparison.source.slideId
            ? {
                ...slide,
                svg: candidate.svg,
                notes: candidate.notes,
                metadata: {
                  ...slide.metadata,
                  capabilityUses: undefined,
                  visualDirection: undefined,
                },
              }
            : slide,
        );
        const designSpec = { ...plan.designSpec };
        delete designSpec.templateVisualReview;
        delete designSpec.learnedCapabilityIds;
        plan.designSpec = {
          ...designSpec,
          trialDecisionDigest: decisionDigest,
          trialLineage: {
            source: comparison.source,
            runId: choice.runId,
            variantId: choice.variantId,
            evidenceDigest: digest,
            requestId: choice.requestId,
          },
        };
        const artifactIds: string[] = [];
        for (const [page, slide] of plan.slides.entries()) {
          signal?.throwIfAborted();
          lease.signal.throwIfAborted();
          const artifactId = `${targetId}-slide-${page + 1}`;
          await this.artifacts.put(scope, {
            artifactId,
            name: `Slide ${page + 1}.svg`,
            type: 'svg',
            mimeType: 'image/svg+xml',
            bytes: Buffer.from(slide.svg),
            metadata: {
              jobId: targetId,
              versionId,
              slideId: slide.slideId,
              slideNumber: page + 1,
              notes: slide.notes,
              title: plan.title,
              aspectRatio: plan.aspectRatio,
            },
          });
          artifactIds.push(artifactId);
        }
        signal?.throwIfAborted();
        lease.signal.throwIfAborted();
        if (this.learning)
          await this.evidence.prepareDecision(scope, choice, {
            status: 'created',
            jobId: targetId,
            versionId,
          });
        await this.storage.createJobImmutable(
          scope,
          {
            input: structuredClone(current.input),
            plan,
            initialAssetsComplete: true,
            job: {
              jobId: targetId,
              versionId,
              state: 'completed',
              title: current.job.title ?? current.input.title,
              createdAt: now,
              updatedAt: now,
              slideCount: plan.slides.length,
              aspectRatio: plan.aspectRatio,
              artifactIds,
            },
          },
          AbortSignal.any([lease.signal, ...(signal ? [signal] : [])]),
        );
        result = { status: 'created', jobId: targetId, versionId };
      }
      // Publication is the commit point. After it, return its durable result even
      // if the request disconnects; a retry uses the same request identity.
      await immutable(
        filename,
        { digest: decisionDigest, result, choice },
        result.status === 'kept'
          ? AbortSignal.any([lease.signal, ...(signal ? [signal] : [])])
          : undefined,
      );
      return complete(result);
    } finally {
      await lease.release();
    }
  }
  operations(): AtomicOperation[] {
    return [
      {
        name: 'presentation.trial.list',
        description: 'List owned representative-page comparisons.',
        input: z.object({ jobId: id, slideId: id }).strict(),
        execute: (input, ctx) => this.list(ctx.scope, input.jobId, input.slideId),
      },
      {
        name: 'presentation.trial.read',
        description: 'Read immutable comparison previews and evidence.',
        input: z.object({ runId: id }).strict(),
        execute: (input, ctx) => this.read(ctx.scope, input.runId),
      },
      {
        name: 'presentation.trial.choose',
        description: 'Confirm an explicit user choice and fork a source-CAS-protected version.',
        input: trialReviewChoiceSchema,
        execute: (input, ctx) => this.choose(ctx.scope, input, ctx.signal),
      },
    ];
  }
}
