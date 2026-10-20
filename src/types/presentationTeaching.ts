import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
export const teachingSelectionSchema = z
  .object({
    course: z.string().trim().max(120).default(''),
    ids: z.array(z.string().regex(/^teaching-[a-f\d]{40}$/u)).max(6),
  })
  .strict();
export type TeachingSelection = z.infer<typeof teachingSelectionSchema>;

export const teachingSourceReferenceSchema = z
  .object({
    templateId: z.string().min(1).max(200),
    versionId: z.string().min(1).max(200).optional(),
    visual: z.boolean().optional(),
    pages: z
      .array(z.number().int().min(1).max(100))
      .min(2)
      .max(6)
      .refine((pages) => new Set(pages).size === pages.length, 'Page numbers must be unique')
      .optional(),
    window: z
      .object({ start: z.number().int().min(1).max(100), end: z.number().int().min(1).max(100) })
      .refine(
        (range) => range.end > range.start && range.end - range.start < 6,
        'Choose 2–6 consecutive pages',
      )
      .optional(),
  })
  .strict()
  .refine(
    (ref) => !(ref.pages && ref.window),
    'Choose a page list or a consecutive window, not both',
  )
  .refine((ref) => !ref.pages || ref.visual === true, 'A page list requires visual comparison')
  .refine(
    (ref) => !ref.visual || Boolean(ref.pages || ref.window),
    'Visual comparison requires 2–6 selected pages',
  );
export type TeachingSourceReference = z.infer<typeof teachingSourceReferenceSchema>;

export const teachingBuildSchema = z
  .object({
    id: z.string().max(80),
    nodeType: z.string().max(80),
    presetClass: z.string().max(80),
    targets: z.array(z.string().max(80)).max(64),
    effects: z.array(z.string().max(120)).max(64),
  })
  .strict();
export type TeachingBuild = z.infer<typeof teachingBuildSchema>;

export const teachingVisualPageSchema = z
  .object({
    page: z.number().int().min(1).max(100),
    ref: z.string().regex(/^teaching-page-[a-f\d]{40}$/u),
    sha256: z.string().regex(/^[a-f\d]{64}$/u),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    builds: z.array(teachingBuildSchema).max(64),
    buildsTruncated: z.boolean(),
  })
  .strict();
export type TeachingVisualPage = z.infer<typeof teachingVisualPageSchema>;

const regionSchema = z
  .object({
    page: z.number().int().min(1).max(100),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
    description: text,
  })
  .strict()
  .refine(
    (region) => region.x + region.width <= 1.001 && region.y + region.height <= 1.001,
    'Region exceeds page bounds',
  );
export const teachingVisualComparisonSchema = z
  .object({
    fromPage: z.number().int().min(1).max(100),
    toPage: z.number().int().min(1).max(100),
    kind: z.enum([
      'focus-shift',
      'incremental-content',
      'phenomenon-to-mechanism',
      'contrast',
      'layout-change',
      'uncertain',
    ]),
    visibleChange: text,
    alternativeExplanation: text,
    uncertainty: text,
    regions: z.array(regionSchema).min(2).max(6),
  })
  .strict();

export interface TeachingPageObservation {
  builds?: TeachingBuild[];
  buildsTruncated?: boolean;
  /** Structural cues only. Timing presence is not a click sequence or lecture duration. */
  cues: string;
  imageRefs: string[];
  notes: string;
  page: number;
  text: string;
}

export const teachingPatternSchema = z
  .object({
    name: text,
    observation: text,
    inference: text,
    confidence: z.enum(['low', 'medium', 'high']),
    applicability: text,
    prerequisites: text,
    teacherAction: text,
    learnerAction: text,
    sequence: z.array(text).min(2).max(8),
    limitations: text,
    visualComparisons: z.array(teachingVisualComparisonSchema).min(1).max(5).optional(),
    evidence: z
      .array(
        z
          .object({
            page: z.number().int().min(1).max(100),
            field: z.enum(['text', 'notes', 'cues']),
            quote: z.string().trim().min(4).max(1000),
          })
          .strict(),
      )
      .min(2)
      .max(12),
  })
  .strict();
export type TeachingPattern = z.infer<typeof teachingPatternSchema>;

export const teachingRecordSchema = z
  .object({
    id: z.string().regex(/^teaching-[a-f\d]{40}$/u),
    schemaVersion: z.literal(1),
    createdAt: z.string(),
    source: z
      .object({
        templateId: z.string(),
        versionId: z.string(),
        name: z.string(),
        sha256: z.string().regex(/^[a-f\d]{64}$/u),
        pageCount: z.number().int(),
        analysis: z.enum(['ooxml-sequence-v1', 'native-static-sequence-v1']),
        visualPages: z.array(teachingVisualPageSchema).min(2).max(6).optional(),
        window: z.object({ start: z.number().int(), end: z.number().int() }).optional(),
      })
      .strict(),
    pattern: teachingPatternSchema,
    revision: z.number().int().min(0),
    status: z.enum(['pending', 'confirmed', 'revoked']),
    history: z
      .array(
        z
          .object({
            revision: z.number().int().min(1),
            action: z.enum(['confirm', 'revoke']),
            at: z.string(),
            course: z.string().max(120),
            applicability: text,
            limitations: text,
          })
          .strict(),
      )
      .optional(),
    review: z
      .object({
        at: z.string(),
        course: z.string().trim().max(120),
        applicability: text,
        limitations: text,
      })
      .strict()
      .optional(),
  })
  .strict();
export type TeachingRecord = z.infer<typeof teachingRecordSchema>;

export const teachingReviewSchema = z
  .object({
    id: z.string().regex(/^teaching-[a-f\d]{40}$/u),
    expectedRevision: z.number().int().min(0),
    action: z.enum(['confirm', 'revoke']),
    course: z.string().trim().max(120),
    applicability: text,
    limitations: text,
  })
  .strict();
export type TeachingReview = z.infer<typeof teachingReviewSchema>;
