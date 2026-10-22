import { ownedLearningDirectory, withAccountData } from '../learning-lifecycle/files';
import { createHash } from 'node:crypto';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { TrialValidationView, ValidationTarget } from '@/types/presentationValidation';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { AtomicOperation } from '../atomic-runtime';
import { acquirePresentationExecutionLease } from './execution-lease';
import type { FilePresentationStorage, StoredPresentationJob } from './file-storage';
import { presentationImageRefs } from './revision-assets';
import { trialDigest, trialJson } from './trial-configuration';
import { trialEditableTexts } from './trial-evaluation';
import { writeTrialImmutable } from './trial-immutable';
import type { FileTrialLearningStore, LearningEpisodeRecord } from './trial-learning';
import { type TrialPolicy, trialPolicySchema } from './trial-policy';
import { FileTrialEvidenceStore } from './trial-review';
import type { TrialConfigurationSnapshot, TrialRunReport } from './trial-runner';

const fail = (code = 'PRESENTATION_INVALID') => Object.assign(new Error(code), { code });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const id = z.string().trim().min(1).max(200);
const validationId = z.string().regex(/^validation-[a-f0-9]{64}$/u);
const targetSchema = z.object({ jobId: id, expectedVersionId: id, slideId: id }).strict();
export const validationCreateSchema = z
  .object({
    episodeId: id,
    requestId: z.string().uuid(),
    targets: z.array(targetSchema).length(2),
    confirmed: z.literal(true),
  })
  .strict();
