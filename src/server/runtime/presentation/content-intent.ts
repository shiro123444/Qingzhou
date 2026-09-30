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
        contractVersion: 4,
        imageSlots: input.options?.imageSlots,
        lessonPlan: input.options?.lessonPlan,
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
    slides: SlideContentIntent[];
  }>;
}

export interface PresentationContentCompilerOptions {
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
    async compile(input, context) {
      const allowance = context.rasterAllowance ?? createRasterAllowance(maxRasterVisuals);
      const lesson = readLessonPlan(input);
      if (lesson) {
        // Compile stages separately: a future answer/private cue must not influence
        // the image brief or formula extraction of an earlier question stage.
        const slides: SlideContentIntent[] = [];
        for (const stage of publicLessonStages(input)) {
          context.signal?.throwIfAborted();
          const compiled = await createPresentationContentCompiler(chat, 1, {
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
      const { value } = await completeStructuredJson({
        chat,
        context,
        parse: async (candidate) => {
          const result = z
            .object({
              slides: z
                .array(
                  slideContentIntentSchema.extend({
                    visuals: z.array(visualRequirementSchema).max(6),
                  }),
                )
                .length(count),
            })
            .strict()
            .parse(candidate);
          for (const [index, slide] of result.slides.entries()) {
            if (slide.slideId !== `slide-${index + 1}`)
              throw new Error('Content intents must preserve slide order and identity');
            if (new Set(slide.formulas.map((formula) => formula.id)).size !== slide.formulas.length)
              throw new Error('Formula ids must be unique per slide');
            if (
              slide.visuals &&
              new Set(slide.visuals.map((visual) => visual.id)).size !== slide.visuals.length
            )
              throw new Error('Visual ids must be unique per slide');
            for (const visual of slide.visuals ?? []) {
              if (visual.kind === 'source-figure' && visual.renderer === 'image')
                throw new Error('Source figures must be reused, never generated.');
              if (visual.fidelity === 'computed' && isRasterVisual(visual))
                throw new Error(
                  'Compute quantitative geometry with the native renderer; use a separate image visual for conceptual explanation.',
                );
            }
            const stage = input.options?.lessonStage as
              | { boardSpace?: string; kind?: string }
              | undefined;
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
          return { ...result, slides: applyRasterBudget(result.slides, allowance, input).slides };
        },
        request: {
          model: chat.manifest.model,
          response_format: { type: 'json_object' },
          temperature: 0,
          messages: [
            {
              role: 'system',
              content: `你是演示内容编译器。把已确认大纲逐页转换为内容意图，保留页序、事实与核心教学内容。提取正确LaTeX，不编造数据、公式与来源。输出JSON {slides:[{slideId:"slide-1",claim:"当前标题或问题",formulas:[{id:"formula-1",latex:"LaTeX",explanation:"变量说明",fontSize:28,placement:"slide"}],visualKind:"none|illustration|photograph|scientific-illustration|scientific-diagram|chart|source-figure",visualReason:"视觉目的",visuals:[{id:"visual-1",kind:"scientific-diagram",renderer:"image",fidelity:"conceptual",brief:"可验证的视觉需求",required:true}]}]}。最多4个公式。不要Markdown。`,
            },
            {
              role: 'system',
              content:
                '视觉类型kind与绘制工具renderer必须分开。贴纸、表情包、角标、小徽章这类纯装饰用 kind:"sticker"：只画一个孤立主体，不带文字、不带整幅背景；服务端会自动抠图成透明并小尺寸落位，所以不要在 sticker 上要求背景、场景或图注。框架图、流程图、机制图、实验装置图、概念性科研图优先renderer:image，不限于装饰配图；brief明确部件、关系和箭头，不允许多余拼贴、照片条或无关装饰。框架图/机制图/装置图里凡是方向性箭头、引线、共线/切向/法向关系和关键标签，都要写进 visuals[].annotations：{type:"vector"|"guide"|"label", from/to 或 at（图内 0 到 1 的相对坐标）, label 或 text（不超过 24 字）, color?}；这些由服务端在生图之上用矢量叠加，所以生图只画图形本体，不要把方向性箭头、引线和关键标签烧进图里。科研图默认简洁的二维学术图、实物照片或可核实原始资料；没有定义函数与数据时，不生成装饰性三维曲面、发光光轨和空泛科技背景。需要精确函数、等高线、泰勒逼近、迭代轨迹、实验数值的图选renderer:native,fidelity:computed，交给可复算模型或有来源数据，禁止手填看似正确的点。仅解释概念、不声称定量结果时用fidelity:conceptual，可以生图。复杂页面可以拆成一个image机制图和一个native数据块，不用整页禁用生图。论文原图source-figure只复用。不要强制每页配图。概念/框架/机制图不用添加“示意图·非实测”免责声明；数据图则保留真实来源和实验设置。数学公式默认28px，由服务器测量和等价换行，不能虚构measurement。板书页预算为左侧544px净宽。教学封面优先只用课程标题、统一色彩和留白；没有内容意义的AI背景会被服务端移除。',
            },
            {
              role: 'user',
              content: JSON.stringify({
                title: input.title,
                prompt: input.prompt,
                outline,
                slideCount: count,
                revision: input.options?.contentRevision,
                previousContent: input.options?.contentIntents,
                requestedImageSlots: input.options?.imageSlots,
                teachingStage: input.options?.lessonStage,
                rasterBudget: rasterBudgetInstruction(allowance),
                assetPolicy:
                  '若有requestedImageSlots，保留其slideId和slotId作为相应栅格visual的id；这些是用户明确要求的配图，也要纳入逐块规划。',
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
      return { ...value, inputFingerprint: contentInputFingerprint(input) };
    },
  };
};

export const readContentIntents = (input: PresentationJobInput): SlideContentIntent[] => {
  const value = input.options?.contentIntents as { slides?: unknown } | undefined;
  return value ? z.array(slideContentIntentSchema).parse(value.slides) : [];
};

export const CONTENT_RENDERING_INSTRUCTIONS = `每页只承担一个讲解动作，不强求3–5要点；允许封面、单图、提问和停顿。正文至少24px，短标签/坐标/页脚至少16px。先留真实图像与公式区域，再排文字；不要复制模板密集正文。公式用formula节点渲染，使用编译器给出的完整latex、measurement字号和尺寸；不能缩字或改变数学含义。板书页左侧净宽544，右侧三分之一留白，不跨栏。按visuals.renderer选工具：image的科研/框架/流程图用已生成的真实image资产，native的计算图用同id scientific-diagram节点；不把image图重复绘制为plot/graph。计算轨迹使用可复算quadratic/taylor模型或有来源数据，不让模型猜坐标。纯概念图不添加“示意图/非实测/AI生成”通用标签，数据性质保存在metadata与备注，需要避免误解的模拟数据应说明实验设置。source-figure保留原图与出处。SVG用空<g data-content-id="块id"/>放置公式/计算图，服务端绘制，不重复画内容。`;
