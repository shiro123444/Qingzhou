import { unzipSync } from 'fflate';
import sharp from 'sharp';

import { extractPptxTemplate } from './pptx';
import type { TemplateBox, TemplateLayout } from './types';

/** Reuse an isolated native bitmap without baking the slide background into its alpha. */
export async function extractNativeComponent(
  source: Uint8Array,
  layout: TemplateLayout,
  region: TemplateBox,
): Promise<Uint8Array | null> {
  // Older immutable profiles predate source crop/transform metadata. Recover it
  // from the owned source rather than asking the user to import the deck again.
  if (layout.assetSlots.some((slot) => slot.reference && !slot.sourceTransform)) {
    try {
      const nativeLayout = extractPptxTemplate(source).layouts.find(
        (candidate) => candidate.sourceSlideId === layout.sourceSlideId,
      );
      if (!nativeLayout) return null;
      layout = nativeLayout;
    } catch {
      return null;
    }
  }
  // Approximate group transforms cannot safely describe a source-image crop.
  const candidates = layout.assetSlots.filter((slot) => {
    const transform = slot.sourceTransform;
    return (
      slot.reference &&
      /^pptx:ppt\/media\/[^/]+\.(?:png|jpe?g|webp)$/iu.test(slot.reference) &&
      transform &&
      !transform.approximate &&
      !transform.rotation &&
      !transform.flipH &&
      !transform.flipV &&
      Math.abs(slot.box.x - region.x) < 0.015 &&
      Math.abs(slot.box.y - region.y) < 0.015 &&
      Math.abs(slot.box.width - region.width) < 0.015 &&
      Math.abs(slot.box.height - region.height) < 0.015
    );
  });
  // Overlapping pictures are a composition; preserve it through the rendered-page fallback.
  if (candidates.length !== 1) return null;
  const slot = candidates[0]!;
  const path = slot.reference!.slice('pptx:'.length);
  const crop = slot.sourceCrop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  if (
    Object.values(crop).some((value) => !Number.isFinite(value) || value < 0 || value >= 1) ||
    crop.left + crop.right >= 1 ||
    crop.top + crop.bottom >= 1
  )
    return null;
  try {
    const files = unzipSync(source, {
      filter: (entry) => entry.name === path && entry.originalSize <= 32 * 1024 * 1024,
    });
    const bytes = files[path];
    if (!bytes) return null;
    const image = sharp(bytes, { limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) return null;
    if (metadata.orientation && metadata.orientation !== 1) return null;
    const left = Math.floor(metadata.width * crop.left);
    const top = Math.floor(metadata.height * crop.top);
    const width = Math.min(
      metadata.width - left,
      Math.round(metadata.width * (1 - crop.left - crop.right)),
    );
    const height = Math.min(
      metadata.height - top,
      Math.round(metadata.height * (1 - crop.top - crop.bottom)),
    );
    if (width < 1 || height < 1) return null;
    return new Uint8Array(await image.extract({ left, top, width, height }).png().toBuffer());
  } catch {
    // WMF/EMF, exotic encodings and corrupt media still use the verified rendered crop.
    return null;
  }
}
