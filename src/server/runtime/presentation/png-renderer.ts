import sharp from 'sharp';

import { renderFormula } from './formula-renderer';
import { type PngRenderInput, pngRenderSchema } from './png-contracts';
import { renderScientificDiagram } from './semantic-blocks';

export { type PngRenderInput, pngRenderSchema } from './png-contracts';

/** Rasterize only our semantic renderers, never arbitrary SVG/URLs supplied by a model. */
export const renderSemanticPng = async (raw: PngRenderInput, signal?: AbortSignal) => {
  const input = pngRenderSchema.parse(raw);
  signal?.throwIfAborted();
  const { block, scale, background, transparent } = input;
  const fragment =
    block.kind === 'formula' ? await renderFormula(block) : renderScientificDiagram(block);
  signal?.throwIfAborted();
  const { rect } = block;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}" viewBox="${rect.x} ${rect.y} ${rect.width} ${rect.height}">${fragment}</svg>`;
  let image = sharp(Buffer.from(svg), { density: 72 * scale, limitInputPixels: 8_000_000 }).resize(
    Math.ceil(rect.width * scale),
    Math.ceil(rect.height * scale),
  );
  if (!transparent) image = image.flatten({ background });
  const { data, info } = await image.png().toBuffer({ resolveWithObject: true });
  signal?.throwIfAborted();
  return { bytes: data, width: info.width, height: info.height, source: block };
};
