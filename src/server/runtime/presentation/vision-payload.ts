import sharp from 'sharp';

/**
 * Reference pages travel to the model as base64 image parts. Providers count tokens
 * by pixel area, so trimming bytes at the same resolution is free accuracy and only
 * buys transport headroom: a multi-megabyte body is what proxies drop first.
 */
const QUALITY_LADDER = [82, 74, 66, 58] as const;
const EDGE_LADDER = [1400, 1200, 1000] as const;
const MAX_INPUT_PIXELS = 33_554_432;

export interface VisionImageBudget {
  /** Bytes allowed for one re-encoded page, before base64 expansion. */
  readonly maxBytes: number;
}

export const DEFAULT_VISION_PAGE_BUDGET: VisionImageBudget = { maxBytes: 120 * 1024 };

/** Re-encode a page image to fit the byte budget while keeping the largest readable edge. */
export const boundVisionImage = async (
  bytes: Uint8Array,
  budget: VisionImageBudget = DEFAULT_VISION_PAGE_BUDGET,
): Promise<Uint8Array> => {
  let smallest: Uint8Array | undefined;
  for (const edge of EDGE_LADDER) {
    for (const quality of QUALITY_LADDER) {
      const output = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize({ fit: 'inside', height: edge, width: edge, withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      if (!smallest || output.length < smallest.length) smallest = output;
      if (output.length <= budget.maxBytes) return output;
    }
  }
  return smallest ?? bytes;
};

export const boundVisionImages = async (
  pages: readonly Uint8Array[],
  budget: VisionImageBudget = DEFAULT_VISION_PAGE_BUDGET,
): Promise<{ base64: string; mimeType: 'image/jpeg' }[]> =>
  Promise.all(
    pages.map(async (page) => ({
      base64: Buffer.from(await boundVisionImage(page, budget)).toString('base64'),
      mimeType: 'image/jpeg' as const,
    })),
  );
