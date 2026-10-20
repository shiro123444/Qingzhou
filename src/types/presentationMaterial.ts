import { z } from 'zod';

export const materialLocatorSchema = z.object({
  page: z.number().int().positive().optional(),
  section: z.number().int().positive().optional(),
  chunk: z.number().int().positive(),
});

export const materialSegmentSchema = z.object({
  id: z.string().min(1).max(240),
  sourceId: z.string().min(1).max(200),
  locator: materialLocatorSchema,
  text: z.string().min(1).max(2000),
});

export const materialDocumentSchema = z.object({
  sourceId: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  fingerprint: z.string().regex(/^[a-f\d]{64}$/u),
  format: z.string().min(1).max(40),
  totalSegments: z.number().int().nonnegative(),
  totalCharacters: z.number().int().nonnegative(),
  emptyPages: z.array(z.number().int().positive()).max(2000),
  segments: z
    .array(
      z.object({
        id: z.string().min(1).max(240),
        locator: materialLocatorSchema,
        heading: z.string().max(120),
        characters: z.number().int().positive().max(2000),
      }),
    )
    .max(2000),
});

/** Read evidence travels separately from the lossy, prose-oriented research receipts. */
export const presentationMaterialsSchema = z.object({
  documents: z.array(materialDocumentSchema).max(24),
  segments: z.array(materialSegmentSchema).max(96),
  artifacts: z
    .array(
      z.object({
        id: z.string().regex(/^attachment-[\da-f-]+$/u),
        name: z.string().min(1).max(500),
        url: z
          .string()
          .regex(/^\/api\/runtime\/presentation\/artifacts\/attachment-[\da-f-]+\?raw=true$/u),
      }),
    )
    .max(64)
    .optional(),
});

export type MaterialSegment = z.infer<typeof materialSegmentSchema>;
export type MaterialDocumentManifest = z.infer<typeof materialDocumentSchema>;
export type PresentationMaterials = z.infer<typeof presentationMaterialsSchema>;

export const materialSourceRefSchema = z.object({
  sourceId: z.string().min(1).max(200),
  segmentId: z.string().min(1).max(240),
});
export type MaterialSourceRef = z.infer<typeof materialSourceRefSchema>;