const running = (state: TrialValidationView['state']) => ['running', 'cancelling'].includes(state);
export const HELDOUT_PAGE_BUDGET = Object.freeze({
  maxProposals: 0,
  maxProbes: 1,
  maxRenders: 2,
  maxEvaluations: 1,
  maxTokens: 40_000,
  maxCostMicros: 1_750_000,
  maxDurationMs: 180_000,
  maxSnapshotBytes: 8 * 1024 * 1024,
  maxArtifactBytes: 8 * 1024 * 1024,
});
const budget = Object.freeze({
  maxTokens: 80_000,
  maxCostMicros: 3_500_000,
  maxDurationMs: 360_000,
  maxProbes: 2,
  maxRenders: 4,
  maxEvaluations: 2,
});
const contentDigest = (svg: string) => trialDigest(trialEditableTexts(svg).sort());
const sourceDigest = (source: StoredPresentationJob) =>
  trialDigest({ input: source.input, plan: source.plan });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface HeldoutPage {
  assets: TrialConfigurationSnapshot['sourceAssets'];
  contentDigest: string;
  source: StoredPresentationJob;
  sourceDigest: string;
  target: ValidationTarget;
}
export interface HeldoutRunContext {
  budgetSubjectJobId?: string;
  manifestDigest: string;
  policy: TrialPolicy;
  validationId: string;
}
interface Manifest {
  inputDigest: string;
  owner: string;
  policy: TrialPolicy;
  protocol: 'two-task-heldout-v1';
  seed: LearningEpisodeRecord;
  targets: HeldoutPage[];
  validationId: string;
}
interface Session {
  drain: () => Promise<void>;
  run: (page: HeldoutPage, context: HeldoutRunContext) => Promise<TrialRunReport>;
}
/** Preregistered, one-shot two-task validation. No proposer, retries or capability promotion. */
export class PresentationTrialValidation {
  private tasks = new Set<Promise<void>>();
  private controllers = new Map<string, AbortController>();
  constructor(
    private readonly options: {
      root: string;
      workerRoot: string;
      storage: FilePresentationStorage;
      evidence: FileTrialEvidenceStore;
      learning: Pick<FileTrialLearningStore, 'readStored' | 'validationSources'>;
      createSession: (scope: RuntimeScope, signal: AbortSignal) => Promise<Session>;
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
  private worker(scope: RuntimeScope) {
    return path.join(
      ownedLearningDirectory(
        scope.userId,
        this.options.workerRoot,
        trialDigest([scope.userId, scope.sessionId]),
      ),
      'worker.lock',
    );
  }
  private file(scope: RuntimeScope, name: string) {
    return path.join(this.directory(scope), name);
  }
  private async optional<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
  }
  private async locked<T>(scope: RuntimeScope, action: () => Promise<T>) {
    const lease = await acquirePresentationExecutionLease(this.file(scope, 'control.lock'));
    if (!lease) throw fail('PRESENTATION_CONFLICT');
    try {
      return await action();
    } finally {
      await lease.release();
    }
  }
  private async manifest(scope: RuntimeScope, raw: string) {
    const key = validationId.parse(raw);
    const envelope = await this.optional<{ digest: string; body: Manifest }>(
      this.file(scope, `${key}.json`),
    );
    if (!envelope) throw fail('PRESENTATION_NOT_FOUND');
    if (
      envelope.digest !== trialDigest(envelope.body) ||
      envelope.body.owner !== trialDigest([scope.userId, scope.sessionId]) ||
      envelope.body.validationId !== key ||
      envelope.body.protocol !== 'two-task-heldout-v1'
    )
      throw fail();
    return envelope;
  }
  private async save(scope: RuntimeScope, view: TrialValidationView) {
    const file = this.file(scope, `${view.validationId}.state.json`),
      temp = `${file}.tmp`;
    await withAccountData(file, async () => {
      await writeFile(temp, trialJson(view), { mode: 0o600 });
      await rename(temp, file);
    });
  }
  private async receipt(scope: RuntimeScope, view: TrialValidationView) {
    await writeTrialImmutable(this.file(scope, `${view.validationId}.result.json`), {
      digest: trialDigest(view),
      view,
    });
  }
  private initial(body: Manifest, digest: string): TrialValidationView {
    return {
      automaticPromotion: false,
      budget,
      charged: { tokens: 0, costMicros: 0 },
      episodeId: body.seed.episodeId,
      manifestDigest: digest,
      validationId: body.validationId,
      state: 'prepared',
      verdict: 'pending',
      targets: body.targets.map((page) => ({
        ...page.target,
        title: page.source.plan!.title,
        pageNumber: page.source.plan!.slides.find((slide) => slide.slideId === page.target.slideId)!
          .order,
        outcome: 'not-started',
      })),
    };
  }
  private async seed(scope: RuntimeScope, episodeId: string) {
    const seed = await this.options.learning.readStored(scope, episodeId);
    if (
      !seed ||
      seed.kind !== 'decision' ||
      seed.outcome !== 'candidate-adopted' ||
      seed.result?.status !== 'created' ||
      !seed.selectedVariantId ||
      seed.selectedVariantId === 'baseline'
    )
      throw fail();
    const candidate = seed.evidence.variants.find(
      (variant) => variant.id === seed.selectedVariantId,
    );
    const baseline = seed.evidence.variants.find((variant) => variant.id === 'baseline');
    if (
      !candidate?.configuration ||
      !baseline?.configuration ||
      candidate.configuration.settings.frozenInputs.validation
    )
      throw fail();
    const policy = trialPolicySchema.parse(candidate.configuration.policy);
    const { policy: _policy, ...rest } = candidate.configuration;
    if (trialDigest(rest) !== trialDigest(baseline.configuration)) throw fail();
    return { seed, policy };
  }
  private async assets(scope: RuntimeScope, source: StoredPresentationJob, slideId: string) {
    const slide = source.plan!.slides.find((slide) => slide.slideId === slideId)!;
    const assets: HeldoutPage['assets'] = [];
    let bytes = Buffer.byteLength(trialJson(source));
    if (bytes > HELDOUT_PAGE_BUDGET.maxSnapshotBytes) throw fail('PRESENTATION_OUTPUT_LIMIT');
    for (const ref of new Set(presentationImageRefs(slide.svg))) {
      if (ref.startsWith('data:image/')) continue;
      const match = /^\/api\/runtime\/presentation\/artifacts\/([^?]+)(?:\?raw=true)?$/u.exec(ref);
      if (!match) throw fail();
      const asset = await this.options.storage.get(scope, decodeURIComponent(match[1]));
      if (
        !asset?.bytes ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType ?? '')
      )
        throw fail();
      bytes += Math.ceil((asset.bytes.byteLength * 4) / 3);
      if (bytes > HELDOUT_PAGE_BUDGET.maxSnapshotBytes) throw fail('PRESENTATION_OUTPUT_LIMIT');
      assets.push({
        ref,
        mimeType: asset.mimeType!,
        base64: Buffer.from(asset.bytes).toString('base64'),
        sha256: sha(asset.bytes),
        metadata: asset.metadata,
      });
    }
    return assets;
  }
  private async exclusions(scope: RuntimeScope) {
    const sources = await this.options.learning.validationSources(scope);
    return {
      jobs: new Set(sources.map((source) => source.job.jobId)),
      pages: new Set(
        sources.flatMap(
          (source) => source.plan?.slides.map((slide) => contentDigest(slide.svg)) ?? [],
        ),
      ),
      materials: new Set(
        sources.flatMap((source) => [
          ...source.input.sourceVersionIds,
          ...(source.plan?.sourceVersionIds ?? []),
        ]),
      ),
    };
  }
  private eligible(
    source: StoredPresentationJob,
    slideId: string,
    seed: LearningEpisodeRecord,
    seen: Awaited<ReturnType<PresentationTrialValidation['exclusions']>>,
  ) {
    const slide = source.plan?.slides.find((slide) => slide.slideId === slideId);
    return Boolean(
      slide &&
      source.job.state === 'completed' &&
      source.job.versionId &&
      !source.plan?.designSpec?.trialLineage &&
      !seen.jobs.has(source.job.jobId) &&
      source.job.jobId !== seed.result?.jobId &&
      source.job.jobId !== seed.source.jobId &&
      !seen.pages.has(contentDigest(slide.svg)) &&
      ![...source.input.sourceVersionIds, ...(source.plan?.sourceVersionIds ?? [])].some((id) =>
        seen.materials.has(id),
      ) &&
      trialEditableTexts(slide.svg).length &&
      source.plan?.aspectRatio === seed.cue.aspectRatio &&
      (!seed.cue.pageRole || slide.metadata?.pageRole === seed.cue.pageRole),
    );
  }
  /** Reservations also exclude clones from subsequent ordinary proposal trials. */
  async assertAvailable(scope: RuntimeScope, source: StoredPresentationJob, slideId: string) {
    const slide = source.plan?.slides.find((slide) => slide.slideId === slideId);
    if (
      !slide ||
      (await this.optional(this.file(scope, `task-${trialDigest(source.job.jobId)}.json`))) ||
      (await this.optional(this.file(scope, `page-${contentDigest(slide.svg)}.json`)))
    )
      throw fail('PRESENTATION_CONFLICT');
  }
  async choices(scope: RuntimeScope, episodeId: string) {
    const { seed } = await this.seed(scope, episodeId),
      seen = await this.exclusions(scope);
    const studies = await readdir(this.directory(scope)).catch((error) => {
      if (missing(error)) return [];
      throw error;
    });
    const validations: { validationId: string }[] = [];
    for (const file of studies
      .filter((name) => /^validation-[a-f0-9]{64}\.json$/u.test(name))
      .slice(-100)) {
      const archive = await this.manifest(scope, file.slice(0, -5));
      if (archive.body.seed.episodeId === episodeId)
        validations.push({ validationId: archive.body.validationId });
    }
    const targets = [];
    for (const job of (await this.options.storage.listJobs(scope)).slice(0, 100)) {
      const source = await this.options.storage.getJob(scope, job.jobId);
      if (!source?.plan) continue;
      if (await this.optional(this.file(scope, `task-${trialDigest(job.jobId)}.json`))) continue;
      for (const slide of source.plan.slides) {
        if (!this.eligible(source, slide.slideId, seed, seen)) continue;
        if (await this.optional(this.file(scope, `page-${contentDigest(slide.svg)}.json`)))
          continue;
        targets.push({
          jobId: job.jobId,
          expectedVersionId: job.versionId!,
          slideId: slide.slideId,
          title: source.plan.title,
          pageNumber: slide.order,
        });
        if (targets.length === 100) return { targets, validations };
      }
    }
    return { targets, validations };
  }
  async create(scope: RuntimeScope, raw: unknown, signal?: AbortSignal) {
    const input = validationCreateSchema.parse(raw);
    return this.locked(scope, async () => {
      const key = `validation-${trialDigest([scope.userId, scope.sessionId, input.requestId])}`;
      const existing = await this.optional<{ digest: string; body: Manifest }>(
        this.file(scope, `${key}.json`),
      );
      if (existing) {
        if (existing.body.inputDigest !== trialDigest(input)) throw fail('PRESENTATION_CONFLICT');
        return this.status(scope, key, false);
      }
      const worker = await acquirePresentationExecutionLease(this.worker(scope), signal);
      if (!worker) throw fail('PRESENTATION_CONFLICT');
      try {
        signal?.throwIfAborted();
        if (new Set(input.targets.map((target) => target.jobId)).size !== 2) throw fail();
        const { seed, policy } = await this.seed(scope, input.episodeId),
          seen = await this.exclusions(scope);
        const targets: HeldoutPage[] = [];
        for (const target of input.targets) {
          const source = await this.options.storage.getJob(scope, target.jobId);
          if (
            !source ||
            source.job.versionId !== target.expectedVersionId ||
            !this.eligible(source, target.slideId, seed, seen)
          )
            throw fail('PRESENTATION_CONFLICT');
          const digest = contentDigest(
            source.plan!.slides.find((slide) => slide.slideId === target.slideId)!.svg,
          );
          if (targets.some((page) => page.contentDigest === digest)) throw fail();
          const materials = new Set([
            ...source.input.sourceVersionIds,
            ...(source.plan?.sourceVersionIds ?? []),
          ]);
          if (
            targets.some((page) =>
              [
                ...page.source.input.sourceVersionIds,
                ...(page.source.plan?.sourceVersionIds ?? []),
              ].some((id) => materials.has(id)),
            )
          )
            throw fail();
          targets.push({
            target,
            source,
            sourceDigest: sourceDigest(source),
            contentDigest: digest,
            assets: await this.assets(scope, source, target.slideId),
          });
        }
        const body: Manifest = {
          inputDigest: trialDigest(input),
          owner: trialDigest([scope.userId, scope.sessionId]),
          policy,
          protocol: 'two-task-heldout-v1',
          seed,
          targets,
          validationId: key,
        };
        const digest = trialDigest(body);
        if (Buffer.byteLength(trialJson(body)) > 24 * 1024 * 1024)
          throw fail('PRESENTATION_OUTPUT_LIMIT');
        // Never free a held-out page for another search after seeing its results.
        for (const page of targets) {
          const reservation = { validationId: key, inputDigest: body.inputDigest };
          await writeTrialImmutable(
            this.file(scope, `task-${trialDigest(page.target.jobId)}.json`),
            reservation,
            signal,
          );
          await writeTrialImmutable(
            this.file(scope, `page-${page.contentDigest}.json`),
            reservation,
            signal,
          );
        }
        await writeTrialImmutable(this.file(scope, `${key}.json`), { body, digest }, signal);
        return this.initial(body, digest);
      } finally {
        await worker.release();
      }
    });
  }
  async status(scope: RuntimeScope, key: string, recover = true): Promise<TrialValidationView> {
    const { body, digest } = await this.manifest(scope, key);
    const completed = await this.optional<{ digest: string; view: TrialValidationView }>(
      this.file(scope, `${key}.result.json`),
    );
    if (completed) {
      if (
        completed.digest !== trialDigest(completed.view) ||
        completed.view.manifestDigest !== digest ||
        completed.view.validationId !== key ||
        running(completed.view.state) ||
        completed.view.state === 'prepared'
      )
        throw fail();
      return completed.view;
    }
    let state = await this.optional<TrialValidationView>(this.file(scope, `${key}.state.json`));
    if (!state) {
      const initial = this.initial(body, digest);
      if (await this.optional(this.file(scope, `${key}.started.json`))) {
        initial.charged = { tokens: budget.maxTokens, costMicros: budget.maxCostMicros };
        const lease = await acquirePresentationExecutionLease(
          this.file(scope, `${key}.worker.lock`),
        );
        if (!lease)
          return {
            ...initial,
            state: (await this.optional(this.file(scope, `${key}.cancel.json`)))
              ? 'cancelling'
              : 'running',
          };
        try {
          // The first state/terminal receipt may have appeared while taking the lease.
          if (
            (await this.optional(this.file(scope, `${key}.state.json`))) ||
            (await this.optional(this.file(scope, `${key}.result.json`)))
          )
            return this.status(scope, key, false);
          initial.state = 'interrupted';
          initial.verdict = 'insufficient-evidence';
          initial.targets.forEach((target) => {
            target.outcome = 'incomplete';
          });
          await this.receipt(scope, initial);
          await this.save(scope, initial);
        } finally {
          await lease.release();
        }
      } else if (await this.optional(this.file(scope, `${key}.cancel.json`))) {
        initial.state = 'cancelled';
        initial.verdict = 'insufficient-evidence';
        await this.receipt(scope, initial);
      }
      return initial;
    }
    if (state.manifestDigest !== digest || state.validationId !== key) throw fail();
    if (recover && running(state.state)) {
      const worker = await acquirePresentationExecutionLease(
        this.file(scope, `${key}.worker.lock`),
      );
      if (worker) {
        try {
          state = (await this.optional<TrialValidationView>(
            this.file(scope, `${key}.state.json`),
          ))!;
          if (running(state.state)) {
            state.state = 'interrupted';
            state.verdict = 'insufficient-evidence';
            state.targets.forEach((target) => {
              if (target.outcome === 'running') target.outcome = 'incomplete';
            });
            await this.receipt(scope, state);
            await this.save(scope, state);
          }
        } finally {
          await worker.release();
        }
      }
    }
    if (running(state.state) && (await this.optional(this.file(scope, `${key}.cancel.json`))))
      return { ...state, state: 'cancelling' };
    return state;
  }
  async start(scope: RuntimeScope, raw: unknown, signal?: AbortSignal) {
    const input = z
      .object({ validationId, confirmed: z.literal(true) })
      .strict()
      .parse(raw);
    return this.locked(scope, async () => {
      const { body, digest } = await this.manifest(scope, input.validationId);
      const current = await this.status(scope, input.validationId);
      if (current.state !== 'prepared') return current;
      const worker = await acquirePresentationExecutionLease(this.worker(scope), signal);
      if (!worker) throw fail('PRESENTATION_CONFLICT');
      const ownership = await acquirePresentationExecutionLease(
        this.file(scope, `${body.validationId}.worker.lock`),
        signal,
      ).catch(async (error) => {
        await worker.release();
        throw error;
      });
      if (!ownership) {
        await worker.release();
        throw fail('PRESENTATION_CONFLICT');
      }
      let dispatched = false;
      try {
        signal?.throwIfAborted();
        // Validate the entire preregistered cohort before any model call.
        for (const page of body.targets) await this.checkSource(scope, page);
        await writeTrialImmutable(
          this.file(scope, `${body.validationId}.started.json`),
          { manifestDigest: digest },
          signal,
        );
        const state = this.initial(body, digest);
        state.state = 'running';
        await this.save(scope, state);
        const controller = new AbortController(),
          lost = () => controller.abort(fail('TRIAL_LEASE_LOST'));
        worker.signal.addEventListener('abort', lost, { once: true });
        ownership.signal.addEventListener('abort', lost, { once: true });
        if (worker.signal.aborted) lost();
        this.controllers.set(this.file(scope, body.validationId), controller);
        const task = this.execute(scope, body, state, controller).finally(async () => {
          this.controllers.delete(this.file(scope, body.validationId));
          worker.signal.removeEventListener('abort', lost);
          ownership.signal.removeEventListener('abort', lost);
          await ownership.release();
          await worker.release();
        });
        this.tasks.add(task);
        void task.then(
          () => this.tasks.delete(task),
          () => this.tasks.delete(task),
        );
        dispatched = true;
        return structuredClone(state);
      } finally {
        if (!dispatched) {
          await ownership.release();
          await worker.release();
        }
      }
    });
  }
  async cancel(scope: RuntimeScope, key: string) {
    return this.locked(scope, async () => {
      const state = await this.status(scope, key);
      if (state.state === 'prepared') {
        await writeTrialImmutable(this.file(scope, `${key}.cancel.json`), { requested: true });
        state.state = 'cancelled';
        state.verdict = 'insufficient-evidence';
        await this.receipt(scope, state);
        await this.save(scope, state);
      } else if (running(state.state)) {
        await writeTrialImmutable(this.file(scope, `${key}.cancel.json`), { requested: true });
        this.controllers.get(this.file(scope, key))?.abort(fail('TRIAL_CANCELLED'));
        return { ...state, state: 'cancelling' as const };
      }
      return state;
    });
  }
  private async checkSource(scope: RuntimeScope, page: HeldoutPage) {
    const source = await this.options.storage.getJob(scope, page.target.jobId);
    if (
      !source ||
      source.job.state !== 'completed' ||
      source.job.versionId !== page.target.expectedVersionId ||
      sourceDigest(source) !== page.sourceDigest ||
      trialDigest(await this.assets(scope, source, page.target.slideId)) !==
        trialDigest(page.assets)
    )
      throw fail('TRIAL_SOURCE_CHANGED');
  }
  private outcome(report: TrialRunReport): TrialValidationView['targets'][number]['outcome'] {
    const comparison = report.comparison;
    const baseline = comparison?.baseline.evaluation,
      candidate = comparison?.candidates[0]?.evaluation;
    if (
      report.status !== 'completed' ||
      !baseline ||
      !candidate ||
      Object.values(baseline.gates).some((gate) => gate.status !== 'passed')
    )
      return 'incomplete';
    if (Object.values(candidate.gates).some((gate) => gate.status === 'failed')) return 'regressed';
    if (Object.values(candidate.gates).some((gate) => gate.status !== 'passed'))
      return 'incomplete';
    const keys = ['readability', 'hierarchy', 'composition', 'styleConsistency'] as const;
    if (keys.some((key) => candidate.quality[key].score < baseline.quality[key].score))
      return 'regressed';
    return report.selection?.reason === 'strict-improvement' && report.selectedId === 'candidate'
      ? 'improved'
      : 'tied';
  }
  private async execute(
    scope: RuntimeScope,
    body: Manifest,
    state: TrialValidationView,
    controller: AbortController,
  ) {
    const { signal } = controller;
    let session: Session | undefined, preparing: Promise<Session> | undefined;
    const timer = setTimeout(() => controller.abort(fail('TRIAL_DEADLINE')), budget.maxDurationMs);
    const poll = setInterval(() => {
      void this.optional(this.file(scope, `${body.validationId}.cancel.json`)).then(
        (value) => {
          if (value) controller.abort(fail('TRIAL_CANCELLED'));
        },
        () => controller.abort(fail('TRIAL_CANCELLED')),
      );
    }, 200);
    const guard = async <T>(task: Promise<T>) => {
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
    try {
      preparing = this.options.createSession(scope, signal);
      session = await guard(preparing);
      const outcomes: TrialValidationView['targets'][number]['outcome'][] = [];
      const reports: { index: number; report: TrialRunReport }[] = [];
      const sealed = new FileTrialEvidenceStore(path.join(this.options.root, 'sealed-evidence'));
      let environment: string | undefined;
      for (const [index, page] of body.targets.entries()) {
        signal.throwIfAborted();
        await guard(this.checkSource(scope, page));
        if (
          state.charged.tokens + HELDOUT_PAGE_BUDGET.maxTokens > budget.maxTokens ||
          state.charged.costMicros + HELDOUT_PAGE_BUDGET.maxCostMicros > budget.maxCostMicros
        )
          throw fail('TRIAL_BUDGET');
        state.targets[index].outcome = 'running';
        state.charged.tokens += HELDOUT_PAGE_BUDGET.maxTokens;
        state.charged.costMicros += HELDOUT_PAGE_BUDGET.maxCostMicros;
        await this.save(scope, state);
        const report = await guard(
          session.run(page, {
            validationId: body.validationId,
            budgetSubjectJobId: body.seed.source.jobId,
            manifestDigest: state.manifestDigest,
            policy: body.policy,
          }),
        );
        state.charged.tokens += report.charged.tokens - HELDOUT_PAGE_BUDGET.maxTokens;
        state.charged.costMicros += report.charged.costMicros - HELDOUT_PAGE_BUDGET.maxCostMicros;
        signal.throwIfAborted();
        // Archive completed outputs separately; no per-page feedback is sent into later runs.
        await writeTrialImmutable(
          this.file(scope, `${body.validationId}.report-${index}.json`),
          report,
          signal,
        );
        await guard(this.checkSource(scope, page));
        if (report.status === 'completed' && report.comparison) {
          await sealed.publish(scope, report);
          const archive = await sealed.read(scope, report.runId);
          const config = archive.body.configurations[1],
            baseline = archive.body.configurations[0];
          const { policy, ...rest } = config;
          const { baselineCapsuleIds: _ids, ...sharedSettings } = config.settings;
          const identity = trialDigest({
            settings: sharedSettings,
            plugins: config.plugins,
            budget: config.budget,
          });
          if (
            config.settings.proposal ||
            trialDigest(config.budget) !== trialDigest(HELDOUT_PAGE_BUDGET) ||
            trialDigest(config.source) !==
              trialDigest({
                jobId: page.target.jobId,
                versionId: page.target.expectedVersionId,
                slideId: page.target.slideId,
              }) ||
            trialDigest({ input: config.sourceInput, plan: config.sourcePlan }) !==
              page.sourceDigest ||
            trialDigest(config.sourceAssets) !== trialDigest(page.assets) ||
            trialDigest(config.settings.frozenInputs.validation) !==
              trialDigest({
                validationId: body.validationId,
                manifestDigest: state.manifestDigest,
                protocol: 'two-task-heldout-v1',
              }) ||
            report.calls.some((call) => call.operation === 'trials.propose') ||
            trialDigest(policy) !== trialDigest(body.policy) ||
            trialDigest(rest) !== trialDigest(baseline) ||
            (environment && environment !== identity)
          )
            throw fail('TRIAL_VALIDATION_CONTEXT');
          environment = identity;
          await writeTrialImmutable(
            this.file(scope, `${body.validationId}.evidence-${index}.json`),
            archive,
            signal,
          );
          reports.push({ index, report });
        }
        outcomes.push(this.outcome(report));
        // Keep per-page scores and outcomes sealed until the entire cohort finishes.
        state.targets[index].outcome = 'running';
        await this.save(scope, state);
        if (report.status !== 'completed') throw fail(report.errorCode ?? 'TRIAL_EXECUTION_FAILED');
      }
      signal.throwIfAborted();
      const leases = [];
      try {
        for (const page of [...body.targets].sort((a, b) =>
          a.target.jobId.localeCompare(b.target.jobId),
        )) {
          const lease = await this.options.storage.acquireLease(scope, page.target.jobId, signal);
          if (!lease) throw fail('TRIAL_SOURCE_CHANGED');
          leases.push(lease);
        }
        for (const page of body.targets) await this.checkSource(scope, page);
        for (const { report } of reports) {
          signal.throwIfAborted();
          await this.options.evidence.publish(scope, report);
        }
        signal.throwIfAborted();
        for (const lease of leases) lease.signal.throwIfAborted();
      } finally {
        for (const lease of leases.reverse()) await lease.release();
      }
      reports.forEach(({ report, index }) => {
        state.targets[index].runId = report.runId;
      });
      outcomes.forEach((outcome, index) => {
        state.targets[index].outcome = outcome;
      });
      state.state = 'completed';
      state.verdict = outcomes.includes('regressed')
        ? 'regressed'
        : outcomes.includes('incomplete')
          ? 'insufficient-evidence'
          : outcomes.every((value) => value === 'improved')
            ? 'review-ready'
            : 'no-improvement';
    } catch (error) {
      const code = signal.aborted ? signal.reason?.code : (error as { code?: string }).code;
      state.state =
        code === 'TRIAL_CANCELLED'
          ? 'cancelled'
          : code === 'TRIAL_DEADLINE'
            ? 'deadline-exceeded'
            : code === 'TRIAL_LEASE_LOST'
              ? 'interrupted'
              : 'failed';
      state.verdict = 'insufficient-evidence';
      for (const target of state.targets)
        if (target.outcome === 'running') {
          target.outcome = 'incomplete';
          target.errorCode = code?.startsWith('TRIAL_') ? code : 'TRIAL_EXECUTION_FAILED';
        }
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      await this.receipt(scope, state).catch(() => undefined);
      await this.save(scope, state).catch(() => undefined);
      session ??= await preparing?.catch(() => undefined);
      await session?.drain();
    }
  }
  async drain() {
    await Promise.allSettled(this.tasks);
  }
  operations(): AtomicOperation[] {
    return [
      {
        name: 'presentation.validation.options',
        description: 'List eligible independent pages for an adopted configuration.',
        input: z.object({ episodeId: id }).strict(),
        execute: (input, ctx) => this.choices(ctx.scope, input.episodeId),
      },
      {
        name: 'presentation.validation.create',
        description: 'Freeze one configuration and two independent held-out tasks.',
        input: validationCreateSchema,
        execute: (input, ctx) => this.create(ctx.scope, input, ctx.signal),
      },
      {
        name: 'presentation.validation.start',
        description: 'Explicitly execute a fixed held-out cohort once.',
        input: z.object({ validationId, confirmed: z.literal(true) }).strict(),
        execute: (input, ctx) => this.start(ctx.scope, input, ctx.signal),
      },
      {
        name: 'presentation.validation.status',
        description: 'Read owned held-out progress without rerunning it.',
        input: z.object({ validationId }).strict(),
        execute: (input, ctx) => this.status(ctx.scope, input.validationId),
      },
      {
        name: 'presentation.validation.cancel',
        description: 'Cancel an owned held-out cohort.',
        input: z.object({ validationId }).strict(),
        execute: (input, ctx) => this.cancel(ctx.scope, input.validationId),
      },
    ];
  }
}
