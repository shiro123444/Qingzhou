import { createHash } from 'node:crypto';

import { z } from 'zod';

import type {
  PresentationJobInput,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import { assetAnnotationsSchema } from './asset-annotations';
import { contentLayout } from './content-layout';
import {
  assertLessonPublicContent,
  LESSON_RENDERING_INSTRUCTIONS,
  publicLessonStages,
  readLessonPlan,
} from './lesson';
import { MATERIAL_GROUNDING_INSTRUCTIONS, materialContextForSlides } from './material-document';
import type { MultimodalChatPort } from './multimodal-chat-provider';
import {
  applyRasterBudget,
  createRasterAllowance,
  DEFAULT_IMAGE_BUDGET,
  isRasterVisual,
  type RasterAllowance,
  rasterBudgetInstruction,
} from './raster-budget';
import { completeStructuredJson } from './structured-json-chat';
import {
  needsGeneratedVisual,
  planPresentationVisualDirection,
  type PresentationVisualDirection,
  presentationVisualDirectionSchema,
} from './visual-direction';

export const formulaSourceSchema = z
  .object({
    id: z.string().regex(/^[\w-]{1,80}$/u),
    latex: z.string().trim().min(1).max(2000),
    explanation: z.string().max(1000).optional(),
    placement: z.enum(['slide', 'notes']).optional(),
    display: z.boolean().optional(),
    fontSize: z.number().finite().min(24).max(64).optional(),
    measurement: z
      .object({
        fontSize: z.number().positive(),
        width: z.number().positive(),
        height: z.number().positive(),
        minRectWidth: z.number().positive(),
        minRectHeight: z.number().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const visualRequirementSchema = z
  .object({
    id: z.string().regex(/^[\w-]{1,80}$/u),
    kind: z.enum([
      'illustration',
      'photograph',
      'scientific-illustration',
      'scientific-diagram',
      'chart',
      'source-figure',
      // Isolated decoration: emoji-like marks, corner ornaments, small badges.
      'sticker',
    ]),
    brief: z.string().min(1).max(1600),
    required: z.boolean().default(true),
    renderer: z.enum(['image', 'native']).optional(),
    fidelity: z.enum(['conceptual', 'computed']).optional(),
    /** One owner for internal labels/relations: the bitmap or an explicit vector overlay. */
    annotationMode: z.enum(['embedded', 'overlay']).optional(),
    /**
     * Precise relations the bitmap must not paint: the server draws them as editable vectors
     * over the artwork, in asset-local 0..1 coordinates so they follow the placed image.
     */
    annotations: assetAnnotationsSchema,
  })
  .strict();
export type VisualRequirement = z.infer<typeof visualRequirementSchema>;
export { isNativeVisual, isRasterVisual } from './raster-budget';

export const visualAssetBindingSchema = z
  .object({
    visualId: z.string(),
    kind: visualRequirementSchema.shape.kind,
    ref: z.string(),
    origin: z.enum(['generated', 'provided']),
    /**
     * Server-measured cutout fact. `opaque` means the cutout workflow returned a bitmap without
     * usable transparency, so the asset must not be treated as a floating decoration.
     */
    transparency: z.enum(['verified', 'opaque']).optional(),
  })
  .strict();
export type VisualAssetBinding = z.infer<typeof visualAssetBindingSchema>;
export const readVisualAssetBindings = (value: unknown): VisualAssetBinding[] => {
  const parsed = z.array(visualAssetBindingSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
};

export const visualRequirements = (intent?: SlideContentIntent): VisualRequirement[] =>
  intent
    ? (intent.visuals ??
      (intent.visualKind === 'none'
        ? []
        : [
            {
              id: `visual-${intent.slideId}`,
              kind: intent.visualKind,
              brief: intent.visualReason,
              required: true,
            },
          ]))
    : [];

export const slideContentIntentSchema = z
  .object({
    slideId: z.string().min(1).max(120),
    claim: z.string().min(1).max(500),
    formulas: z.array(formulaSourceSchema).max(4),
    visualKind: z.enum([
      'none',
      'illustration',
      'photograph',
      'scientific-illustration',
      'scientific-diagram',
      'chart',
      'source-figure',
      'sticker',
    ]),
    visualReason: z.string().min(1).max(1200),
    visuals: z.array(visualRequirementSchema).max(6).optional(),
  })
  .strict();

export type SlideContentIntent = z.infer<typeof slideContentIntentSchema>;

/** Normalized to the planner's 960-wide canvas, independent of source-template density. */
export const PRESENTATION_CONTENT_BUDGET = Object.freeze({
  maxBodyCharacters: 480,
  maxKeyPoints: 5,
  minBodyFontSize: 24,
  minLabelFontSize: 16,
});

export const contentInputFingerprint = (input: PresentationJobInput): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        outline: input.options?.outline,
        prompt: input.prompt,
        slideCount: input.slideCount,
        title: input.title,
        revision: input.options?.contentRevision,
        contractVersion: 10,
        learnedCapabilities: input.options?.learnedCapabilities,
        deckVisualSystem: input.options?.deckVisualSystem,
        visualEnrichment: input.options?.visualEnrichment,
        imageSlots: input.options?.imageSlots,
        lessonPlan: input.options?.lessonPlan,
        materials: input.options?.materials,
        sourceDocumentVisuals: input.options?.sourceDocumentVisuals,
      }),
    )
    .digest('hex');

export interface PresentationContentCompiler {
  compile: (
    input: PresentationJobInput,
    context: {
      scope: RuntimeScope;
      signal?: AbortSignal;
      /** Shared by every lesson stage so one deck never exceeds the raster budget. */
      rasterAllowance?: RasterAllowance;
    },
  ) => Promise<{
    inputFingerprint: string;
    visualDirection?: PresentationVisualDirection;
    slides: SlideContentIntent[];
  }>;
  prepareVisualDirection?: (
    input: PresentationJobInput,
    context: { scope: RuntimeScope; signal?: AbortSignal; rasterAllowance?: RasterAllowance },
  ) => Promise<PresentationJobInput>;
}

export interface PresentationContentCompilerOptions {
  readonly fallbackChat?: MultimodalChatPort;
  readonly imageGenerationAvailable?: boolean;
  /** Generated images one deck may plan; exceeded pages fall back to vector or typographic. */
  readonly maxRasterVisuals?: number;
}

export const createPresentationContentCompiler = (
  chat: MultimodalChatPort,
  defaultSlideCount = 8,
  options: PresentationContentCompilerOptions = {},
): PresentationContentCompiler => {
  const maxRasterVisuals = options.maxRasterVisuals ?? DEFAULT_IMAGE_BUDGET;
  return {
    async prepareVisualDirection(input, context) {
      const outline = input.options?.outline;
      const requested = input.options?.visualEnrichment as
        { mode?: string; slideNumbers?: number[] } | undefined;
      if (
        !Array.isArray(outline) ||
        !outline.length ||
        outline.length > 100 ||
        context.rasterAllowance ||
        readLessonPlan(input) ||
        options.imageGenerationAvailable !== true ||
        requested?.mode === 'off' ||
        requested?.slideNumbers?.length ||
        input.options?.contentRevision ||
        Array.isArray(input.options?.imageSlots)
      )
        return input;
      const existing = presentationVisualDirectionSchema.safeParse(input.options?.visualDirection);
      if (
        existing.success &&
        existing.data.slides.length === outline.length &&
        input.options?.visualDirectionFingerprint === contentInputFingerprint(input)
      )
        return input;
      const planned = await planPresentationVisualDirection(
        chat,
        input,
        maxRasterVisuals,
        context,
        options.fallbackChat,
      );
      return {
        ...input,
        options: {
          ...input.options,
          contentIntents: undefined,
          visualDirection: planned,
          visualDirectionFingerprint: contentInputFingerprint(input),
        },
      };
    },
    async compile(input, context) {
      const directedInput = (await this.prepareVisualDirection?.(input, context)) ?? input;
      if (directedInput !== input) return this.compile(directedInput, context);
      const allowance = context.rasterAllowance ?? createRasterAllowance(maxRasterVisuals);
      const lesson = readLessonPlan(input);
      if (lesson) {
        // Compile stages separately: a future answer/private cue must not influence
        // the image brief or formula extraction of an earlier question stage.
        const slides: SlideContentIntent[] = [];
        for (const stage of publicLessonStages(input)) {
          context.signal?.throwIfAborted();
          const compiled = await createPresentationContentCompiler(chat, 1, {
            fallbackChat: options.fallbackChat,
            imageGenerationAvailable: options.imageGenerationAvailable,
            maxRasterVisuals,
          }).compile(
            {
              ...input,
              prompt: `${LESSON_RENDERING_INSTRUCTIONS}\n${JSON.stringify(stage)}`,
              slideCount: 1,
              options: {
                outline: [
                  {
                    title: stage.title,
                    claim: stage.title,
                    keyPoints: stage.visibleContent,
                    visualSuggestion: stage.visualCue,
                  },
                ],
                lessonStage: stage,
              },
            },
            { ...context, rasterAllowance: allowance },
          );
          assertLessonPublicContent(lesson, slides.length, compiled.slides[0]);
          slides.push({ ...compiled.slides[0], slideId: stage.slideId });
        }
        return { inputFingerprint: contentInputFingerprint(input), slides };
      }
      const outline = Array.isArray(input.options?.outline) ? input.options.outline : [];
      const count = outline.length || input.slideCount || defaultSlideCount;
      if (!count || count < 1 || count > 100)
        throw new Error('Content compilation requires 1–100 confirmed slides');
      const requested = input.options?.visualEnrichment as
        { mode?: string; slideNumbers?: number[] } | undefined;
      const directionResult = presentationVisualDirectionSchema.safeParse(
        input.options?.visualDirection,
      );
      const direction =
        !input.options?.contentRevision &&
        directionResult.success &&
        directionResult.data.slides.length === count &&
        (context.rasterAllowance ||
          input.options?.visualDirectionFingerprint === contentInputFingerprint(input))
          ? directionResult.data
          : undefined;
      if (count > 4 && outline.length === count) {
        const slides: SlideContentIntent[] = [];
        const enrichment = input.options?.visualEnrichment as
          { mode?: string; slideNumbers?: number[] } | undefined;
        for (let start = 0; start < count; start += 4) {
          context.signal?.throwIfAborted();
          const numbers = Array.from(
            { length: Math.min(4, count - start) },
            (_, offset) => start + offset + 1,
          );
          const selected = enrichment?.slideNumbers?.filter((number) => numbers.includes(number));
          const batch = await createPresentationContentCompiler(
            chat,
            numbers.length,
            options,
          ).compile(
            {
              ...input,
              slideCount: numbers.length,
              options: {
                ...input.options,
                outline: outline.slice(start, start + numbers.length),
                originalSlideNumbers: numbers,
                ...(direction
                  ? {
                      visualDirection: {
                        ...direction,
                        slides: direction.slides
                          .slice(start, start + numbers.length)
                          .map((page, index) => ({ ...page, slideId: `slide-${index + 1}` })),
                      },
                    }
                  : {}),
                contentIntents: input.options?.contentIntents
                  ? {
                      slides: readContentIntents(input)
                        .slice(start, start + numbers.length)
                        .map((slide, index) => ({ ...slide, slideId: `slide-${index + 1}` })),
                    }
                  : undefined,
                visualEnrichment: {
                  ...enrichment,
                  mode:
                    enrichment?.mode === 'off' || (enrichment?.slideNumbers && !selected?.length)
                      ? 'off'
                      : 'auto',
                },
                imageSlots: Array.isArray(input.options?.imageSlots)
                  ? input.options.imageSlots.flatMap((slot: any) => {
                      const original = Number(String(slot.slideId).replace('slide-', ''));
                      const local = numbers.indexOf(original);
                      return local < 0 ? [] : [{ ...slot, slideId: `slide-${local + 1}` }];
                    })
                  : undefined,
              },
            },
            { ...context, rasterAllowance: allowance },
          );
          slides.push(
            ...batch.slides.map((slide, index) => ({
              ...slide,
              slideId: `slide-${numbers[index]}`,
            })),
          );
        }
        if (
          enrichment?.mode === 'required' &&
          !slides.some((slide) => slide.visuals?.some(isRasterVisual))
        )
          throw Object.assign(new Error('当前分镜没有提供要求的生图素材，请确认视觉用途后继续'), {
            code: 'PRESENTATION_VISUAL_PLAN_FAILED',
          });
        return {
          inputFingerprint: contentInputFingerprint(input),
          slides,
          ...(direction ? { visualDirection: direction } : {}),
        };
      }
      const { value } = await completeStructuredJson({
        chat,
        fallbackChat: options.fallbackChat,
        context,
        parse: async (candidate) => {
          const numbers = input.options?.originalSlideNumbers;
          if (
            candidate &&
            typeof candidate === 'object' &&
            'slides' in candidate &&
            Array.isArray(candidate.slides) &&
            Array.isArray(numbers) &&
            candidate.slides.length === numbers.length &&
            candidate.slides.every((slide, index) => slide?.slideId === `slide-${numbers[index]}`)
          ) {
            candidate = {
              ...candidate,
              slides: candidate.slides.map((slide, index) => ({
                ...slide,
                slideId: `slide-${index + 1}`,
              })),
            };
          }
          if (
            count === 1 &&
            candidate &&
            typeof candidate === 'object' &&
            'slideId' in candidate &&
            !('slides' in candidate)
          )
            candidate = { slides: [candidate] };
          if (
            count === 1 &&
            candidate &&
            typeof candidate === 'object' &&
            'slides' in candidate &&
            Array.isArray(candidate.slides) &&
            candidate.slides.length === 1 &&
            Array.isArray(input.options?.originalSlideNumbers) &&
            candidate.slides[0]?.slideId === `slide-${input.options.originalSlideNumbers[0]}`
          )
            candidate = { ...candidate, slides: [{ ...candidate.slides[0], slideId: 'slide-1' }] };
          const result = z
            .object({
              slides: z
                .array(
                  slideContentIntentSchema.extend({
                    visuals: z
                      .array(
                        visualRequirementSchema
                          .extend({
                            // Echoed refs are not bindings. The asset phase verifies ownership/routing.
                            ref: z
                              .string()
                              .refine(
                                (ref) =>
                                  Array.isArray(input.options?.availableAssetRefs) &&
                                  input.options.availableAssetRefs.includes(ref),
                                'Only an offered asset ref may be echoed',
                              )
                              .optional(),
                          })
                          .transform(({ ref: _ref, ...requirement }) => requirement),
                      )
                      .max(6),
                  }),
                )
                .length(count),
            })
            .strict()
            .parse(candidate);
          for (const [index, slide] of result.slides.entries()) {
            if (slide.slideId !== `slide-${index + 1}`)
              throw new Error('Content intents must preserve slide order and identity');
            const pageDirection = direction?.slides[index];
            const disabled =
              requested?.mode === 'off' || options.imageGenerationAvailable === false;
            if (pageDirection || disabled) {
              // The whole-deck decision owns artwork allocation; batches cannot
              // consume later pages' budget or silently omit a selected figure.
              const native = slide.visuals.flatMap((visual) =>
                !isRasterVisual(visual)
                  ? [visual]
                  : ['chart', 'scientific-diagram'].includes(visual.kind)
                    ? [{ ...visual, renderer: 'native' as const }]
                    : [],
              );
              if (!disabled && pageDirection && needsGeneratedVisual(pageDirection)) {
                const proposed = slide.visuals.find(isRasterVisual);
                const generated =
                  proposed && !native.some((visual) => visual.id === proposed.id)
                    ? proposed
                    : undefined;
                native.push({
                  ...(generated ?? {
                    id: 'autonomous-visual',
                    kind: 'illustration',
                    renderer: 'image',
                    fidelity: 'conceptual',
                  }),
                  required: true,
                  brief: [pageDirection.visualBrief!.slice(0, 1000), generated?.brief.slice(0, 600)]
                    .filter(Boolean)
                    .join('\n')
                    .slice(0, 1600),
                });
              }
              slide.visuals = native;
              slide.visualKind = native[0]?.kind ?? 'none';
              if (!native.length)
                slide.visualReason =
                  pageDirection?.reason ?? '保留可编辑表达与原始资料，不新增生成图片';
            }
            if (new Set(slide.formulas.map((formula) => formula.id)).size !== slide.formulas.length)
              throw new Error('Formula ids must be unique per slide');
            if (
              slide.visuals &&
              new Set(slide.visuals.map((visual) => visual.id)).size !== slide.visuals.length
            )
              throw new Error('Visual ids must be unique per slide');
            for (const visual of slide.visuals ?? []) {
              if (isRasterVisual(visual) && visual.fidelity === 'conceptual')
                visual.annotationMode ??= 'embedded';
              // A source figure is an existing bitmap, not an instruction to call
              // image generation. Normalize the model's renderer shorthand; the
              // asset planner still requires an owned, provided source reference.
              if (visual.kind === 'source-figure') delete visual.renderer;
              if (visual.fidelity === 'computed' && isRasterVisual(visual))
                throw new Error(
                  'Compute quantitative geometry with the native renderer; use a separate image visual for conceptual explanation.',
                );
            }
            const stage = input.options?.lessonStage as
              { boardSpace?: string; kind?: string } | undefined;
            if (stage?.kind === 'cover') {
              // Teaching covers carry the course title and pause. Decorative model
              // imagery is not a scientific subject and easily overwhelms the opening.
              slide.visuals = (slide.visuals ?? []).filter(
                (visual) => visual.kind === 'source-figure',
              );
              if (!slide.visuals.length) {
                slide.visualKind = 'none';
                slide.visualReason = 'Typographic academic cover with deliberate whitespace';
              }
            }
            const bounds = contentLayout(stage?.boardSpace, input.aspectRatio);
            const { fitFormula, measureFormula } = await import('./formula-renderer');
            for (const formula of slide.formulas) {
              context.signal?.throwIfAborted();
              // Measurements are server-derived. Never trust model-supplied dimensions.
              const source = {
                latex: formula.latex,
                display: formula.display ?? true,
                fontSize: formula.fontSize ?? 28,
              };
              if (formula.placement === 'notes') {
                try {
                  formula.measurement = await measureFormula(source);
                } catch {
                  // Speaker notes export the LaTeX as text; there is no glyph to vectorize.
                }
                continue;
              }
              try {
                Object.assign(formula, await fitFormula(source, bounds));
              } catch {
                // MathJax cannot vectorize a formula that carries explanatory prose (CJK inside
                // \text{}) or raw angle brackets. An undrawable page must not fail the deck, so
                // the exact LaTeX and its explanation move to the speaker notes unchanged.
                formula.placement = 'notes';
              }
            }
          }
          const enrichment = input.options?.visualEnrichment as { mode?: string } | undefined;
          if (
            enrichment?.mode === 'required' &&
            !result.slides.some((slide) => slide.visuals?.some(isRasterVisual))
          )
            throw new Error(
              'The user requires generated visuals: plan at least one meaningful renderer:image asset, while keeping factual data native.',
            );
          return { ...result, slides: applyRasterBudget(result.slides, allowance, input).slides };
        },
        request: {
          model: chat.manifest.model,
          response_format: { type: 'json_object' },
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                '资料处理阶段的操作要求（例如“本轮只做分镜、不生图”）用于安排工具，不是报告正文，不作为页面事实或讲稿内容。当前制作阶段以当前prompt的交付要求为准；保留主题事实、来源、预算/计划口径与必要样例性质。',
            },
            { role: 'system', content: MATERIAL_GROUNDING_INSTRUCTIONS },
            {
              role: 'system',
              content: `你是演示内容编译器。把已确认大纲逐页转换为内容意图，保留页序、事实与核心教学内容。提取正确LaTeX，不编造数据、公式与来源。输出JSON {slides:[{slideId:"slide-1",claim:"当前标题或问题",formulas:[{id:"formula-1",latex:"LaTeX",explanation:"变量说明",fontSize:28,placement:"slide"}],visualKind:"none|illustration|photograph|scientific-illustration|scientific-diagram|chart|source-figure",visualReason:"视觉目的",visuals:[{id:"visual-1",kind:"scientific-diagram",renderer:"image",fidelity:"conceptual",brief:"可验证的视觉需求",required:true}]}]}。最多4个公式。不要Markdown。`,
            },
            {
              role: 'system',
              content:
                '视觉类型kind与绘制工具renderer必须分开。贴纸、表情包、角标、小徽章这类纯装饰用 kind:"sticker"：只画一个孤立主体，不带文字、不带整幅背景；服务端会自动抠图成透明并小尺寸落位，所以不要在 sticker 上要求背景、场景或图注。工作汇报中的表格、指标矩阵、对比与明确节点流程优先renderer:native（表格用kind:chart，流程用kind:scientific-diagram），保持数字、状态、文字和关系可编辑；表格brief列出有来源的完整行列。复杂科研机制、实验装置、主体插画才优先renderer:image；brief明确部件、关系和箭头，不允许多余拼贴、照片条或无关装饰。选择image渲染的概念性框架图、流程图、知识地图使用 annotationMode:"embedded"：生图负责图内短标签、连接线与箭头，SVG只负责图外标题正文，不再叠加同一套标签和箭头。不要在看到真实图片之前猜测对象坐标。只有确实需要独立编辑、且按确定布局约束生成的精确几何标注才用 annotationMode:"overlay" 与 visuals[].annotations：{type:"vector"|"guide"|"label", from/to 或 at（实际图像内 0 到 1 的相对坐标）, label 或 text（不超过 24 字）, color?}；此模式下图片禁止同名标签与箭头，服务端按真实图像比例投影。定量或严格几何关系优先native，由服务端计算。科研图默认简洁的二维学术图、实物照片或可核实原始资料；没有定义函数与数据时，不生成装饰性三维曲面、发光光轨和空泛科技背景。需要精确函数、等高线、泰勒逼近、迭代轨迹、实验数值的图选renderer:native,fidelity:computed，交给可复算模型或有来源数据，禁止手填看似正确的点。仅解释概念、不声称定量结果时用fidelity:conceptual，可以生图。复杂页面可以拆成一个image机制图和一个native数据块，不用整页禁用生图。论文原图source-figure只复用。不要强制每页配图。概念/框架/机制图不用添加“示意图·非实测”免责声明；数据图则保留真实来源和实验设置。数学公式默认28px，由服务器测量和等价换行，不能虚构measurement。板书页预算为左侧544px净宽。教学封面优先只用课程标题、统一色彩和留白；没有内容意义的AI背景会被服务端移除。',
            },
            {
              role: 'user',
              content: JSON.stringify({
                title: input.title,
                prompt: input.prompt,
                outline,
                materials: materialContextForSlides(input.options?.materials, outline),
                slideCount: count,
                revision: input.options?.contentRevision,
                previousContent: input.options?.contentIntents,
                sourceDocumentVisuals: input.options?.sourceDocumentVisuals,
                availableAssetRefs: input.options?.availableAssetRefs,
                requestedImageSlots: input.options?.imageSlots,
                teachingStage: input.options?.lessonStage,
                rasterBudget: rasterBudgetInstruction(allowance),
                visualEnrichment: {
                  requested: input.options?.visualEnrichment ?? { mode: 'auto' },
                  available: options.imageGenerationAvailable !== false,
                  instruction:
                    (input.options?.visualEnrichment as { mode?: string } | undefined)?.mode ===
                    'off'
                      ? '当前页或批次不新增生图，保留原始资料图和可编辑内容。'
                      : options.imageGenerationAvailable === false
                        ? '当前没有可用生图服务，不得声称已生成图片。明确要求生图时应报告配置问题。'
                        : '主动评估每页是否需要视觉补充：在应用场景、未来方案、概念解释、合作机制等适合页面，原始资料图不能充分表达时，规划1–3个有明确内容作用的原创插画或场景素材，并通过renderer:image调用生图。不要把所有工作汇报默认处理成纯表格；也不要为了凑数量每页生图。保留数字、表格与真实资料图，禁止虚构成果照片、机构标志或实测数据。整稿共享字体、配色和图像风格，生成素材只占内容区，禁止替换整张母版或将正文烘焙进背景。',
                },
                originalSlideNumbers: input.options?.originalSlideNumbers,
                visualDirection: direction,
                learnedCapabilities: input.options?.learnedCapabilities,
                deckVisualSystem: input.options?.deckVisualSystem,
                assetPolicy:
                  '若有requestedImageSlots，保留其slideId和slotId作为相应栅格visual的id；这些是用户明确要求的配图，也要纳入逐块规划。sourceDocumentVisuals是已验证的原始文档图表，已有匹配原图时优先用source-figure直接复用，不填renderer:image，不生成、不猜测重绘原图数据；brief写清原图引用和出处。',
                revisionPolicy:
                  '有本轮修改时，以用户本轮要求更新公式或表达类型；没有要求改动的内容保持原语义。未选中的页面不得改变。',
              }),
            },
            ...(input.options?.lessonStage
              ? [
                  {
                    role: 'system' as const,
                    content:
                      LESSON_RENDERING_INSTRUCTIONS +
                      '输出slideId固定为slide-1，服务端按阶段重新绑定。claim可为当前问题或标题，不得擅自回答问题。',
                  },
                ]
              : []),
          ],
        },
      });
      return {
        ...value,
        inputFingerprint: contentInputFingerprint(input),
        ...(direction ? { visualDirection: direction } : {}),
      };
    },
  };
};

export const readContentIntents = (input: PresentationJobInput): SlideContentIntent[] => {
  const value = input.options?.contentIntents as { slides?: unknown } | undefined;
  return value ? z.array(slideContentIntentSchema).parse(value.slides) : [];
};

export const CONTENT_RENDERING_INSTRUCTIONS = `每页围绕一个明确任务组织信息；封面、章节和收束页留白，汇报数据/对比页使用完整表格、图表与关键结论，教学页按讲解步骤组织。正文至少24px，原生表格18–24px，短标签/坐标/页脚至少16px。大纲要点只是内容，不代表项目符号列表；默认用短句、分栏或留白组织，不添加Markdown圆点、星号或破折号，只有用户或模板明确要求列表时才保留。先留真实图像与公式区域，再排文字；借鉴模板的信息层级和图文比例，正文保留核心事实与比较维度，不把关键事实全部转移到备注。公式用formula节点渲染，使用编译器给出的完整latex、measurement字号和尺寸；不能缩字或改变数学含义。板书页左侧净宽544，右侧三分之一留白，不跨栏。按visuals.renderer选工具：image的科研/框架/流程图用已生成的真实image资产，native的表格、流程和计算图必须用同id scientific-diagram节点；不把image图重复绘制为plot/graph。annotationMode:embedded的图内文字和箭头已经属于图片，不在SVG里重写或补箭头；overlay模式只由服务端添加已声明的标注。计算轨迹使用可复算quadratic/taylor模型或有来源数据，不让模型猜坐标。纯概念图不添加“示意图/非实测/AI生成”通用标签，数据性质保存在metadata与备注，需要避免误解的模拟数据应说明实验设置。source-figure保留原图，出处默认存讲者备注，必要时在对应图旁简短标注，不统一添加资料来源页脚。SVG用空<g data-content-id="块id"/>放置公式/计算图，服务端绘制，不重复画内容。`;
