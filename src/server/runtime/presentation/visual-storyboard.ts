import { createHash } from 'node:crypto';

import { z } from 'zod';

import type {
  PresentationJobInput,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import { isReusableTemplateComponent } from './artwork-pipeline';
import { isRasterVisual, readContentIntents, visualRequirements } from './content-intent';
import { LESSON_RENDERING_INSTRUCTIONS, publicLessonStages } from './lesson';
import { materialContextForSlides } from './material-document';
import type { GLMMultimodalChatPort } from './multimodal-chat-provider-glm';
import { formulasFitWithFigure } from './page-budget';
import { completeStructuredJson } from './structured-json-chat';
import type { TemplateApplication } from './templates';

export const presentationVisualStoryboardSchema = z
  .object({
    deckRationale: z.string().min(1).max(2400),
    inputFingerprint: z.string().regex(/^[a-f\d]{40}$/u),
    rhythm: z.array(z.string().min(1).max(500)).min(1).max(16),
    schemaVersion: z.literal(1),
    slides: z
      .array(
        z
          .object({
            archetypeId: z.string().min(1).max(80),
            assetBrief: z.string().min(1).max(1600).optional(),
            assetMode: z.enum(['none', 'reuse', 'generate', 'native', 'mixed']),
            componentIds: z.array(z.string().min(1).max(80)).max(12),
            compositionIntent: z.string().min(1).max(1600),
            continuity: z.string().min(1).max(1000),
            familyId: z.string().min(1).max(60),
            layoutId: z.string().min(1).max(120).optional(),
            role: z.enum([
              'cover',
              'section',
              'content',
              'comparison',
              'process',
              'data',
              'closing',
            ]),
            slideId: z.string().min(1).max(120),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    templateId: z.string().min(1).max(160),
    versionId: z.string().min(1).max(160),
  })
  .strict();

export type PresentationVisualStoryboard = z.infer<typeof presentationVisualStoryboardSchema>;

export interface PresentationVisualStoryboardPlanner {
  plan: (
    input: { readonly jobInput: PresentationJobInput; readonly template: TemplateApplication },
    context: { readonly scope: RuntimeScope; readonly signal?: AbortSignal },
  ) => Promise<PresentationVisualStoryboard>;
}

export const presentationStoryboardInputFingerprint = (input: PresentationJobInput): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        outline: input.options?.outline,
        prompt: input.prompt,
        slideCount: input.slideCount,
        title: input.title,
        contentFingerprint: (
          input.options?.contentIntents as { inputFingerprint?: string } | undefined
        )?.inputFingerprint,
        templateSources: input.options?.templateSources,
        materials: input.options?.materials,
      }),
    )
    .digest('hex')
    .slice(0, 40);

interface OutlineSlide {
  readonly claim?: string;
  readonly keyPoints?: unknown;
  readonly objective?: string;
  readonly sourceRefs?: unknown;
  readonly title?: string;
  readonly visualSuggestion?: string;
}

const storyboardError = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'PRESENTATION_INVALID' });
};

