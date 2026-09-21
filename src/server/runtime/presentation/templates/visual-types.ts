import { z } from 'zod';

import {
  compileTemplateDesignProgram,
  type TemplateDesignProgram,
  templateDesignProgramSchema,
} from './design-program';

export const templateBoxSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine(
    (box) => box.x + box.width <= 1.001 && box.y + box.height <= 1.001,
    'Region must fit inside the reference page',
  );

export const templateLearningChoiceSchema = z.object({
  id: z.string().regex(/^[\w-]{1,80}$/),
  label: z.string().min(1).max(240),
  consequence: z.string().min(1).max(500),
});

export const templateLearningQuestionSchema = z
  .object({
    id: z.string().regex(/^[\w-]{1,80}$/),
    question: z.string().min(1).max(500),
    reason: z.string().min(1).max(800),
    choices: z.array(templateLearningChoiceSchema).min(2).max(4),
    recommendedChoiceId: z.string().max(80).optional(),
    page: z.number().int().positive().optional(),
    mediaId: z.string().max(120).optional(),
  })
  .refine(
    (value) =>
      !value.recommendedChoiceId ||
      value.choices.some((choice) => choice.id === value.recommendedChoiceId),
    'Recommended choice must be present in choices',
  );

export const templateMediaAnalysisSchema = z.object({
  mediaId: z.string().min(1).max(120),
  kind: z.enum(['audio', 'video']),
  page: z.number().int().positive(),
  status: z.enum(['analyzed', 'metadata-only', 'unavailable']),
  durationSeconds: z.number().nonnegative().max(86_400).optional(),
  width: z.number().int().positive().max(16_384).optional(),
  height: z.number().int().positive().max(16_384).optional(),
  frameRefs: z.array(z.string().min(1).max(180)).max(3).default([]),
  summary: z.string().min(1).max(1600),
  visualStyle: z.string().max(1600).default(''),
  role: z
    .enum(['ambient', 'demonstration', 'narrative', 'decorative', 'unknown'])
    .default('unknown'),
  preserveRecommendation: z.enum(['preserve', 'poster', 'replace', 'optional']).default('preserve'),
  confidence: z.number().min(0).max(1),
  questions: z.array(templateLearningQuestionSchema).max(2).default([]),
  transcript: z.string().max(12_000).optional(),
  transcriptLanguage: z.string().max(40).optional(),
  transcriptStatus: z.enum(['not-requested', 'ready', 'unavailable']).default('not-requested'),
});

export const templateVisualAnalysisSchema = z.object({
  summary: z.string().min(1).max(1800),
  families: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        name: z.string().min(1).max(100),
        pages: z.array(z.number().int().positive()).min(1).max(20),
        palette: z.array(z.string().regex(/^#[a-f\d]{6}$/i)).max(10),
        typography: z.string().max(1200),
        composition: z.string().max(1800),
        artwork: z.string().max(1800),
        preserve: z.array(z.string().max(500)).max(10),
      }),
    )
    .min(1)
    .max(6),
  components: z
    .array(
      z.object({
        id: z.string().regex(/^[\w-]{1,80}$/),
        name: z.string().min(1).max(100),
        page: z.number().int().positive(),
        familyId: z.string().max(60),
        box: templateBoxSchema,
        role: z.enum(['background', 'decoration', 'artwork', 'frame', 'heading']),
        containsText: z.boolean(),
        treatment: z.enum(['reuse', 'crop', 'removeBackground', 'redraw', 'native']),
        rationale: z.string().max(1200),
        generationPrompt: z.string().max(3000).optional(),
      }),
    )
    .max(24),
  guidance: z.string().min(1).max(2500),
  designProgram: templateDesignProgramSchema.optional(),
  questions: z.array(templateLearningQuestionSchema).max(3).default([]),
});
export interface TemplateRenderedPage {
  height: number;
  nativeTextCount: number;
  page: number;
  ref: string;
  width: number;
}
export type TemplateVisualAnalysis = z.infer<typeof templateVisualAnalysisSchema>;
export type TemplateLearningQuestion = z.infer<typeof templateLearningQuestionSchema>;
export type TemplateMediaAnalysis = z.infer<typeof templateMediaAnalysisSchema>;
export type TemplateVisualProfile = Omit<TemplateVisualAnalysis, 'designProgram' | 'questions'> & {
  designProgram: TemplateDesignProgram;
  schemaVersion: 3;
  templateId: string;
  versionId: string;
  model: string;
  analyzedAt: string;
  learning: {
    guidanceHistory: string[];
    iteration: number;
    questions: TemplateLearningQuestion[];
    status: 'needs_input' | 'ready';
  };
  media: TemplateMediaAnalysis[];
  pages: TemplateRenderedPage[];
};

const storedTemplateVisualProfileSchema = templateVisualAnalysisSchema.extend({
  analyzedAt: z.string().min(1),
  model: z.string().min(1),
  learning: z
    .object({
      guidanceHistory: z.array(z.string().min(1).max(2000)).max(32),
      iteration: z.number().int().nonnegative().max(32),
      questions: z.array(templateLearningQuestionSchema).max(3),
      status: z.enum(['needs_input', 'ready']),
    })
    .optional(),
  media: z.array(templateMediaAnalysisSchema).max(32).optional(),
  pages: z.array(
    z.object({
      height: z.number().positive(),
      nativeTextCount: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      ref: z.string().min(1),
      width: z.number().positive(),
    }),
  ),
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  templateId: z.string().min(1),
  versionId: z.string().min(1),
});

const legacyVisualProfiles = new WeakSet<object>();

/** Older caches can be read safely, but lack the current media and clarification evidence. */
export const templateVisualNeedsRefresh = (profile: TemplateVisualProfile): boolean =>
  legacyVisualProfiles.has(profile);

/** Upgrade cached observations in memory without invalidating owned template versions. */
export const normalizeTemplateVisualProfile = (value: unknown): TemplateVisualProfile => {
  const parsed = storedTemplateVisualProfileSchema.parse(value);
  const normalized: TemplateVisualProfile = {
    ...parsed,
    designProgram: parsed.designProgram ?? compileTemplateDesignProgram(parsed),
    learning: parsed.learning ?? {
      guidanceHistory: [],
      iteration: 0,
      questions: [],
      status: 'ready',
    },
    media: parsed.media ?? [],
    schemaVersion: 3,
  };
  if (parsed.schemaVersion < 3) legacyVisualProfiles.add(normalized);
  return normalized;
};

export const templateVisualNeedsInput = (profile: TemplateVisualProfile): boolean =>
  profile.learning?.status === 'needs_input' && profile.learning.questions.length > 0;
