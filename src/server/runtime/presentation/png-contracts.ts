import { z } from 'zod';

import { semanticBlockSchema } from './semantic-blocks';

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
