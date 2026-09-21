import type { SkillStep } from '../skill-composition';
import type { TemplateVisualProfile } from './templates/visual-types';

export interface PresentationArtworkStoryboardSlide {
  readonly archetypeId?: string;
  readonly assetBrief?: string;
  readonly assetMode?: 'generate' | 'mixed' | 'native' | 'none' | 'reuse';
  readonly familyId?: string;
  readonly slideId: string;
}

export interface PresentationArtworkStyle {
  readonly background?: 'opaque';
  readonly promptPrefix: string;
  readonly referenceAssetRefs: readonly string[];
}

const ownedRasterId = (ref: string): boolean =>
  Boolean(ref.trim()) && ref.length <= 256 && !/^(?:https?:|data:|file:|\/|\.)/iu.test(ref.trim());

/** Bound worker pool so generate/cutout/decorate overlap without unbounded fan-out. */
export const mapPool = async <T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (!items.length) return [];
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(items[index]!, index);
      }
    }),
  );
  return results;
};

export const PRESENTATION_CUTOUT_STEPS: SkillStep[] = [
  {
    id: 'cutout',
    input: { model: 'u2net', ref: '$source' },
    operation: 'assets.removeBackground',
  },
];

export const shouldAutoCutout = (input: {
  readonly artDirection: boolean;
  readonly hasProcessing: boolean;
  readonly processAssetsAvailable: boolean;
}): boolean => input.artDirection && input.processAssetsAvailable && !input.hasProcessing;

/**
 * Lock a generate call to the learned family: palette/brushwork in the prompt,
 * owned evidence-page refs for the image model, never caller URLs.
 */
export const presentationArtworkStyle = (
  visual: TemplateVisualProfile | undefined,
  storyboard: { readonly slides?: readonly PresentationArtworkStoryboardSlide[] } | undefined,
  slideId: string,
): PresentationArtworkStyle => {
  if (!visual) return { promptPrefix: '', referenceAssetRefs: [] };
  const board = storyboard?.slides?.find((slide) => slide.slideId === slideId);
  const family = visual.families.find((item) => item.id === board?.familyId) ?? visual.families[0];
  const evidencePages = new Set(
    visual.designProgram?.archetypes.find((item) => item.id === board?.archetypeId)
      ?.evidencePages ??
      family?.pages ??
      [],
  );
  const pageRefs = (visual.pages ?? [])
    .filter((page) => !evidencePages.size || evidencePages.has(page.page))
    .map((page) => page.ref)
    .filter(ownedRasterId)
    .slice(0, 2);
  const tokens = visual.designProgram?.tokens;
  const promptPrefix = [
    'STYLE REFERENCE ONLY. Draw a NEW subject for this slide.',
    family
      ? `Medium: ${family.artwork}. Composition: ${family.composition}. Palette: ${family.palette.join(', ')}.`
      : '',
    tokens?.surface?.length ? `Surface: ${tokens.surface.join('; ')}.` : '',
    tokens?.artwork?.length ? `Artwork language: ${tokens.artwork.join('; ')}.` : '',
    board?.assetBrief ? `Storyboard subject: ${board.assetBrief}` : '',
    'Match palette, brushwork and paper texture from the reference images. Do not copy template characters, logos, layout or burned-in text.',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    background: 'opaque',
    promptPrefix,
    referenceAssetRefs: pageRefs,
  };
};

export const lockArtworkPrompt = (prefix: string, prompt: string): string =>
  [prefix, prompt]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 4000);
