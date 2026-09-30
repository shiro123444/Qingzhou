import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
/**
 * Multimodal Presentation Planner & Outline Generator.
 *
 * Uses the provider-neutral multimodal chat port to generate structured plans and outlines.
 */
import type {
  PlannerContext,
  PresentationJobInput,
  PresentationMessageInput,
  PresentationPlan,
  PresentationPlanner,
  PresentationSlidePlan,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import { reviseAnnotation } from './annotation';
import { overlayAssetAnnotations } from './asset-annotations';
import {
  CONTENT_RENDERING_INSTRUCTIONS,
  isNativeVisual,
  isRasterVisual,
  readContentIntents,
  readVisualAssetBindings,
  type VisualAssetBinding,
  visualAssetBindingSchema,
  visualRequirements,
} from './content-intent';
import { contentLayout } from './content-layout';
import { inspectPresentationContent, promoteReadablePlainText } from './content-quality';
import {
  LESSON_RENDERING_INSTRUCTIONS,
  prepareLessonDraft,
  publicLessonStages,
  readLessonPlan,
} from './lesson';
import {
  createTrustedChatImages,
  type GLMChatContentPart,
  type GLMMultimodalChatPort,
  type GLMServerImageInput,
} from './multimodal-chat-provider-glm';
import { PresentationPlanError, validatePresentationPlan } from './planner';
import {
  boundPresentationPromptText,
  presentationAssetHref,
  type PresentationAssetPlacement,
  presentationImageRefs,
  type RevisionAssetIntent,
  validateAssetPlacement,
} from './revision-assets';
import {
  renderSemanticBlocks,
  SEMANTIC_BLOCK_FORMAT,
  semanticAuthoringSvg,
} from './semantic-blocks';
import { recoverSemanticSlideLayout } from './semantic-layout-recovery';
import { completeStructuredJson } from './structured-json-chat';
import { type TemplateApplication, templatePlannerInstructions } from './templates';
import { inspectVisualOccupancy, reconcileNativeVisualAssets } from './visual-ownership';

export interface GLMPresentationPlannerOptions {
  readonly chatPort: GLMMultimodalChatPort;
  readonly defaultSlideCount?: number;
  readonly systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are an expert AI presentation designer and slide architect.
Generate high quality, visually balanced SVG slides for the presentation.
Use PPT-compatible inline SVG attributes: no <g opacity>, <style>, class, foreignObject, mask, textPath, script, or external assets. Apply opacity on individual shapes. Use <text>/<tspan> for text and Arial or Microsoft YaHei as the final font fallback.
Template page screenshots and images inside reference layouts are for visual observation only. Never copy their hrefs into the output. Use only the explicitly provided generated assets or preserved images for each slide.
If a requested raster asset has not been provided yet, reserve a plain shape region and describe the needed asset in slide metadata for the asset preparation step. Do not invent image URLs or pretend a vector drawing is the requested photograph.
Each slide must be returned with a valid <svg viewBox="..." xmlns="http://www.w3.org/2000/svg">...</svg> matching the required canvas below.
Return clean JSON matching the PresentationPlan schema:
{
  "planId": string,
  "title": string,
  "aspectRatio": "16:9",
  "sourceVersionIds": string[],
  "slides": [
    {
      "slideId": string,
      "order": number (starting at 1),
      "svg": string (valid SVG),
      "notes": string (optional)
    }
  ]
}`;

const normalizeSvg = (value: unknown, slideId: string, aspectRatio: string): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  const start = raw.indexOf('<svg');
  const end = raw.lastIndexOf('</svg>');
  const extracted = start >= 0 && end > start ? raw.slice(start, end + 6) : raw;
  if (
    extracted &&
    !/<\s*(?:script|html|body)\b/i.test(extracted) &&
    !/<!DOCTYPE/i.test(extracted)
  ) {
    try {
      validatePresentationPlan({
        aspectRatio,
        planId: 'svg-probe',
        slides: [{ order: 1, slideId: 'svg-probe-slide', svg: extracted }],
        sourceVersionIds: [],
        title: 'svg-probe',
      });
      return extracted;
    } catch {
      // Fall through to the stable plan error below.
    }
  }
  throw new PresentationPlanError(`slide ${slideId} returned an invalid SVG`);
};

interface PlannedVisualAsset {
  readonly binding?: VisualAssetBinding;
  readonly layout?: PresentationAssetPlacement;
  readonly ref: string;
}

const svgViewBox = (svg: string): number[] => {
  const viewBox = /<svg\b[^>]*\sviewBox=["']([^"']+)["']/iu.exec(svg)?.[1];
  const values = viewBox
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (!values || values.length !== 4 || values.some((value) => !Number.isFinite(value)))
    throw new PresentationPlanError('Image layout requires a finite SVG viewBox');
  return values;
};

/** Annotation coordinates follow the final composition, including deterministic reflow. */
const actualAssetPlacement = (
  svg: string,
  asset: PlannedVisualAsset,
): PresentationAssetPlacement | undefined => {
  const [x, y, width, height] = svgViewBox(svg);
  const tag = [...svg.matchAll(/<image\b[^>]*>/giu)].find((match) =>
    presentationImageRefs(match[0]).some(
      (ref) => ref.replace(/\?raw=true$/u, '') === presentationAssetHref(asset.ref),
    ),
  )?.[0];
  if (!tag) return;
  const value = (key: string) => Number(new RegExp(`\\s${key}=["']([^"']+)`, 'u').exec(tag)?.[1]);
  const placement = {
    x: (value('x') - x) / width,
    y: (value('y') - y) / height,
    width: value('width') / width,
    height: value('height') / height,
    fit: asset.layout?.fit ?? ('contain' as const),
  };
  if ([placement.x, placement.y, placement.width, placement.height].every(Number.isFinite))
    return placement;
};

/** Keep the same image viewport aspect when moving annotated artwork, including letterboxing. */
const preserveAnnotatedViewport = (
  svg: string,
  previous: string,
  asset: PlannedVisualAsset,
): string => {
  const old = actualAssetPlacement(previous, asset);
  const next = actualAssetPlacement(svg, asset);
  if (!old || !next) return svg;
  const [, , oldWidth, oldHeight] = svgViewBox(previous);
  const [minX, minY, width, height] = svgViewBox(svg);
  const aspect = (old.width * oldWidth) / (old.height * oldHeight);
  if (!Number.isFinite(aspect) || aspect <= 0) return svg;
  const boxWidth = next.width * width,
    boxHeight = next.height * height;
  const fittedWidth = Math.min(boxWidth, boxHeight * aspect);
  const fittedHeight = fittedWidth / aspect;
  const document = parseString(svg);
  const image = Array.from(document.getElementsByTagName('image')).find(
    (element) =>
      (element.getAttribute('href') ?? element.getAttribute('xlink:href'))?.replace(
        /\?raw=true$/u,
        '',
      ) === presentationAssetHref(asset.ref),
  );
  if (!image) return svg;
  image.setAttribute('x', String(minX + next.x * width + (boxWidth - fittedWidth) / 2));
  image.setAttribute('y', String(minY + next.y * height + (boxHeight - fittedHeight) / 2));
  image.setAttribute('width', String(fittedWidth));
  image.setAttribute('height', String(fittedHeight));
  const original = Array.from(parseString(previous).getElementsByTagName('image')).find(
    (element) =>
      (element.getAttribute('href') ?? element.getAttribute('xlink:href'))?.replace(
        /\?raw=true$/u,
        '',
      ) === presentationAssetHref(asset.ref),
  );
  image.setAttribute(
    'preserveAspectRatio',
    original?.getAttribute('preserveAspectRatio') || 'xMidYMid meet',
  );
  return document.toString();
};

const authoredBodyText = (svg: string, title: string): string[] =>
  Array.from(parseString(svg).getElementsByTagName('text')).flatMap((text) => {
    for (
      let node: Element | null = text;
      node;
      node = node.parentNode?.nodeType === 1 ? (node.parentNode as Element) : null
    )
      if (
        [
          'data-content-id',
          'data-scientific-diagram',
          'data-formula-latex',
          'data-asset-annotations',
        ].some((key) => node!.hasAttribute(key))
      )
        return [];
    const value = text.textContent?.trim();
    return value && value !== title ? [value] : [];
  });

/** Fill only a region explicitly designed for this asset; never guess fixed coordinates. */
const attachGeneratedAssets = (svg: string, assets: readonly PlannedVisualAsset[]): string => {
  let result = svg;
  for (const asset of assets) {
    const href = presentationAssetHref(asset.ref);
    if (presentationImageRefs(result).includes(href)) continue;
    if (!asset.layout)
      throw new PresentationPlanError('The planner did not place a required image in its slide');
    const [minX, minY, width, height] = svgViewBox(result);
    const layout = validateAssetPlacement(asset.layout);
    const escapedHref = href
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;');
    const image = `<image href="${escapedHref}" x="${minX + layout.x * width}" y="${minY + layout.y * height}" width="${layout.width * width}" height="${layout.height * height}" preserveAspectRatio="xMidYMid ${layout.fit === 'cover' ? 'slice' : 'meet'}"/>`;
    const firstText = result.search(/<text\b/iu);
    const insertion = firstText >= 0 ? firstText : result.lastIndexOf('</svg>');
    result = `${result.slice(0, insertion)}${image}${result.slice(insertion)}`;
  }
  return result;
};

/**
 * A wording revision must keep the page's existing real images. When the model drops one anyway,
 * restore it verbatim from the base plan instead of failing the whole deck.
 */
const restorePreservedImages = (
  composed: string,
  original: string | undefined,
  refs: readonly string[],
): string => {
  if (!original || !refs.length) return composed;
  const present = new Set(presentationImageRefs(composed));
  const missing = new Set(refs.filter((ref) => !present.has(ref)));
  if (!missing.size) return composed;
  const tags = [...original.matchAll(/<image\b[^>]*?\/?>/giu)].filter((match) => {
    const href = /\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/iu.exec(match[0])?.[1];
    return href ? missing.has(href) : false;
  });
  const insertion = composed.lastIndexOf('</svg>');
  if (!tags.length || insertion < 0) return composed;
  return `${composed.slice(0, insertion)}${tags.map((match) => match[0]).join('')}${composed.slice(insertion)}`;
};

/** Normalize only an alias of an explicitly supplied asset; never guess a replacement. */
const normalizeProvidedImageHrefs = (svg: string, permitted: readonly string[]): string =>
  svg.replaceAll(
    /(<image\b[^>]*?\s(?:xlink:)?href\s*=\s*)(["'])(.*?)\2/giu,
    (tag, prefix: string, quote: string, _raw: string) => {
      const ref = presentationImageRefs(tag + '>')[0];
      const canonical = permitted.find((allowed) => {
        if (ref === allowed) return true;
        const local = /^\/api\/runtime\/presentation\/artifacts\/([^?]+)(?:\?raw=true)?$/u.exec(
          allowed,
        );
        if (!local) return false;
        try {
          return (
            ref === decodeURIComponent(local[1]) ||
            ref === `/api/runtime/presentation/artifacts/${local[1]}` ||
            ref === `/api/runtime/presentation/artifacts/${local[1]}?raw=true`
          );
        } catch {
          return false;
        }
      });
      return canonical
        ? `${prefix}${quote}${canonical.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')}${quote}`
        : tag;
    },
  );

const validatePlacedAssets = (
  svg: string,
  required: readonly PlannedVisualAsset[],
  permittedRefs: readonly string[],
): void => {
  const refs = presentationImageRefs(svg);
  for (const ref of refs) {
    if (!permittedRefs.includes(ref))
      throw new PresentationPlanError(
        `The planner referenced an image that was not provided: ${ref.slice(0, 240)}. Use only these exact image hrefs on this slide: ${JSON.stringify(permittedRefs)}. Template screenshots are observation references, not slide assets.`,
      );
  }
  const [minX, minY, width, height] = svgViewBox(svg);
  for (const asset of required) {
    const href = presentationAssetHref(asset.ref);
    const tag = [...svg.matchAll(/<image\b[^>]*>/giu)].find((match) =>
      presentationImageRefs(match[0]).includes(href),
    )?.[0];
    if (!tag) throw new PresentationPlanError('A required generated image is missing');
    const dimension = (attribute: string, basis: number, fallback?: number): number => {
      const raw = new RegExp(`\\s${attribute}=["']([^"']+)["']`, 'iu').exec(tag)?.[1];
      if (raw === undefined) return fallback ?? Number.NaN;
      if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:%|px)?$/u.test(raw)) return Number.NaN;
      return Number.parseFloat(raw) * (raw.endsWith('%') ? basis / 100 : 1);
    };
    const x = dimension('x', width, 0);
    const y = dimension('y', height, 0);
    const imageWidth = dimension('width', width);
    const imageHeight = dimension('height', height);
    if (
      ![x, y, imageWidth, imageHeight].every(Number.isFinite) ||
      x < minX ||
      y < minY ||
      imageWidth <= 0 ||
      imageHeight <= 0 ||
      x + imageWidth > minX + width + 0.01 ||
      y + imageHeight > minY + height + 0.01
    )
      throw new PresentationPlanError('Generated image placement extends outside the slide');
  }
};

export class GLMPresentationPlanner implements PresentationPlanner {
  private readonly chatPort: GLMMultimodalChatPort;
  private readonly defaultSlideCount: number;
  private readonly systemPrompt: string;

  constructor(options: GLMPresentationPlannerOptions) {
    if (!options || typeof options !== 'object' || !options.chatPort) {
      throw new Error('PresentationPlanner requires chatPort');
    }
    this.chatPort = options.chatPort;
    this.defaultSlideCount = options.defaultSlideCount ?? 8;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  async plan(input: PresentationJobInput, context: PlannerContext): Promise<PresentationPlan> {
    const candidateScope = context?.scope as Partial<RuntimeScope> | undefined;
    if (
      !candidateScope ||
      typeof candidateScope.userId !== 'string' ||
      !candidateScope.userId.trim() ||
      typeof candidateScope.sessionId !== 'string' ||
      !candidateScope.sessionId.trim()
    ) {
      throw new PresentationPlanError('authenticated planner scope is required');
    }
    const scope: RuntimeScope = {
      sessionId: candidateScope.sessionId.trim(),
      userId: candidateScope.userId.trim(),
    };

    const outline = input.options?.outline;
    if (
      !context.basePlan &&
      !context.pagePass &&
      Array.isArray(outline) &&
      outline.length > 0 &&
      outline.length === input.slideCount
    ) {
      const composed: PresentationSlidePlan[] = [];
      for (const [pageIndex, page] of outline.entries()) {
        const pageId = `slide-${pageIndex + 1}`;
        const resumed = Array.isArray(context.resumeSlides)
          ? (context.resumeSlides as PresentationSlidePlan[]).find(
              (s) => s.slideId === pageId && s.order === pageIndex + 1,
            )
          : undefined;
        if (resumed) {
          const cached = validatePresentationPlan({
            planId: 'checkpoint',
            title: input.title,
            aspectRatio: input.aspectRatio ?? '16:9',
            sourceVersionIds: input.sourceVersionIds,
            slides: [{ ...resumed, order: 1 }],
          });
          const quality = input.options?.contentIntents
            ? inspectPresentationContent(cached)
            : undefined;
          if (quality && !quality.passed)
            throw new PresentationPlanError(
              `Saved draft no longer passes content checks: ${JSON.stringify(quality.issues)}`,
            );
          composed.push(resumed);
          continue;
        }
        if (typeof context.onSlideStart === 'function') await context.onSlideStart(pageIndex + 1);
        const result = await this.plan(
          {
            ...input,
            slideCount: 1,
            prompt: `${input.prompt ?? ''}\n当前仅制作第 ${pageIndex + 1} 页：${JSON.stringify(page)}。只返回这一页，保持 slideId=${pageId}，不要重写其他页面。`,
            options: {
              ...input.options,
              generatedImageSlots: Array.isArray(input.options?.generatedImageSlots)
                ? input.options.generatedImageSlots.filter((slot: any) => slot.slideId === pageId)
                : undefined,
            },
          },
          { ...context, pagePass: true, pageIndex, pageSlideId: pageId },
        );
        const slide = { ...result.slides[0], slideId: pageId, order: pageIndex + 1 };
        composed.push(slide);
        if (typeof context.onSlideDraft === 'function') await context.onSlideDraft(slide);
      }
      return {
        planId: `plan-${Date.now()}`,
        title: input.title,
        aspectRatio: input.aspectRatio ?? '16:9',
        sourceVersionIds: [...input.sourceVersionIds],
        ...(input.options?.contentIntents ? { designSpec: { contentPolicyVersion: 1 } } : {}),
        slides: composed,
      };
    }
    const basePlan = context.basePlan as PresentationPlan | undefined;
    const revision = context.revision as PresentationMessageInput | undefined;
    if (basePlan) validatePresentationPlan(basePlan);
    if (basePlan && revision?.annotation)
      return reviseAnnotation(
        basePlan,
        revision,
        this.chatPort,
        scope,
        (context.abortSignal ?? context.signal) as AbortSignal | undefined,
      );
    if (basePlan && revision?.target.type === 'deck' && !context.pagePass) {
      // A conversation about the whole deck still needs one bounded rendering
      // request per page. Sending every full SVG at once exhausts the model
      // context and prevents the teacher's revision from being applied at all.
      let current = basePlan;
      const completed = new Set(
        Array.isArray(context.completedRevisionSlideIds)
          ? context.completedRevisionSlideIds.filter(
              (id: unknown): id is string => typeof id === 'string',
            )
          : [],
      );
      for (const [index] of basePlan.slides.entries()) {
        const slideId = basePlan.slides[index].slideId;
        if (completed.has(slideId)) continue;
        current = await this.plan(input, {
          ...context,
          basePlan: current,
          pagePass: true,
          revision: { ...revision, target: { slideNumber: index + 1, type: 'slide' } },
        });
        if (typeof context.onRevisionSlide === 'function')
          await context.onRevisionSlide(current, slideId);
      }
      return current;
    }
    const selectedSlides =
      basePlan && revision
        ? basePlan.slides.filter(
            (_, index) =>
              revision.target.type === 'deck' || index + 1 === revision.target.slideNumber,
          )
        : undefined;
    if (selectedSlides?.length === 0)
      throw new PresentationPlanError('The selected slide does not exist');
    const slideCount = selectedSlides?.length ?? (input.slideCount || this.defaultSlideCount);
    const title = input.title || '智能演示文稿';
    const aspectRatio = input.aspectRatio || '16:9';
    const [ratioWidth, ratioHeight] = aspectRatio.split(':').map(Number);
    const canvasHeight = ratioWidth > 0 && ratioHeight > 0 ? (960 * ratioHeight) / ratioWidth : 540;
    const inputOptions = (input.options ?? {}) as Record<string, unknown>;
    const contentIntents = readContentIntents(input);
    const requestedStyle = typeof inputOptions.style === 'string' ? inputOptions.style.trim() : '';

    let userPrompt = [
      `主题：${title}`,
      input.prompt ? `详细需求：${input.prompt}` : '',
      `目标页数：${slideCount}`,
      `画幅比例：${aspectRatio}`,
      input.language ? `主语言：${input.language}` : '主语言：zh-CN',
    ]
      .filter(Boolean)
      .join('\n');
    if (selectedSlides && revision) {
      const editableSlides = selectedSlides.map((slide) => ({
        ...slide,
        ...(readLessonPlan(input) ? { notes: undefined, metadata: undefined } : {}),
        svg: semanticAuthoringSvg(slide.svg, slide.metadata?.contentBlocks),
        contentBlocks: slide.metadata?.contentBlocks,
      }));
      userPrompt = `请修改以下原稿页面，保留没有要求修改的内容、图片和布局。只返回这些页面，不添加其他页面。保持 slideId。公式与图形已恢复为空锚点和contentBlocks源；修改源与rect，由服务端重绘，不要在空锚点中手绘路径。\n修改要求：${revision.content}\n画幅：${aspectRatio}\n原稿：${JSON.stringify(editableSlides)}\n返回 ${selectedSlides.length} 页完整 SVG 与contentBlocks的 JSON PresentationPlan。`;
    }
    if (context.template) {
      userPrompt += `\n\n${templatePlannerInstructions(context.template as TemplateApplication)}`;
    }
    userPrompt += `\n\n${CONTENT_RENDERING_INSTRUCTIONS}\n${SEMANTIC_BLOCK_FORMAT}`;
    const teachingStages = publicLessonStages(
      input,
      context.pageSlideId
        ? [String(context.pageSlideId)]
        : selectedSlides?.map((slide) => slide.slideId),
    );
    if (teachingStages.length) {
      // The full deck prompt/outline can disclose an answer planned for a later
      // stage. Use only this stage's public projection in the rendering request.
      if (!selectedSlides)
        userPrompt = `主题：${title}\n画幅：${aspectRatio}\n返回 ${slideCount} 页完整SVG与contentBlocks的JSON。\n${CONTENT_RENDERING_INSTRUCTIONS}\n${SEMANTIC_BLOCK_FORMAT}`;
      userPrompt += `\n${LESSON_RENDERING_INSTRUCTIONS}\n批准的教学阶段：${JSON.stringify(teachingStages)}`;
    }
    const relevantIntents = contentIntents.filter((intent) =>
      context.pageSlideId
        ? intent.slideId === context.pageSlideId
        : selectedSlides
          ? selectedSlides.some((slide) => slide.slideId === intent.slideId)
          : true,
    );
    if (relevantIntents.length) userPrompt += `\n内容编译结果：${JSON.stringify(relevantIntents)}`;
    if (inputOptions.learnedCapabilities && !teachingStages.length)
      userPrompt += `\n已验证的历史学习能力（仅为参考，当前用户指令、内容语义与字号预算优先）：${JSON.stringify(inputOptions.learnedCapabilities)}`;
    const visualStoryboard = inputOptions.visualStoryboard as
      | { deckRationale?: unknown; rhythm?: unknown; slides?: unknown[] }
      | undefined;
    if (Array.isArray(visualStoryboard?.slides)) {
      const relevantDirections = visualStoryboard.slides.filter((item) => {
        if (!item || typeof item !== 'object') return false;
        const slideId = (item as { slideId?: unknown }).slideId;
        if (typeof slideId !== 'string') return false;
        if (context.pageSlideId) return slideId === context.pageSlideId;
        if (selectedSlides) return selectedSlides.some((slide) => slide.slideId === slideId);
        return true;
      });
      userPrompt += `\n\n整稿视觉故事板（这是排版与素材的共同决策，逐页执行但保持跨页节奏）：${JSON.stringify({ ...(teachingStages.length ? {} : { deckRationale: visualStoryboard.deckRationale, rhythm: visualStoryboard.rhythm }), slides: relevantDirections })}`;
    }
    const revisionAssetIntents = (input.options?.revisionAssetIntents ??
      []) as RevisionAssetIntent[];
    if (revisionAssetIntents.length) {
      userPrompt += `\n\n已批准的资产操作：${JSON.stringify(revisionAssetIntents)}\n只执行这些图片增删替换；其他原有图片保留。根据新图片的比例和预留区域重新排布文字。remove/replace 操作的原图片引用必须从目标页移除；新图片必须使用下面提供的真实 href。`;
    }

    const generatedSlots = (input.options as { generatedImageSlots?: unknown[] } | undefined)
      ?.generatedImageSlots;
    const generatedAssetUrls: string[] = [];
    const generatedAssetsBySlide = new Map<string, PlannedVisualAsset[]>();
    if (Array.isArray(generatedSlots) && generatedSlots.length > 0) {
      const slotDescriptions = generatedSlots
        .map((slot: unknown) => {
          const record = slot && typeof slot === 'object' ? (slot as Record<string, unknown>) : {};
          const refs = Array.isArray(record.assetRefs)
            ? record.assetRefs
                .map((ref) =>
                  ref &&
                  typeof ref === 'object' &&
                  typeof (ref as { ref?: unknown }).ref === 'string'
                    ? (ref as { ref: string }).ref.trim()
                    : '',
                )
                .filter(Boolean)
            : [];
          for (const ref of refs) {
            if (/^https:\/\//iu.test(ref) && !generatedAssetUrls.includes(ref)) {
              generatedAssetUrls.push(ref);
            }
          }
          const slideId = typeof record.slideId === 'string' ? record.slideId : 'unknown';
          if (selectedSlides && !selectedSlides.some((slide) => slide.slideId === slideId))
            return '';
          const layout =
            record.layout === undefined ? undefined : validateAssetPlacement(record.layout);
          generatedAssetsBySlide.set(slideId, [
            ...(generatedAssetsBySlide.get(slideId) ?? []),
            ...refs.map((ref) => {
              const parsed = visualAssetBindingSchema.safeParse({
                ...(record.visualBinding && typeof record.visualBinding === 'object'
                  ? record.visualBinding
                  : {}),
                ref: presentationAssetHref(ref),
              });
              return { layout, ref, ...(parsed.success ? { binding: parsed.data } : {}) };
            }),
          ]);
          const slotId = typeof record.slotId === 'string' ? record.slotId : 'unknown';
          const state = typeof record.state === 'string' ? record.state : 'unknown';
          return `页面: ${slideId}, 槽位: ${slotId}, 素材状态: ${state}${refs.length > 0 ? `, 素材引用: ${refs.map(presentationAssetHref).join('、')}` : ''}${record.size ? `, 原图尺寸: ${record.size}` : ''}${layout ? `, 图片区域(相对画幅0..1): ${JSON.stringify(layout)}` : ''}`;
        })
        .join('\n');
      userPrompt += `\n\n已生成的视觉素材清单：\n${slotDescriptions}\n保持素材所属页面的 slideId 不变。每张素材都必须在对应页面使用 <image href="素材引用">，包括 /api/ 开头的真实资产引用，不可画占位图代替。使用与viewBox相同的数值坐标和正数width/height，图片须在画幅内。不要在图片或图片父组使用transform。已指定图片区域时围绕该区域排布文字，避免遮挡，并以preserveAspectRatio保留主体比例。没有指定区域时根据实际内容设计布局。`;
    }

    const contentParts: GLMChatContentPart[] = [{ text: userPrompt, type: 'text' }];

    // If options include resolved reference images, attach them safely
    if (Array.isArray((input.options as any)?.references)) {
      for (const ref of (input.options as any).references) {
        if (ref?.url && typeof ref.url === 'string' && ref.url.startsWith('https://')) {
          contentParts.push({
            image_url: { url: ref.url },
            type: 'image_url',
          });
        }
      }
    }
    for (const url of generatedAssetUrls) {
      contentParts.push({ image_url: { url }, type: 'image_url' });
    }
    const relevantImageHrefs = new Set([
      ...((context.template as TemplateApplication | undefined)?.visual?.pages.map((page) =>
        presentationAssetHref(page.ref),
      ) ?? []),
      ...[...generatedAssetsBySlide.values()].flatMap((assets) =>
        assets.map((asset) => presentationAssetHref(asset.ref)),
      ),
      ...(selectedSlides ?? []).flatMap((slide) => presentationImageRefs(slide.svg)),
    ]);
    const trustedInputs = Array.isArray(context.trustedImages)
      ? (context.trustedImages as (GLMServerImageInput & { ref: string })[]).filter(
          (image) =>
            typeof image?.ref === 'string' &&
            relevantImageHrefs.has(presentationAssetHref(image.ref)),
        )
      : [];
    const trustedImages = trustedInputs.length
      ? createTrustedChatImages(trustedInputs, scope)
      : undefined;
    trustedImages?.urls.forEach((url, index) => {
      contentParts.push({
        text: `以下图片是已验证的真实资产 ${presentationAssetHref(trustedInputs[index].ref)}，请观察主体、色彩、留白与比例后排版。`,
        type: 'text',
      });
      contentParts.push({ image_url: { url }, type: 'image_url' });
    });
    if (relevantIntents.length)
      contentParts.push({
        type: 'text',
        text: `CURRENT PAGE OUTPUT CONTRACT — check every item before returning JSON:\n${JSON.stringify(
          relevantIntents.map((intent) => ({
            slideId: intent.slideId,
            usableContentRect: contentLayout(
              teachingStages.find((s) => s.slideId === intent.slideId)?.boardSpace,
              aspectRatio,
            ),
            formulas: intent.formulas
              .filter((f) => f.placement !== 'notes')
              .map((f) => ({
                id: f.id,
                latex: f.latex,
                display: f.display ?? true,
                ...f.measurement,
              })),
            vectorBlocks: visualRequirements(intent)
              .filter(isNativeVisual)
              .map((v) => ({
                id: v.id,
                fidelity: v.fidelity,
                minimumWidth: 280,
                // Plot legends consume vertical space before the geometry. The
                // measured block may need more; this is a planning floor only.
                minimumHeight: v.kind === 'chart' ? 260 : 224,
                graphNodeLabelMaxCharacters: 12,
              })),
            images: generatedAssetsBySlide.get(intent.slideId)?.map((a) => ({
              id: a.binding?.visualId,
              href: presentationAssetHref(a.ref),
              layout: a.layout,
            })),
          })),
        )}\ncontentBlocks has ONLY kind:"formula" or kind:"scientific-diagram". An illustration is NOT a contentBlock: place its real href with SVG <image>, do not add kind:illustration/image. Do not add explanation/placement/measurement to formula blocks. Never change exact LaTeX. Do not invent English subtitles, credits or headings. All body text ≥24px; only short labels ≤16 characters and footers may be 16px. Simplify words instead of shrinking. Scientific claims must state applicable assumptions. Do not repeat unqualified convergence or complexity guarantees from an outline; explain necessary conditions and limitations in notes.`,
      });

    const parsePlan = async (parsedPlan: any): Promise<PresentationPlan> => {
      if (!parsedPlan || typeof parsedPlan !== 'object' || Array.isArray(parsedPlan))
        throw new PresentationPlanError('The planner must return a PresentationPlan object');
      const rawSlides = Array.isArray(parsedPlan.slides) ? parsedPlan.slides : [];
      if (rawSlides.length !== slideCount) {
        throw new PresentationPlanError(
          `planner returned ${rawSlides.length} slides, expected ${slideCount}`,
        );
      }
      const plannedSlides = selectedSlides
        ? selectedSlides.map((slide) => {
            const matches = rawSlides.filter(
              (candidate: { slideId?: unknown }) => candidate?.slideId === slide.slideId,
            );
            if (matches.length !== 1)
              throw new PresentationPlanError(
                'A revision must retain each selected slide id exactly once',
              );
            return matches[0];
          })
        : rawSlides;
      const usedSlideIds = new Set<string>();

      // Normalize unreliable model fields at the provider boundary. The model is
      // allowed to be creative about content, not about contract validity.
      const fallbackPlan: PresentationPlan = {
        aspectRatio,
        planId: parsedPlan.planId || `plan-${Date.now()}`,
        ...(contentIntents.length ? { designSpec: { contentPolicyVersion: 1 } } : {}),
        slides: await Promise.all(
          plannedSlides.map(async (s: any, idx: number): Promise<PresentationSlidePlan> => {
            const originalSlide = selectedSlides?.[idx];
            const requestedId =
              (context.pageSlideId as string | undefined) ??
              originalSlide?.slideId ??
              (typeof s?.slideId === 'string' && s.slideId.trim()
                ? s.slideId.trim()
                : `slide-${idx + 1}`);
            const slideId = usedSlideIds.has(requestedId) ? `slide-${idx + 1}` : requestedId;
            usedSlideIds.add(slideId);
            const outlineIndex =
              (context.pageIndex as number | undefined) ??
              (originalSlide ? Math.max(0, originalSlide.order - 1) : idx);
            const outlinePage = Array.isArray(input.options?.outline)
              ? input.options.outline[outlineIndex]
              : undefined;
            const slideTitle =
              (typeof outlinePage?.title === 'string' ? outlinePage.title : undefined) ??
              (typeof s?.title === 'string' && s.title.trim()
                ? s.title.trim()
                : typeof originalSlide?.metadata?.title === 'string' &&
                    originalSlide.metadata.title.trim()
                  ? originalSlide.metadata.title.trim()
                  : idx === 0
                    ? title
                    : `第 ${idx + 1} 页`);
            const visualDirection = Array.isArray(visualStoryboard?.slides)
              ? visualStoryboard.slides.find(
                  (item) =>
                    item &&
                    typeof item === 'object' &&
                    (item as { slideId?: unknown }).slideId === requestedId,
                )
              : undefined;
            const slideAssets =
              generatedAssetsBySlide.get(slideId) ??
              (!selectedSlides ? generatedAssetsBySlide.get(`slide-${idx + 1}`) : undefined) ??
              [];
            const slideRefs = slideAssets.map((asset) => asset.ref);
            const originalRefs = selectedSlides?.[idx]
              ? presentationImageRefs(selectedSlides[idx].svg)
              : [];
            const removedRefs = revisionAssetIntents
              .filter(
                (intent) =>
                  intent.slideId === slideId &&
                  (intent.action === 'remove' || intent.action === 'replace'),
              )
              .map((intent) => intent.ref!);
            const preservedRefs = originalRefs.filter((ref) => !removedRefs.includes(ref));
            const referenceUrls = Array.isArray(input.options?.references)
              ? (input.options.references as { url?: string }[]).flatMap((ref) =>
                  typeof ref?.url === 'string' ? [ref.url] : [],
                )
              : [];
            const permittedRefs = [
              ...preservedRefs,
              ...slideRefs.map(presentationAssetHref),
              ...referenceUrls,
            ];
            const normalizedSvg = normalizeProvidedImageHrefs(
              normalizeSvg(s?.svg, slideId, aspectRatio),
              permittedRefs,
            );
            const normalized = contentIntents.length
              ? promoteReadablePlainText(normalizedSvg)
              : normalizedSvg;
            let content!: Awaited<ReturnType<typeof renderSemanticBlocks>> & {
              overflowNotes?: string;
            };
            let layoutRecovered = false;
            try {
              content = await renderSemanticBlocks(
                normalized,
                s?.contentBlocks,
                contentIntents.find((intent) => intent.slideId === slideId),
              );
            } catch (error) {
              const intent = contentIntents.find((item) => item.slideId === slideId);
              const stage = teachingStages.find((item) => item.slideId === slideId);
              if (
                intent &&
                /Formula .*reserve at least|Formula .*needs .*enlarge|Semantic blocks .*overlap|Plot requires at least|Scientific diagrams need at least|requires a reproducible quadratic\/taylor recipe|Graph (?:label|needs|layer|branches|nodes)|needs a wider node|Vertical graph labels/u.test(
                  String(error),
                )
              ) {
                try {
                  content = await recoverSemanticSlideLayout({
                    aspectRatio,
                    boardSpace: stage?.boardSpace,
                    intent,
                    rawBlocks: s?.contentBlocks,
                    title: stage?.title ?? slideTitle,
                    visibleContent: stage?.visibleContent ?? outlinePage?.keyPoints,
                    imageRefs: [
                      ...preservedRefs,
                      ...slideAssets.map((asset) => presentationAssetHref(asset.ref)),
                    ],
                  });
                  layoutRecovered = true;
                } catch {
                  // Keep the model's precise error for its bounded repair turn.
                }
              }
              if (layoutRecovered) {
                // The deterministic layout uses the approved content and diagram source.
              } else {
                // A bounded repair must see all independent failures at once, not
                // fix a missing diagram only to discover unreadable type afterwards.
                const quality = contentIntents.length
                  ? inspectPresentationContent({
                      planId: 'content-preflight',
                      title,
                      aspectRatio,
                      sourceVersionIds: [],
                      slides: [{ slideId, order: idx + 1, svg: normalized }],
                    })
                  : undefined;
                throw new PresentationPlanError(
                  `${String(error)}${quality?.issues.length ? `\nAlso fix all typography/content violations: ${JSON.stringify(quality.issues)}` : ''}`,
                );
              }
            }
            let composedSvg = restorePreservedImages(
              attachGeneratedAssets(content.svg, slideAssets),
              originalSlide?.svg,
              preservedRefs,
            );
            const currentIntent = contentIntents.find((item) => item.slideId === slideId);
            const ownershipMetadata = {
              contentBlocks: content.blocks,
              visualRequirements: visualRequirements(currentIntent),
              visualAssets: [
                ...readVisualAssetBindings(originalSlide?.metadata?.visualAssets),
                ...slideAssets.flatMap((asset) => (asset.binding ? [asset.binding] : [])),
              ],
            };
            const ownedComposition = reconcileNativeVisualAssets({
              slideId,
              order: idx + 1,
              svg: composedSvg,
              metadata: ownershipMetadata,
            });
            composedSvg = ownedComposition.svg;
            const beforeReflow = composedSvg;
            if (currentIntent && inspectVisualOccupancy(ownedComposition).length) {
              const stage = teachingStages.find((item) => item.slideId === slideId);
              content = await recoverSemanticSlideLayout({
                aspectRatio,
                boardSpace: stage?.boardSpace,
                intent: currentIntent,
                rawBlocks: content.blocks,
                title: stage?.title ?? slideTitle,
                visibleContent:
                  stage?.visibleContent ??
                  outlinePage?.keyPoints ??
                  authoredBodyText(composedSvg, slideTitle),
                imageRefs: presentationImageRefs(composedSvg),
              });
              composedSvg = content.svg;
              for (const asset of slideAssets)
                if (
                  currentIntent.visuals?.some(
                    (visual) => visual.id === asset.binding?.visualId && visual.annotations?.length,
                  )
                )
                  composedSvg = preserveAnnotatedViewport(composedSvg, beforeReflow, asset);
              layoutRecovered = true;
            }
            // Read the declarations straight from the compiled intents: `intent` is declared
            // later in this scope, so referencing it here would be a temporal dead zone.
            const annotationsFor = (visualId: string) =>
              contentIntents
                .find((item) => item.slideId === slideId)
                ?.visuals?.find((visual) => visual.id === visualId)?.annotations;
            const annotatedAssets = slideAssets.flatMap((asset) => {
              const annotations = asset.binding
                ? annotationsFor(asset.binding.visualId)
                : undefined;
              return annotations?.length
                ? [
                    {
                      annotations,
                      layout: actualAssetPlacement(composedSvg, asset) ?? asset.layout,
                      visualId: asset.binding!.visualId,
                    },
                  ]
                : [];
            });
            let svg = annotatedAssets.length
              ? overlayAssetAnnotations(composedSvg, svgViewBox(composedSvg), annotatedAssets)
              : composedSvg;
            const intent = contentIntents.find((item) => item.slideId === slideId);
            const allBindings = [
              ...readVisualAssetBindings(originalSlide?.metadata?.visualAssets),
              ...slideAssets.flatMap((asset) => (asset.binding ? [asset.binding] : [])),
            ];
            const reconciled = reconcileNativeVisualAssets({
              slideId,
              order: idx + 1,
              svg,
              metadata: {
                contentBlocks: content.blocks,
                visualRequirements: visualRequirements(intent),
                visualAssets: allBindings,
              },
            });
            svg = reconciled.svg;
            const remainingBindings = readVisualAssetBindings(reconciled.metadata?.visualAssets);
            const retiredRefs = new Set(
              allBindings
                .filter((binding) => !remainingBindings.some((item) => item.ref === binding.ref))
                .flatMap((binding) => [binding.ref, `${binding.ref}?raw=true`]),
            );
            validatePlacedAssets(
              svg,
              slideAssets.filter((asset) => !retiredRefs.has(presentationAssetHref(asset.ref))),
              [...preservedRefs, ...slideRefs.map(presentationAssetHref), ...referenceUrls],
            );
            const resultingRefs = presentationImageRefs(svg);
            const bindings = remainingBindings.filter(
              (asset) =>
                resultingRefs.includes(asset.ref) ||
                resultingRefs.includes(`${asset.ref}?raw=true`),
            );
            const visualAssets = [
              ...new Map(bindings.map((asset) => [asset.visualId, asset])).values(),
            ];
            for (const visual of intent?.visuals?.filter(
              (v) => v.required && (isRasterVisual(v) || v.kind === 'source-figure'),
            ) ?? []) {
              if (
                !visualAssets.some(
                  (asset) =>
                    asset.visualId === visual.id &&
                    asset.kind === visual.kind &&
                    (visual.kind !== 'source-figure' || asset.origin === 'provided'),
                )
              )
                throw new PresentationPlanError(
                  `Required visual ${visual.id} has no embedded, owned ${visual.kind} asset. Complete asset generation/reuse before composing; do not fabricate a placeholder.`,
                );
            }
            if (
              visualRequirements(intent).some((v) => v.required && v.kind === 'source-figure') &&
              !resultingRefs.length
            )
              throw new PresentationPlanError(
                'This page requires a provided source figure with citation; do not fabricate or redraw research results',
              );
            if (preservedRefs.some((ref) => !retiredRefs.has(ref) && !resultingRefs.includes(ref)))
              throw new PresentationPlanError(
                'The revision removed an image that should be preserved',
              );
            const previousAssetRefs = Array.isArray(originalSlide?.metadata?.generatedAssetRefs)
              ? originalSlide.metadata.generatedAssetRefs.filter(
                  (ref): ref is string => typeof ref === 'string',
                )
              : [];
            const generatedAssetRefs = [...new Set([...previousAssetRefs, ...slideRefs])].filter(
              (ref) => {
                const href = presentationAssetHref(ref);
                return resultingRefs.includes(href) || resultingRefs.includes(`${href}?raw=true`);
              },
            );
            return {
              metadata: {
                ...originalSlide?.metadata,
                ...s?.metadata,
                generatedAssetRefs,
                visualAssets,
                visualRequirements: visualRequirements(intent),
                contentBlocks: content.blocks,
                ...(layoutRecovered ? { layoutRecovered: true } : {}),
                ...(requestedStyle ? { style: requestedStyle } : {}),
                ...(visualDirection && typeof visualDirection === 'object'
                  ? { visualDirection }
                  : {}),
                title: slideTitle,
                ...(outlinePage
                  ? {
                      outline: outlinePage.keyPoints,
                      objective: outlinePage.objective,
                      visualSuggestion: outlinePage.visualSuggestion,
                    }
                  : {}),
              },
              notes:
                [
                  typeof s?.notes === 'string'
                    ? s.notes
                    : (originalSlide?.notes ?? outlinePage?.speakerNotes),
                  ...visualAssets
                    .filter((asset) =>
                      ['scientific-illustration', 'scientific-diagram', 'chart'].includes(
                        asset.kind,
                      ),
                    )
                    .map(
                      (asset) =>
                        `[科研插图 ${asset.visualId}] ${asset.origin === 'generated' ? 'AI生成定性示意，非实验观测或实测数据' : '复用素材，来源与科学语义需核实'}；${asset.ref}`,
                    ),
                  ...(intent?.formulas
                    .filter((f) => f.placement === 'notes')
                    .map((f) => `[备注公式 ${f.id}] ${f.latex}\n${f.explanation ?? ''}`) ?? []),
                  ...(content.overflowNotes
                    ? [`[画面放不下的讲解，字号未缩小]\n${content.overflowNotes}`]
                    : []),
                  ...(content.blocks.length
                    ? [
                        `[可编辑内容源]\n${content.blocks.map((block) => (block.kind === 'formula' ? `${block.id}: ${block.latex}` : `${block.id}: ${JSON.stringify(block.spec)}\n${JSON.stringify(block.provenance)}`)).join('\n')}`,
                      ]
                    : []),
                ]
                  .filter((note) => note !== undefined)
                  .join('\n\n') || (typeof s?.notes === 'string' ? s.notes : undefined),
              order: idx + 1,
              slideId,
              svg,
            };
          }),
        ),
        sourceVersionIds: input.sourceVersionIds || [],
        title,
      };

      if (contentIntents.length) {
        const quality = inspectPresentationContent(fallbackPlan);
        if (!quality.passed) throw new PresentationPlanError(JSON.stringify(quality.issues));
      }

      fallbackPlan.slides = await Promise.all(
        fallbackPlan.slides.map(async (slide) => {
          try {
            return prepareLessonDraft(slide, input);
          } catch (error) {
            const stage = teachingStages.find((item) => item.slideId === slide.slideId);
            const intent = contentIntents.find((item) => item.slideId === slide.slideId);
            if (
              !stage ||
              !intent ||
              stage.boardSpace !== 'right-third' ||
              !/text would be clipped by the boardwork reserve/u.test(String(error)) ||
              presentationImageRefs(slide.svg).length
            )
              throw error;
            const recovered = await recoverSemanticSlideLayout({
              aspectRatio,
              boardSpace: stage.boardSpace,
              intent,
              rawBlocks: slide.metadata?.contentBlocks,
              title: stage.title,
              visibleContent: stage.visibleContent,
            });
            return prepareLessonDraft(
              {
                ...slide,
                svg: recovered.svg,
                metadata: {
                  ...slide.metadata,
                  contentBlocks: recovered.blocks,
                  layoutRecovered: true,
                },
              },
              input,
            );
          }
        }),
      );

      if (basePlan && selectedSlides) {
        const replacements = new Map(
          selectedSlides.map((slide, index) => [
            slide.slideId,
            {
              ...fallbackPlan.slides[index],
              slideId: slide.slideId,
              order: slide.order,
            },
          ]),
        );
        return validatePresentationPlan({
          ...basePlan,
          ...(contentIntents.length
            ? { designSpec: { ...basePlan.designSpec, contentPolicyVersion: 1 } }
            : {}),
          planId: fallbackPlan.planId,
          slides: basePlan.slides.map((slide) => replacements.get(slide.slideId) ?? slide),
        });
      }
      return validatePresentationPlan(fallbackPlan);
    };

    const { value: plan } = await completeStructuredJson<PresentationPlan>({
      parse: parsePlan,
      chat: this.chatPort,
      context: {
        idempotencyKey: `${context.idempotencyKey || 'structured-json'}${context.pageSlideId ? `:${context.pageSlideId}` : selectedSlides?.length === 1 ? `:${selectedSlides[0].slideId}` : ''}`,
        scope,
        signal: (context?.abortSignal ?? context?.signal) as AbortSignal | undefined,
        ...(trustedImages ? { trustedImages } : {}),
      },
      emptyError: 'Multimodal planner returned empty response',
      request: {
        max_tokens: Math.min(32_000, Math.max(16_000, slideCount * 2_400)),
        messages: [
          {
            content: boundPresentationPromptText(
              `${this.systemPrompt}\nRequired canvas: viewBox="0 0 960 ${canvasHeight}" for aspect ratio ${aspectRatio}.${contentIntents.length ? `\nMANDATORY CONTENT CONTRACT (overrides source-template font sizes and density; add contentBlocks to each slide object when required by its compiled intent):\n${CONTENT_RENDERING_INSTRUCTIONS}\n${SEMANTIC_BLOCK_FORMAT}\nDo not invent report authors, laboratory affiliations or extra decorative text. Any title or body string longer than 16 characters must be at least 24px, all brief labels at least 16px. Reserve space for required semantic blocks before adding optional decorations.` : ''}`,
            ),
            role: 'system',
          },
          ...(teachingStages.length
            ? [{ role: 'system' as const, content: LESSON_RENDERING_INSTRUCTIONS }]
            : []),
          {
            content: contentParts.map((part) =>
              part.type === 'text'
                ? { ...part, text: boundPresentationPromptText(part.text) }
                : part,
            ),
            role: 'user',
          },
        ],
        model: this.chatPort.manifest.model,
        response_format: { type: 'json_object' },
        temperature: contentIntents.length ? 0 : 0.3,
      },
    });
    return plan;
  }
}

export const createGLMPresentationPlanner = (
  options: GLMPresentationPlannerOptions,
): PresentationPlanner => new GLMPresentationPlanner(options);

/** Provider-neutral production alias; the GLM-named export is legacy only. */
export const createMultimodalPresentationPlanner = createGLMPresentationPlanner;
