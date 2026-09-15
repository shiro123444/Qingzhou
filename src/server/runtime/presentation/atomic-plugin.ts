import { type PluginProfile } from '@lobechat/cordis-runtime';
import { z } from 'zod';

import type {
  PlannerContext,
  PresentationPlan,
  PresentationPlanner,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import { createAssetPlugin } from '../assets/plugin';
import {
  type AtomicInvocation,
  type AtomicOperation,
  type AtomicPlugin,
  type AtomicRuntime,
  createAtomicRuntimeFromProfile,
} from '../atomic-runtime';
import { createSkillsPlugin } from '../skills-plugin';
import type { PresentationArtifactStore } from './artifact-store';
import type { PresentationGenerationPort } from './generation-port';
import type { ImageGenerationCapability } from './image-generation-capability';
import type { GLMMultimodalChatPort } from './multimodal-chat-provider-glm';
import { validatePresentationPlan } from './planner';
import type { PresentationRevisionAssetPlanner } from './revision-assets';
import type { FilePresentationTemplateLibrary } from './templates';
import { nativeTemplateOperations } from './templates/native-operations';
import type {
  InMemoryPresentationPlanWorker,
  PresentationWorkerContext,
  PresentationWorkerResult,
} from './worker';

const inputSchema = z.object({
  title: z.string().min(1).max(500),
  notebookId: z.string().min(1),
  sourceVersionIds: z.array(z.string()),
  prompt: z.string().optional(),
  slideCount: z.number().int().min(1).max(100).optional(),
  aspectRatio: z.string().optional(),
  language: z.string().optional(),
  template: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});
export const presentationPlanSchema = z
  .object({
    planId: z.string().min(1),
    title: z.string().min(1),
    aspectRatio: z.string(),
    sourceVersionIds: z.array(z.string()),
    designSpec: z.record(z.unknown()).optional(),
    slides: z
      .array(
        z.object({
          slideId: z.string().min(1),
          order: z.number().int(),
          svg: z.string().max(10 * 1024 * 1024),
          notes: z.string().optional(),
          metadata: z.record(z.unknown()).optional(),
        }),
      )
      .min(1)
      .max(100),
  })
  .transform((plan) => validatePresentationPlan(plan));
const requiredService = <T>(context: AtomicInvocation, name: string): T => {
  const service = context.services?.[name];
  if (!service)
    throw Object.assign(new Error(`Trusted execution context ${name} is required`), {
      code: 'PRESENTATION_INVALID',
    });
  return service as T;
};
export const createPresentationAtomicRuntime = (options: {
  planner: PresentationPlanner;
  chatPort?: GLMMultimodalChatPort;
  templateLibrary?: FilePresentationTemplateLibrary;
  revisionAssetPlanner?: PresentationRevisionAssetPlanner;
  worker: Pick<InMemoryPresentationPlanWorker, 'run'>;
  artifactStore: PresentationArtifactStore;
  imageGenerationCapability?: ImageGenerationCapability;
  operations?: AtomicOperation[];
  profile?: PluginProfile;
}) => {
  const operations: AtomicOperation[] = [
    {
      name: 'presentation.job.list',
      description: 'Recover the authenticated account’s recent presentations across logins.',
      input: z.object({}).strict(),
      execute: (_, ctx) => requiredService<PresentationGenerationPort>(ctx, 'port').listJobs(),
    },
    {
      name: 'presentation.plan',
      description:
        'Plan a new presentation or revise selected existing slides, returning editable SVG pages.',
      input: z.object({ input: inputSchema }).strict(),
      output: presentationPlanSchema,
      execute: ({ input }, ctx) =>
        options.planner.plan(input, {
          ...(ctx.services?.plannerContext as PlannerContext),
          scope: ctx.scope,
          abortSignal: ctx.signal,
        }),
    },
    {
      name: 'presentation.slide.read',
      description: 'Read one slide without changing the presentation.',
      input: z.object({ plan: presentationPlanSchema, slideId: z.string().min(1) }).strict(),
      execute: ({ plan, slideId }) => {
        const slide = plan.slides.find((s: { slideId: string }) => s.slideId === slideId);
        if (!slide)
          throw Object.assign(new Error('Slide not found'), { code: 'PRESENTATION_NOT_FOUND' });
        return slide;
      },
    },
    {
      name: 'presentation.slide.replace',
      description: 'Replace one editable SVG page, preserving all other slides exactly.',
      input: z
        .object({
          plan: presentationPlanSchema,
          slideId: z.string().min(1),
          svg: z.string().max(10 * 1024 * 1024),
          notes: z.string().optional(),
        })
        .strict(),
      output: presentationPlanSchema,
      execute: ({ plan, slideId, svg, notes }) => {
        if (!plan.slides.some((s: { slideId: string }) => s.slideId === slideId))
          throw Object.assign(new Error('Slide not found'), { code: 'PRESENTATION_NOT_FOUND' });
        return {
          ...plan,
          slides: plan.slides.map((s: { slideId: string }) =>
            s.slideId === slideId ? { ...s, svg, ...(notes === undefined ? {} : { notes }) } : s,
          ),
        };
      },
    },
    {
      name: 'presentation.validate',
      description: 'Check PPT SVG compatibility in the current trusted render workspace.',
      input: z.object({}).strict(),
      execute: (_, ctx) => {
        const worker = requiredService<PresentationWorkerContext>(ctx, 'workerContext');
        return worker.qualityCheck(worker.workspace.path, ctx.signal);
      },
    },
    {
      name: 'presentation.export',
      description:
        'Convert validated pages in the current render workspace to a native editable PPTX.',
      input: z.object({}).strict(),
      execute: (_, ctx) => {
        const worker = requiredService<PresentationWorkerContext>(ctx, 'workerContext');
        return worker.convert(worker.workspace.path, ctx.signal);
      },
    },
    {
      name: 'presentation.render',
      description:
        'Render a page plan, validate it and produce previews and editable presentation artifacts.',
      input: z.object({ plan: presentationPlanSchema }).strict(),
      execute: ({ plan }, ctx) => {
        const worker = requiredService<PresentationWorkerContext>(ctx, 'workerContext');
        return options.worker.run(plan, {
          ...worker,
          abortSignal: ctx.signal,
          qualityCheck: () => runtime.invoke('presentation.validate', {}, ctx),
          convert: () => runtime.invoke('presentation.export', {}, ctx),
        });
      },
    },
    {
      name: 'presentation.job.read',
      description: 'Read the current job, version and editable pages by job ID.',
      input: z.object({ jobId: z.string().min(1) }).strict(),
      execute: ({ jobId }, ctx) =>
        requiredService<PresentationGenerationPort>(ctx, 'port').readPlan(jobId),
    },
    {
      name: 'presentation.page.read',
      description: 'Read one page from an owned presentation by page number.',
      input: z.object({ jobId: z.string().min(1), page: z.number().int().positive() }).strict(),
      execute: async ({ jobId, page }, ctx) => {
        const { job, plan } = await requiredService<PresentationGenerationPort>(
          ctx,
          'port',
        ).readPlan(jobId);
        if (!plan.slides[page - 1])
          throw Object.assign(new Error('Page not found'), { code: 'PRESENTATION_NOT_FOUND' });
        return { versionId: job.versionId, slide: plan.slides[page - 1] };
      },
    },
    {
      name: 'presentation.page.replace',
      description:
        'Queue an exact editable SVG replacement for one page. Requires the current version to prevent overwriting newer edits.',
      input: z
        .object({
          jobId: z.string().min(1),
          page: z.number().int().positive(),
          expectedVersionId: z.string().min(1),
          requestId: z.string().min(1).max(128),
          svg: z
            .string()
            .min(1)
            .max(10 * 1024 * 1024),
          notes: z.string().optional(),
        })
        .strict(),
      execute: (input, ctx) =>
        requiredService<PresentationGenerationPort>(ctx, 'port').replacePage(input),
    },
    {
      name: 'presentation.job.message',
      description: 'Add a natural-language modification to a running or completed presentation.',
      input: z
        .object({
          annotation: z
            .object({
              slideId: z.string().min(1),
              expectedVersionId: z.string().min(1),
              baseSvgHash: z.string().regex(/^[a-f0-9]{64}$/),
              elementIndices: z.array(z.number().int().nonnegative()).min(1).max(40),
              region: z
                .object({
                  x: z.number().min(0).max(1),
                  y: z.number().min(0).max(1),
                  width: z.number().min(0).max(1),
                  height: z.number().min(0).max(1),
                })
                .strict(),
            })
            .strict()
            .optional(),
          jobId: z.string().min(1),
          content: z.string().min(1).max(4000),
          requestId: z.string().min(1).max(128),
          page: z.number().int().positive().optional(),
        })
        .strict(),
      execute: ({ jobId, content, requestId, page, annotation }, ctx) =>
        requiredService<PresentationGenerationPort>(ctx, 'port').sendMessage(jobId, {
          annotation,
          content,
          requestId,
          target: page ? { type: 'slide', slideNumber: page } : { type: 'deck' },
        }),
    },
    {
      name: 'presentation.job.export',
      description: 'Resolve a ready artifact download for an existing presentation version.',
      input: z
        .object({
          artifactId: z.string().min(1),
          format: z.enum(['pptx', 'svg', 'pdf', 'quality-report']),
        })
        .strict(),
      execute: ({ artifactId, format }, ctx) =>
        requiredService<PresentationGenerationPort>(ctx, 'port').exportArtifact(artifactId, format),
    },
    {
      name: 'presentation.template.fromJob',
      description: 'Learn and save a reusable template from an owned presentation.',
      input: z.object({ jobId: z.string().min(1), name: z.string().min(1).max(120) }).strict(),
      execute: ({ jobId, name }, ctx) =>
        requiredService<PresentationGenerationPort>(ctx, 'port').learnTemplate(name, jobId),
    },
    {
      name: 'presentation.template.apply',
      description: 'Apply a saved template version while retaining the presentation content.',
      input: z
        .object({
          jobId: z.string().min(1),
          templateId: z.string().min(1),
          versionId: z.string().optional(),
          requestId: z.string().min(1).max(128),
        })
        .strict(),
      execute: ({ jobId, ...input }, ctx) =>
        requiredService<PresentationGenerationPort>(ctx, 'port').applyTemplate(jobId, input),
    },
    ...(options.imageGenerationCapability
      ? [
          {
            name: 'presentation.assets.generate',
            description:
              'Generate image assets for explicit slide slots with cancellation and idempotency.',
            input: z
              .object({
                slots: z
                  .array(
                    z
                      .object({
                        slideId: z.string().min(1),
                        slotId: z.string().min(1),
                        prompt: z.string().min(1),
                        idempotencyKey: z.string().optional(),
                        size: z.string().optional(),
                        quality: z.string().optional(),
                      })
                      .passthrough(),
                  )
                  .min(1)
                  .max(4),
              })
              .strict(),
            execute: ({ slots }: any, ctx: AtomicInvocation) =>
              options.imageGenerationCapability!.generate(ctx.scope, slots, {
                jobId: ctx.jobId!,
                signal: ctx.signal,
              }),
          },
        ]
      : []),
    ...(options.templateLibrary
      ? [
          {
            name: 'presentation.template.import',
            description: 'Extract reusable style and layout from a trusted uploaded native PPTX.',
            input: z.object({ name: z.string().min(1).max(120) }).strict(),
            execute: (input: any, ctx: AtomicInvocation) =>
              options.templateLibrary!.importPptx(ctx.scope, {
                name: input.name,
                bytes: requiredService<Uint8Array>(ctx, 'upload'),
              }),
          },
          {
            name: 'presentation.template.learn',
            description:
              'Learn reusable style, geometry and image slots from an editable slide plan.',
            input: z
              .object({
                name: z.string().min(1).max(120),
                plan: presentationPlanSchema,
                templateId: z.string().optional(),
              })
              .strict(),
            execute: (input: any, ctx: AtomicInvocation) =>
              options.templateLibrary!.learnFromPlan(ctx.scope, input),
          },
          {
            name: 'presentation.template.list',
            description: 'List reusable templates owned by the current authenticated scope.',
            input: z.object({}).strict(),
            execute: (_: any, ctx: AtomicInvocation) => options.templateLibrary!.list(ctx.scope),
          },
          {
            name: 'presentation.template.resolve',
            description: 'Load the constraints and reference layouts of a saved template version.',
            input: z
              .object({ templateId: z.string().min(1), versionId: z.string().optional() })
              .strict(),
            execute: (input: any, ctx: AtomicInvocation) =>
              options.templateLibrary!.resolve(ctx.scope, input),
          },
        ]
      : []),
    ...(options.revisionAssetPlanner
      ? [
          {
            name: 'presentation.assets.prepare',
            description:
              'Decide which page assets to reuse, generate, replace or remove and generate only the required images.',
            input: z
              .object({
                jobInput: inputSchema,
                basePlan: presentationPlanSchema,
                revision: z.object({
                  content: z.string().min(1).max(4000),
                  requestId: z.string().min(1),
                  target: z.union([
                    z.object({ type: z.literal('deck') }),
                    z.object({
                      type: z.literal('slide'),
                      slideNumber: z.number().int().positive(),
                    }),
                  ]),
                  template: z
                    .object({ templateId: z.string(), versionId: z.string().optional() })
                    .optional(),
                }),
              })
              .strict(),
            execute: (input: any, ctx: AtomicInvocation) =>
              options.revisionAssetPlanner!.prepare({
                ...input,
                scope: ctx.scope,
                jobId: ctx.jobId!,
                signal: ctx.signal,
              }),
          },
        ]
      : []),
    ...(options.templateLibrary
      ? nativeTemplateOperations(options.templateLibrary, options.artifactStore)
      : []),
    ...(options.operations ?? []),
  ];
  const plugins: AtomicPlugin[] = [
    {
      id: 'presentation',
      version: '2.1.0',
      operations: operations.map((operation) =>
        [
          'presentation.template.list',
          'presentation.template.resolve',
          'presentation.template.inspectNative',
          'presentation.template.extractAssets',
        ].includes(operation.name)
          ? { ...operation, agent: { contexts: ['presentation.intake'], maxCalls: 4 } }
          : operation,
      ),
    },
    createAssetPlugin(options.artifactStore, options.imageGenerationCapability),
    createSkillsPlugin(() => runtime, options.chatPort),
  ];
  const runtime: AtomicRuntime = createAtomicRuntimeFromProfile({
    bundles: { presentation: { entries: plugins.map(({ id }) => ({ id, use: id })) } },
    modules: Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin])),
    profile: options.profile ?? { bundles: ['presentation'] },
  });
  return runtime;
};

export const atomicPlanner = (runtime: AtomicRuntime): PresentationPlanner => ({
  plan: (input, context) =>
    runtime.invoke<PresentationPlan>(
      'presentation.plan',
      { input },
      {
        scope: context.scope as RuntimeScope,
        signal: context.abortSignal as AbortSignal | undefined,
        jobId: context.jobId as string | undefined,
        services: { plannerContext: context },
      },
    ),
});
export const atomicWorker = (
  runtime: AtomicRuntime,
): Pick<InMemoryPresentationPlanWorker, 'run'> => ({
  run: (plan, context) =>
    runtime.invoke<PresentationWorkerResult>(
      'presentation.render',
      { plan },
      {
        scope: (context.eventScope ?? context.scope) as RuntimeScope,
        signal: context.abortSignal,
        jobId: context.jobId,
        services: { workerContext: context },
      },
    ),
});
