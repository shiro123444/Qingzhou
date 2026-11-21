import { z } from 'zod';

const box = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine((r) => r.x + r.width <= 1.001 && r.y + r.height <= 1.001);

/** Typed observations from indexed source files, rather than model-authored claims. */
export const designReferenceSchema = z
  .object({
    style: z
      .object({
        id: z.string().regex(/^[\w-]+$/u),
        flat: z.boolean(),
        sparseDecoration: z.boolean(),
        squareCorners: z.boolean(),
        grid: z.boolean(),
        background: z.enum(['light', 'dark']).optional(),
      })
      .strict()
      .optional(),
    slots: z
      .array(
        z
          .object({
            id: z.string().min(1).max(120),
            kind: z.enum([
              'title',
              'subtitle',
              'body',
              'object',
              'table',
              'chart',
              'picture',
              'footer',
            ]),
            box,
            fontSize: z.number().positive().max(200).optional(),
          })
          .strict(),
      )
      .max(24)
      .optional(),
    accents: z
      .array(
        z
          .object({
            id: z.string().min(1).max(120),
            box,
            fill: z.string().regex(/^#[0-9a-f]{6}$/iu),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();
