import { createHash } from 'node:crypto';

import sharp from 'sharp';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { SkillStep } from '../skill-composition';
import type { PresentationArtifactStore } from './artifact-store';
import type { TemplateVisualProfile } from './templates/visual-types';

export interface PresentationArtworkPolicy {
  readonly background: 'preserve' | 'transparent';
  readonly role: 'subject' | 'decoration' | 'scene' | 'background' | 'texture';
}

export const isReusableTemplateDecoration = (
  component: TemplateVisualProfile['components'][number],
): boolean =>
  ['background', 'decoration', 'frame'].includes(component.role) &&
  !component.containsText &&
  !['redraw', 'native'].includes(component.treatment);

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
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new RangeError('Asset concurrency must be a positive integer');
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  let failed = false;
  let failure: unknown;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (!failed && next < items.length) {
        const index = next;
        next += 1;
        try {
          results[index] = await mapper(items[index]!, index);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    }),
  );
  // Drain work already owned by Cordis before releasing the request/cache. No
  // new work starts after failure; completed siblings remain reusable on retry.
  if (failed) throw failure;
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
  readonly artwork?: PresentationArtworkPolicy;
  readonly hasProcessing: boolean;
}): boolean =>
  input.artwork?.background === 'transparent' &&
  ['subject', 'decoration'].includes(input.artwork.role) &&
  !input.hasProcessing;

/**
 * Operations whose contract is "the returned bitmap has usable transparency".
 */
export const CUTOUT_OPERATIONS = [
  'assets.removeBackground',
  'assets.keyColor',
  'assets.applyMask',
] as const;

export const requestsCutout = (steps: readonly SkillStep[]): boolean =>
  steps.some((step) => (CUTOUT_OPERATIONS as readonly string[]).includes(step.operation));

export interface CutoutTransparency {
  /** False when the produced bytes could not be decoded, so the server has no fact to report. */
  readonly checked: boolean;
  readonly hasAlphaChannel: boolean;
  readonly transparentRatio: number;
  /** True only when the bitmap carries alpha and enough of it is actually transparent. */
  readonly verified: boolean;
}

/**
 * A cutout workflow can return an opaque bitmap — segmentation miss, or a provider that ignored the
 * transparent-background request. Pasted as a decoration that is a white block on the slide, so the
 * server measures the pixels it produced instead of trusting the workflow name. Undecodable bytes
 * stay unchecked: review remains the arbiter rather than a hard failure.
 */
