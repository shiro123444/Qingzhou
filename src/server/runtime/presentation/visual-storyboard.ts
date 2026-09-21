import { createHash } from 'node:crypto';

import { z } from 'zod';

import type {
  PresentationJobInput,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { GLMMultimodalChatPort } from './multimodal-chat-provider-glm';
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
      }),
    )
    .digest('hex')
    .slice(0, 40);

interface OutlineSlide {
  readonly claim?: string;
  readonly keyPoints?: unknown;
  readonly objective?: string;
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

/** Project model output onto the trusted contract while preserving strict semantic validation. */
const normalizeStoryboardCandidate = (
  value: unknown,
  binding: Pick<PresentationVisualStoryboard, 'inputFingerprint' | 'templateId' | 'versionId'>,
): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const slides = Array.isArray(record.slides)
    ? record.slides.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const slide = item as Record<string, unknown>;
        return {
          archetypeId: boundedText(slide.archetypeId, 80),
          ...(slide.assetBrief === undefined
            ? {}
            : { assetBrief: boundedProse(slide.assetBrief, 1600) }),
          assetMode: slide.assetMode,
          componentIds: Array.isArray(slide.componentIds)
            ? slide.componentIds.slice(0, 12).map((id) => boundedText(id, 80))
            : slide.componentIds,
          compositionIntent: boundedProse(slide.compositionIntent, 1600),
          continuity: boundedProse(slide.continuity, 1000),
          familyId: boundedText(slide.familyId, 60),
          ...(slide.layoutId === undefined ? {} : { layoutId: boundedText(slide.layoutId, 120) }),
          role: slide.role,
          slideId: boundedText(slide.slideId, 120),
        };
      })
    : record.slides;
  return {
    deckRationale: boundedProse(record.deckRationale, 2400),
    inputFingerprint: record.inputFingerprint ?? binding.inputFingerprint,
    rhythm: Array.isArray(record.rhythm)
      ? record.rhythm.slice(0, 16).map((item) => boundedProse(item, 500))
      : record.rhythm,
    schemaVersion: record.schemaVersion ?? 1,
    slides,
    templateId: boundedText(record.templateId ?? binding.templateId, 160),
    versionId: boundedText(record.versionId ?? binding.versionId, 160),
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
          const exactArchetype = archetypes.get(slide.archetypeId);
          const familyArchetypes = design.archetypes.filter(
            (item) => item.familyId === slide.familyId,
          );
          const archetype =
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
              component.familyId !== archetype.familyId ||
              component.containsText ||
              component.treatment === 'redraw' ||
              component.treatment === 'native'
            ) {
              return storyboardError(
                'Visual storyboard attempted to reuse an unsafe template component',
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
              '你是整稿视觉导演。模板观察结果是证据，不是逐页照抄命令。请先理解这份演示的叙事弧线，再为每页选择一个有证据的视觉族和构图原型。封面、章节、正文、数据和收束页应形成节奏；相邻页面保持锚点连续，同时避免机械重复。只有无旧文字、已获准复用的组件才可放入 componentIds。需要新画的插画、水彩或装饰主体时，assetMode 必须是 generate，并把画风、主体、留白方向写进 assetBrief；不要因为模板里已有旧主题照片就把 assetMode 设为 reuse。reuse 仅用于无旧文字的装饰组件。准确图表、流程和文字结构使用 native。embeddedMedia 来自真实视频抽帧或媒体元数据：可用于理解节奏、画风和槽位，静态 SVG 生成不能假装已经保留动态播放；需要动态保真时在构图意图中明确要求走原稿保真路径。不要因为模板有图片就强迫每页生图。严格返回 JSON。',
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
                    assetBrief: '可选，需要生成的图像描述（最多 1600 字符）',
                    layoutId: '可选，输入 layouts 中的真实 layoutId',
                  },
                ],
              },
              binding:
                '模板身份、版本与输入指纹由服务端绑定，无需生成；若返回这些字段，必须与输入完全一致。',
            }),
            role: 'system',
          },
          {
            content: JSON.stringify({
              designProgram: design,
              embeddedMedia: template.visual!.media,
              goal: jobInput.prompt ?? jobInput.title,
              inputFingerprint,
              layouts: template.layouts.map(({ kind, layoutId, notes, textCapacity }) => ({
                kind,
                layoutId,
                notes,
                textCapacity,
              })),
              reusableComponents: template
                .visual!.components.filter(
                  (component) =>
                    !component.containsText &&
                    component.treatment !== 'redraw' &&
                    component.treatment !== 'native',
                )
                .map(({ box, familyId, id, name, role, treatment }) => ({
                  box,
                  familyId,
                  id,
                  name,
                  role,
                  treatment,
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
