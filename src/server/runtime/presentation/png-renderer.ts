import sharp from 'sharp';
import { z } from 'zod';

import { renderFormula } from './formula-renderer';
import { renderScientificDiagram, semanticBlockSchema } from './semantic-blocks';

export const pngRenderSchema = z
  .object({
    block: semanticBlockSchema,
    scale: z.number().finite().min(1).max(3).default(2),
    background: z
      .string()
      .regex(/^#[a-f\d]{6}$/iu)
      .default('#FFFFFF'),
    transparent: z.boolean().default(false),
  })
  .strict()
  .superRefine(({ block, scale }, context) => {
    const width = Math.ceil(block.rect.width * scale);
    const height = Math.ceil(block.rect.height * scale);
    if (width > 4096 || height > 4096 || width * height > 8_000_000)
      context.addIssue({ code: 'custom', message: 'PNG canvas exceeds 4096 px or 8 megapixels' });
  });

export type PngRenderInput = z.infer<typeof pngRenderSchema>;

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