export const verifyCutoutTransparency = async (
  bytes: ArrayBuffer | Uint8Array,
  options?: {
    readonly minTransparentRatio?: number;
    readonly sampleEdge?: number;
    readonly transparentAlphaMax?: number;
  },
): Promise<CutoutTransparency> => {
  const unchecked: CutoutTransparency = {
    checked: false,
    hasAlphaChannel: false,
    transparentRatio: 0,
    verified: false,
  };
  const minTransparentRatio = Math.min(1, Math.max(0, options?.minTransparentRatio ?? 0.05));
  const sampleEdge = Math.round(Math.min(2048, Math.max(16, options?.sampleEdge ?? 256)));
  const transparentAlphaMax = Math.round(
    Math.min(255, Math.max(0, options?.transparentAlphaMax ?? 16)),
  );
  const buffer = Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  try {
    // Alpha presence is a property of the produced file, never of the sampling below.
    const source = await sharp(buffer).metadata();
    if (!source.hasAlpha)
      return { checked: true, hasAlphaChannel: false, transparentRatio: 0, verified: false };
    const { data, info } = await sharp(buffer)
      .resize({ width: sampleEdge, height: sampleEdge, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels < 4) return unchecked;
    const pixels = info.width * info.height;
    if (!pixels) return unchecked;
    let transparent = 0;
    for (let offset = 3; offset < data.length; offset += info.channels)
      if (data[offset]! <= transparentAlphaMax) transparent += 1;
    const transparentRatio = transparent / pixels;
    return {
      checked: true,
      hasAlphaChannel: true,
      transparentRatio,
      verified: transparentRatio >= minTransparentRatio,
    };
  } catch {
    return unchecked;
  }
};

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
  const pageRefs = (visual.styleAtlas ?? [])
    .filter(
      (page) =>
        page.familyId === family?.id && (!evidencePages.size || evidencePages.has(page.sourcePage)),
    )
    .map((page) => page.ref)
    .filter(ownedRasterId)
    .slice(0, 2);
  const tokens = visual.designProgram?.tokens;
  const promptPrefix = [
    'STYLE REFERENCE ONLY. Draw a NEW subject for this slide.',
    'Match palette, brushwork and paper texture from the references. Do not copy template characters, logos, layout or burned-in text.',
    family ? `Palette: ${family.palette.join(', ')}. Medium: ${family.artwork.slice(0, 600)}.` : '',
    tokens?.surface?.length ? `Surface: ${tokens.surface.join('; ').slice(0, 350)}.` : '',
    tokens?.artwork?.length ? `Artwork language: ${tokens.artwork.join('; ').slice(0, 350)}.` : '',
    board?.assetBrief ? `Storyboard subject: ${board.assetBrief.slice(0, 600)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    background: 'opaque',
    promptPrefix,
    referenceAssetRefs: pageRefs,
  };
};

/** Crop text-free artwork samples, never pass an entire slide's layout to image generation. */
export async function createArtworkStyleAtlas(
  visual: TemplateVisualProfile,
  store: PresentationArtifactStore,
  scope: RuntimeScope,
): Promise<TemplateVisualProfile> {
  if (visual.styleAtlas) return visual;
  const styleAtlas: NonNullable<TemplateVisualProfile['styleAtlas']> = [];
  const candidates = visual.components
    .filter((component) => {
      const box = component.box;
      return (
        !component.containsText &&
        ['artwork', 'decoration', 'background'].includes(component.role) &&
        box.width * box.height <= 0.5 &&
        box.width >= 0.08 &&
        box.height >= 0.08 &&
        box.width / box.height < 5 &&
        box.height / box.width < 5
      );
    })
    .slice(0, 12);
  for (const component of candidates) {
    if (styleAtlas.filter((sample) => sample.familyId === component.familyId).length >= 2) continue;
    const page = visual.pages.find((item) => item.page === component.page);
    if (!page || !ownedRasterId(page.ref)) continue;
    const source = await store.get(scope, page.ref);
    if (!source?.bytes) continue;
    const ref = `template-style-${createHash('sha256')
      .update(JSON.stringify([visual.versionId, page.ref, component.box]))
      .digest('hex')
      .slice(0, 40)}`;
    if (!(await store.get(scope, ref))?.bytes) {
      const metadata = await sharp(source.bytes).metadata();
      if (!metadata.width || !metadata.height) continue;
      const left = Math.floor(component.box.x * metadata.width);
      const top = Math.floor(component.box.y * metadata.height);
      const width = Math.min(
        metadata.width - left,
        Math.ceil(component.box.width * metadata.width),
      );
      const height = Math.min(
        metadata.height - top,
        Math.ceil(component.box.height * metadata.height),
      );
      if (width < 8 || height < 8) continue;
      const bytes = await sharp(source.bytes)
        .extract({ left, top, width, height })
        .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      await store.put(scope, {
        artifactId: ref,
        bytes,
        type: 'image',
        mimeType: 'image/png',
        name: `${component.name} · style sample`,
        metadata: {
          role: 'style-atlas',
          sourcePage: component.page,
          templateVersionId: visual.versionId,
          componentId: component.id,
        },
      });
    }
    styleAtlas.push({
      ref,
      familyId: component.familyId,
      sourcePage: component.page,
      componentId: component.id,
    });
  }
  return styleAtlas.length ? { ...visual, styleAtlas } : visual;
}

export const lockArtworkPrompt = (prefix: string, prompt: string): string => {
  const subject = prompt.trim();
  if (!subject || subject.length > 4000)
    throw new RangeError('Artwork subject must contain 1 to 4000 characters');
  const style = prefix.trim().slice(0, Math.max(0, 4000 - subject.length - 1));
  return style ? `${subject}\n${style}` : subject;
};