const boundedText = (value: unknown, maximum: number): unknown => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`;
};

const boundedProse = (value: unknown, maximum: number): unknown => {
  if (typeof value === 'string') return boundedText(value, maximum);
  if (value && typeof value === 'object') {
    try {
      return boundedText(JSON.stringify(value), maximum);
    } catch {
      return value;
    }
  }
  return value;
};

const optionalProse = (value: unknown, maximum: number): unknown => {
  const prose = boundedProse(value, maximum);
  return prose === null || prose === '' ? undefined : prose;
};

/** Project model output onto the trusted contract while preserving strict semantic validation. */
const normalizeStoryboardCandidate = (
  value: unknown,
  binding: Pick<PresentationVisualStoryboard, 'inputFingerprint' | 'templateId' | 'versionId'>,
): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  // The prompt documents the fields inside a `contract`/`binding` envelope, so models answer
  // with that wrapper even though this contract is flat. Accept both shapes and drop the
  // envelope keys, leaving strict validation to guard every other key.
  const { binding: _binding, contract, ...flat } = record;
  const source =
    contract && typeof contract === 'object' && !Array.isArray(contract)
      ? { ...(contract as Record<string, unknown>), ...flat }
      : flat;
  const slides = Array.isArray(source.slides)
    ? source.slides.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const slide = item as Record<string, unknown>;
        const assetBrief = optionalProse(slide.assetBrief, 1600);
        const layoutId = optionalProse(slide.layoutId, 120);
        return {
          archetypeId: boundedText(slide.archetypeId, 80),
          ...(assetBrief === undefined ? {} : { assetBrief }),
          assetMode: slide.assetMode,
          componentIds: Array.isArray(slide.componentIds)
            ? slide.componentIds.slice(0, 12).map((id) => boundedText(id, 80))
            : slide.componentIds,
          compositionIntent: boundedProse(slide.compositionIntent, 1600),
          continuity: boundedProse(slide.continuity, 1000),
          familyId: boundedText(slide.familyId, 60),
          ...(layoutId === undefined ? {} : { layoutId }),
          role: slide.role,
          slideId: boundedText(slide.slideId, 120),
        };
      })
    : source.slides;
  return {
    deckRationale: boundedProse(source.deckRationale, 2400),
    inputFingerprint: source.inputFingerprint ?? binding.inputFingerprint,
    rhythm: Array.isArray(source.rhythm)
      ? source.rhythm.slice(0, 16).map((item) => boundedProse(item, 500))
      : source.rhythm,
    schemaVersion: source.schemaVersion ?? 1,
    slides,
    templateId: boundedText(source.templateId ?? binding.templateId, 160),
    versionId: boundedText(source.versionId ?? binding.versionId, 160),
  };
};

const outlineSlides = (input: PresentationJobInput): OutlineSlide[] =>
  Array.isArray(input.options?.outline)
    ? input.options.outline.filter(
        (slide): slide is OutlineSlide => Boolean(slide) && typeof slide === 'object',
      )
    : [];

/**
 * Translate a learned template into a deck-level visual story before any page is composed.
 * This prevents each slide planner from independently guessing what "apply this template" means.
 */
export const createPresentationVisualStoryboardPlanner = (options: {
  readonly chat: GLMMultimodalChatPort;
}): PresentationVisualStoryboardPlanner => ({
  plan: async ({ jobInput, template }, context) => {
    const design = template.visual?.designProgram;
    if (!design) return storyboardError('A learned template design program is required');
    const outline = outlineSlides(jobInput);
    const contentIntents = readContentIntents(jobInput);
    const count = outline.length || jobInput.slideCount;
    if (!count || !Number.isInteger(count) || count < 1 || count > 100) {
      return storyboardError('A confirmed outline or slide count is required for template mapping');
    }
    const briefs = Array.from({ length: count }, (_, index) => ({
      claim: outline[index]?.claim,
      keyPoints: outline[index]?.keyPoints,
      objective: outline[index]?.objective,
      slideId: `slide-${index + 1}`,
      title: outline[index]?.title ?? (index === 0 ? jobInput.title : `第 ${index + 1} 页`),
      visualSuggestion: outline[index]?.visualSuggestion,
      sourceRefs: outline[index]?.sourceRefs,
    }));
    const familyIds = new Set(template.visual!.families.map((family) => family.id));
    const archetypes = new Map(design.archetypes.map((item) => [item.id, item]));
    const layoutIds = new Set(template.layouts.map((layout) => layout.layoutId));
    const components = new Map(template.visual!.components.map((item) => [item.id, item]));
    const inputFingerprint = presentationStoryboardInputFingerprint(jobInput);

    const result = await completeStructuredJson({
      chat: options.chat,
      context: {
        idempotencyKey: `template-storyboard:${template.versionId}:${inputFingerprint}`,
        scope: context.scope,
        signal: context.signal,
      },
      emptyError: '模板视觉故事板未返回可解析的 JSON',
      parse: (value) => {
        const parsed = presentationVisualStoryboardSchema.parse(
          normalizeStoryboardCandidate(value, {
            inputFingerprint,
            templateId: template.templateId,
            versionId: template.versionId,
          }),
        );
        if (parsed.slides.length !== briefs.length) {
          return storyboardError('Visual storyboard must map every slide exactly once');
        }
        if (parsed.templateId !== template.templateId || parsed.versionId !== template.versionId) {
          return storyboardError(
            'Visual storyboard must stay bound to the selected template version',
          );
        }
        if (parsed.inputFingerprint !== inputFingerprint) {
          return storyboardError('Visual storyboard must stay bound to the current outline');
        }
        const bySlide = new Map(parsed.slides.map((slide) => [slide.slideId, slide]));
        if (bySlide.size !== briefs.length) {
          return storyboardError('Visual storyboard contains duplicate slide ids');
        }
        const normalizedSlides = briefs.map((brief, index) => {
          const slide = bySlide.get(brief.slideId);
          if (!slide) return storyboardError(`Visual storyboard omitted ${brief.slideId}`);
          const intent = contentIntents.find((item) => item.slideId === slide.slideId);
          if (intent) {
            const visuals = visualRequirements(intent);
            const raster = visuals.filter(isRasterVisual);
            if (raster.length) {
              slide.assetMode = visuals.some((v) => !isRasterVisual(v)) ? 'mixed' : 'generate';
              slide.assetBrief = raster.map((v) => `${v.id}: ${v.brief}`).join('\n');
            } else {
              slide.assetMode = visuals.some((v) => v.kind === 'source-figure')
                ? 'reuse'
                : 'native';
              slide.assetBrief = undefined;
            }
          }
          if (['generate', 'mixed'].includes(slide.assetMode) && !slide.assetBrief) {
            return storyboardError(
              `第 ${index + 1} 页需要生成素材，请补充主体、画风与留白方向（assetBrief）`,
            );
          }
          const exactArchetype = archetypes.get(slide.archetypeId);
          const familyArchetypes = design.archetypes.filter(
            (item) => item.familyId === slide.familyId,
          );
          const measuredHeights =
            intent?.formulas.flatMap((formula) =>
              formula.measurement ? [formula.measurement.minRectHeight] : [],
            ) ?? [];
          const figurePage =
            measuredHeights.length > 0 &&
            measuredHeights.length === (intent?.formulas.length ?? 0) &&
            visualRequirements(intent).some(
              (visual) => visual.required && isRasterVisual(visual),
            ) &&
            !formulasFitWithFigure(measuredHeights);
          const specific = familyArchetypes.find((item) =>
            figurePage
              ? item.id.endsWith('-figure')
              : item.roles.length <= 2 && item.roles.includes(slide.role),
          );
          const archetype =
            (exactArchetype && exactArchetype.roles.length <= 2 ? exactArchetype : undefined) ??
            specific ??
            exactArchetype ??
            familyArchetypes.find((item) => item.roles.includes(slide.role)) ??
            (familyArchetypes.length === 1 ? familyArchetypes[0] : undefined);
          if (!archetype) return storyboardError('Visual storyboard selected an unknown archetype');
          if (!familyIds.has(archetype.familyId)) {
            return storyboardError('Visual storyboard selected an unknown visual family');
          }
          const role = archetype.roles.includes(slide.role)
            ? slide.role
            : index === 0 && archetype.roles.includes('cover')
              ? 'cover'
              : index === briefs.length - 1 && archetype.roles.includes('closing')
                ? 'closing'
                : archetype.roles.includes('content')
                  ? 'content'
                  : archetype.roles[0];
          if (!role) return storyboardError('Visual storyboard selected an incompatible role');
          const componentIds = slide.componentIds.map((componentId) => {
            const exact = components.get(componentId);
            const suffixMatches = [...components.values()].filter(
              (component) =>
                component.familyId === archetype.familyId &&
                component.id.endsWith(`-${componentId}`),
            );
            const component = exact ?? (suffixMatches.length === 1 ? suffixMatches[0] : undefined);
            if (
              !component ||
              (component.familyId !== archetype.familyId &&
                !template.componentSources?.[component.id]) ||
              !isReusableTemplateComponent(component)
            ) {
              return storyboardError(
                'Visual storyboard attempted to reuse an unsafe template component',
              );
            }
            if (component.role === 'artwork' && !slide.assetBrief) {
              return storyboardError(
                'Reusing template artwork requires a subject-relevance explanation (assetBrief)',
              );
            }
            return component.id;
          });
          return {
            ...slide,
            archetypeId: archetype.id,
            componentIds,
            familyId: archetype.familyId,
            ...(slide.layoutId && layoutIds.has(slide.layoutId)
              ? { layoutId: slide.layoutId }
              : { layoutId: undefined }),
            role,
          };
        });
        return {
          ...parsed,
          slides: normalizedSlides,
        };
      },
      request: {
        max_tokens: 16_000,
        messages: [
          {
            content:
              '你是整稿视觉导演。模板观察结果是证据，不是逐页照抄命令。请先理解这份演示的叙事弧线，再为每页选择一个有证据的视觉族和构图原型。封面、章节、正文、数据和收束页应形成节奏；相邻页面保持锚点连续，同时避免机械重复。只有无旧文字、已获准复用的组件才可放入 componentIds。先在 reusableComponents 中寻找能服务本页内容的已有素材：背景、边框、装饰可以保持视觉连续；主体插画只有语义适合本页且明确获准 reuse/crop/removeBackground 时才复用，并在 assetBrief 解释其内容适配理由。不要把旧活动照片、数据证据或不相关人物替换成当前事实。只有缺少合适素材才生图。需要新画的插画、水彩或装饰主体时，assetMode 必须是 generate；已有素材与新素材组合时用 mixed，并把新增主体、画风、留白方向和前后层级写进 assetBrief。compositionIntent 必须说明文本与素材的相对位置、遮挡关系、尺度和裁切，不把整页拍平。准确图表、流程和文字结构使用 native。模板的卡片尺寸和文字密度只能是软参考；公式真实测量尺寸、科研图图例空间、24px正文与已批准素材槽位是硬预算，不能为了模仿模板压缩它们。embeddedMedia 来自真实视频抽帧或媒体元数据：可用于理解节奏、画风和槽位，静态 SVG 生成不能假装已经保留动态播放；需要动态保真时在构图意图中明确要求走原稿保真路径。不要因为模板有图片就强迫每页生图。严格返回 JSON。',
            role: 'system',
          },
          {
            content: JSON.stringify({
              contract: {
                deckRationale: '整稿设计理由（字符串，最多 2400 字符）',
                rhythm: ['页面节奏（1–16 个字符串，每项最多 500 字符）'],
                slides: [
                  {
                    slideId: '原样使用输入 slides 的 slideId；每页恰好一次',
                    archetypeId: 'designProgram.archetypes 中的真实 id',
                    familyId: '对应原型的 familyId',
                    role: 'cover | section | content | comparison | process | data | closing',
                    assetMode: 'none | reuse | generate | native | mixed',
                    componentIds: ['仅使用 reusableComponents 的真实 id；无需复用时返回 []'],
                    compositionIntent: '本页构图意图（字符串，最多 1600 字符）',
                    continuity: '与前后页的连续关系（字符串，最多 1000 字符）',
                    assetBrief:
                      'generate/mixed 时必填：新增主体、画风、留白方向与复用素材的组合关系；复用 artwork 时解释其与本页内容的适配理由（最多 1600 字符）',
                    layoutId: '可选，输入 layouts 中的真实 layoutId；未选时省略此字段',
                  },
                ],
              },
              binding:
                '模板身份、版本与输入指纹由服务端绑定，无需生成；若返回这些字段，必须与输入完全一致。',
              outputShape:
                '顶层直接返回上述字段（deckRationale、rhythm、slides），不要再包裹 contract 或 binding 层。',
            }),
            role: 'system',
          },
          {
            content: JSON.stringify({
              designProgram: design,
              userStyle: jobInput.options?.style,
              componentSelectionPolicy: '每个被选中的 artwork 主体必须在本页 assetBrief 解释和当前主题的内容联系，无论assetMode取值是什么。纯native流程页无需位图主体时，componentIds返回[]；不要为凑复用数量搬入旧照片。已提供的availableAssetRefs由后续素材规划绑定，不写进componentIds。',
              primaryStyle: template.compositionPolicy ? design.tokens : undefined,
              templateSources: template.sources,
              compositionPolicy: template.sources?.length
                ? '这是多个已学习模板的组合目录。跨来源借用几何关系与组件，userStyle和primaryStyle统一整稿。不能把其他来源原有红条、纯蓝品牌场或旧字体当作本稿的画风；所有结构都改用主风格的色板、材质和笔触，不做红蓝风格交替。'
                : undefined,
              embeddedMedia: template.visual!.media,
              goal: jobInput.prompt ?? jobInput.title,
              inputFingerprint,
              layouts: template.layouts.map(({ kind, layoutId, notes, textCapacity }) => ({
                kind,
                layoutId,
                notes,
                textCapacity,
              })),
              contentIntents,
              materials: materialContextForSlides(jobInput.options?.materials, outline),
              teachingStages: publicLessonStages(jobInput),
              teachingPolicy: publicLessonStages(jobInput).length
                ? LESSON_RENDERING_INSTRUCTIONS
                : undefined,
              rendererPolicy:
                '按visuals.renderer逐块路由，不能由图的主题决定工具：renderer:image的框架图、实验装置图、科研机制图也使用Image生成；renderer:native的精确数据与计算轨迹使用结构化渲染。混合页使用mixed。source-figure复用有来源原图。预留公式measurement真实尺寸与板书空间，正文至少24px。教学封面只放课程标题和引入，不把问题正文页冒充封面。',
              reusableComponents: template
                .visual!.components.filter(isReusableTemplateComponent)
                .map(({ box, familyId, id, name, role, treatment, rationale }) => ({
                  box,
                  familyId,
                  id,
                  name,
                  role,
                  treatment,
                  rationale,
                })),
              slides: briefs,
              templateId: template.templateId,
              title: jobInput.title,
              versionId: template.versionId,
            }),
            role: 'user',
          },
        ],
        model: options.chat.manifest.model,
        response_format: { type: 'json_object' },
        temperature: 0.15,
      },
    });
    return result.value;
  },
});
