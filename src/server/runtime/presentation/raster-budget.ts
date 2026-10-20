import type { PresentationJobInput } from '../../../../packages/runtime-contracts/src';
import type { SlideContentIntent, VisualRequirement } from './content-intent';

/** Generated images one deck may plan and generate when the deployment says nothing else. */
export const DEFAULT_IMAGE_BUDGET = 8;

const RASTER_FALLBACK_KINDS = new Set([
  'illustration',
  'photograph',
  'scientific-illustration',
  'sticker',
]);

/** Needs a generated bitmap: explicit `image`, or a kind that is always raster. */
export const isRasterVisual = (visual: Pick<VisualRequirement, 'kind' | 'renderer'>): boolean =>
  visual.kind !== 'source-figure' &&
  (visual.renderer === 'image' ||
    (visual.renderer === undefined && RASTER_FALLBACK_KINDS.has(visual.kind)));

/** Drawable as structured vectors from a brief, without a generated bitmap. */
export const isNativeVisual = (visual: Pick<VisualRequirement, 'kind' | 'renderer'>): boolean =>
  ['scientific-diagram', 'chart'].includes(visual.kind) && !isRasterVisual(visual);

/** Kinds a structured renderer can draw from the brief without a generated bitmap. */
const NATIVE_FALLBACK_KINDS = new Set<VisualRequirement['kind']>(['chart', 'scientific-diagram']);

/** One deck-wide allowance. Lesson stages compile separately but share this counter. */
export interface RasterAllowance {
  readonly max: number;
  used: number;
}

export const createRasterAllowance = (max: number): RasterAllowance => ({
  max: Number.isInteger(max) && max > 0 ? max : 0,
  used: 0,
});

export interface RasterDemotion {
  readonly reason: 'native-fallback' | 'typographic-fallback';
  readonly slideId: string;
  readonly visualId: string;
}

const rasterKey = (slideId: string, visualId: string): string => `${slideId}/${visualId}`;
const rasterVisuals = (slide: SlideContentIntent): VisualRequirement[] =>
  (slide.visuals ?? []).filter((visual) => isRasterVisual(visual));

/** Slots the user asked for by name; their pages must keep a real generated image. */
const requestedRasterKeys = (input: PresentationJobInput): Set<string> => {
  const slots = input.options?.imageSlots;
  if (!Array.isArray(slots)) return new Set();
  return new Set(
    slots.flatMap((slot) => {
      if (!slot || typeof slot !== 'object') return [];
      const { slideId, slotId } = slot as { slideId?: unknown; slotId?: unknown };
      return typeof slideId === 'string' && typeof slotId === 'string'
        ? [rasterKey(slideId, slotId)]
        : [];
    }),
  );
};

/** Told to the model up front, so its plan fits the deck's image allowance by construction. */
export const rasterBudgetInstruction = (allowance: RasterAllowance): string => {
  const remaining = Math.max(0, allowance.max - allowance.used);
  if (!remaining)
    return `生图额度已用完（整份文稿上限 ${allowance.max} 页栅格素材）：本页不得使用 renderer:image，请改用 renderer:native 的结构化图或纯文字排版。`;
  return `整份文稿最多 ${allowance.max} 页使用 renderer:image 栅格素材，本页剩余额度 ${remaining}；额度将满时改用 renderer:native 的结构化图或纯文字排版，把生图留给最需要真实素材的页面。`;
};

/**
 * A model plan is an intent, not a budget: an image-heavy lesson can plan more raster pages
 * than the deployment allows to generate. Keep the pages that genuinely need artwork —
 * explicit user slots first, then slide order — and turn the remaining ones into structured
 * vectors or typographic pages instead of failing the whole deck.
 */
export const applyRasterBudget = (
  slides: SlideContentIntent[],
  allowance: RasterAllowance,
  input: PresentationJobInput,
): { demotions: RasterDemotion[]; slides: SlideContentIntent[] } => {
  const requested = requestedRasterKeys(input);
  const kept = new Set<string>();
  // Requested slots are never demoted: the image-slot pipeline requires them to stay raster,
  // so they take their allowance first even when the user asked for more than the budget.
  for (const slide of slides)
    for (const visual of rasterVisuals(slide))
      if (requested.has(rasterKey(slide.slideId, visual.id))) {
        kept.add(rasterKey(slide.slideId, visual.id));
        allowance.used += 1;
      }
  for (const slide of slides)
    for (const visual of rasterVisuals(slide)) {
      const key = rasterKey(slide.slideId, visual.id);
      if (kept.has(key) || allowance.used >= allowance.max) continue;
      kept.add(key);
      allowance.used += 1;
    }

  const demotions: RasterDemotion[] = [];
  const budgeted = slides.map((slide) => {
    const visuals = slide.visuals;
    if (!visuals?.length) return slide;
    const next: VisualRequirement[] = [];
    let changed = false;
    for (const visual of visuals) {
      if (!isRasterVisual(visual) || kept.has(rasterKey(slide.slideId, visual.id))) {
        next.push(visual);
        continue;
      }
      changed = true;
      if (NATIVE_FALLBACK_KINDS.has(visual.kind)) {
        demotions.push({ reason: 'native-fallback', slideId: slide.slideId, visualId: visual.id });
        next.push({ ...visual, renderer: 'native' });
        continue;
      }
      demotions.push({
        reason: 'typographic-fallback',
        slideId: slide.slideId,
        visualId: visual.id,
      });
    }
    if (!changed) return slide;
    if (!next.length)
      return {
        ...slide,
        visualKind: 'none' as const,
        visualReason: `${slide.visualReason.slice(0, 1100)}（生图额度已优先留给更需要真实素材的页面，本页改为纯文字排版）`,
        visuals: [],
      };
    return { ...slide, visualKind: next[0].kind, visuals: next };
  });
  return { demotions, slides: budgeted };
};
