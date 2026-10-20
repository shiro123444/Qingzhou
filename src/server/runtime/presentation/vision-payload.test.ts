import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { boundVisionImage, boundVisionImages, DEFAULT_VISION_PAGE_BUDGET } from './vision-payload';

/** Worst case for JPEG: pseudo-random pixels, not a slide. */
const noiseRaw = (width: number, height: number) => {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 1_234_567;
  for (let index = 0; index < pixels.length; index += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    pixels[index] = seed % 256;
  }
  return sharp(pixels, { raw: { channels: 3, height, width } });
};

const noisyPage = async (width: number, height: number) =>
  noiseRaw(width, height).jpeg({ quality: 100 }).toBuffer();

/** A realistic image-heavy template page: photographic artwork on a flat deck background. */
const slidePage = async (width: number, height: number) => {
  const photoWidth = Math.max(2, Math.round(width * 0.6));
  const photoHeight = Math.max(2, Math.round(height * 0.5));
  const photo = await noiseRaw(photoWidth, photoHeight).png().toBuffer();
  const background = await sharp({
    create: { background: '#123a6b', channels: 3, height, width },
  })
    .png()
    .toBuffer();
  return sharp(background)
    .composite([{ input: photo, left: Math.round(width * 0.35), top: Math.round(height * 0.25) }])
    .jpeg({ quality: 96 })
    .toBuffer();
};

describe('vision payload budget', () => {
  it('fits an ordinary template page inside the byte budget at full width', async () => {
    const source = await slidePage(1400, 788);
    expect(source.length).toBeGreaterThan(DEFAULT_VISION_PAGE_BUDGET.maxBytes);
    const bounded = await boundVisionImage(source);
    expect(bounded.length).toBeLessThanOrEqual(DEFAULT_VISION_PAGE_BUDGET.maxBytes);
    const metadata = await sharp(bounded).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(1400);
  });

  it('degrades a pathological page as far as the ladder allows without changing its shape', async () => {
    const source = await noisyPage(2400, 1350);
    const bounded = await boundVisionImage(source);
    expect(bounded.length).toBeLessThan(source.length);
    const metadata = await sharp(bounded).metadata();
    expect(metadata.width).toBeLessThanOrEqual(1400);
    expect((metadata.width ?? 0) / (metadata.height ?? 1)).toBeCloseTo(2400 / 1350, 2);
  });

  it('keeps already small pages untouched in pixels and shape', async () => {
    const source = await slidePage(800, 450);
    const metadata = await sharp(await boundVisionImage(source)).metadata();
    expect(metadata.width).toBe(800);
    expect(metadata.format).toBe('jpeg');
  });

  it('emits base64 image parts for the chat request', async () => {
    const parts = await boundVisionImages([await slidePage(1400, 788), await slidePage(900, 506)]);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.mimeType).toBe('image/jpeg');
      expect(Buffer.from(part.base64, 'base64').toString('base64')).toBe(part.base64);
      expect(Buffer.from(part.base64, 'base64').length).toBeLessThanOrEqual(
        DEFAULT_VISION_PAGE_BUDGET.maxBytes,
      );
    }
  });
});
