import { z } from 'zod';

const text = z.string().trim().max(2000);
const id = z.string().regex(/^[\w-]{1,80}$/u);

/** Teacher-authored input. A model may propose a plan, never rewrite this brief. */
export const teacherBriefSchema = z
  .object({
    intention: text.min(1),
    audience: text.min(1),
    priorKnowledge: text,
    learningGoal: text.min(1),
    durationMinutes: z.number().int().min(1).max(240),
    opening: z.enum(['cover', 'direct']).optional(),
  })
  .strict();

export const lessonFrameSchema = z
  .object({
    id,
    title: text.min(1),
    kind: z.enum([
      'cover',
      'question',
      'explanation',
      'experiment',
      'boardwork',
      'section',
      'summary',
    ]),
    visibleContent: z.array(text.min(1)).max(8),
    visualCue: text,
    // Exact content excluded from this stage; not instructions to draw an answer.
    withheldContent: z.array(text.min(1)).max(12),
    boardSpace: z.enum(['none', 'right-third']),
  })
  .strict();

export const lessonBeatSchema = z
  .object({
    id,
    title: text.min(1),
    objective: text.min(1),
    teacherCue: text,
    studentAction: text,
    checkForUnderstanding: text,
    durationMinutes: z.number().finite().positive().max(120),
    locked: z.boolean(),
    frames: z.array(lessonFrameSchema).min(1).max(8),
  })
  .strict();

export const lessonPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    teachingPatterns: z
      .array(z.object({ id: z.string(), revision: z.number().int().min(0), name: z.string() }))
      .max(6)
      .optional(),
    brief: teacherBriefSchema,
    beats: z.array(lessonBeatSchema).min(1).max(30),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const frames = plan.beats.flatMap((beat) => beat.frames);
    if (frames.length > 100)
      ctx.addIssue({
        code: 'custom',
        message: 'A lesson may contain at most 100 presentation stages',
      });
    for (const items of [plan.beats, frames])
      if (new Set(items.map((item) => item.id)).size !== items.length)
        ctx.addIssue({ code: 'custom', message: 'Lesson beat and frame IDs must be unique' });
    for (const frame of frames) {
      const visible = [frame.title, ...frame.visibleContent, frame.visualCue].join('\n');
      if (frame.withheldContent.some((answer) => visible.includes(answer)))
        ctx.addIssue({ code: 'custom', message: `Stage ${frame.id} exposes withheld content` });
    }
  });

export type TeacherBrief = z.infer<typeof teacherBriefSchema>;
export type LessonPlan = z.infer<typeof lessonPlanSchema>;
export type LessonBeat = z.infer<typeof lessonBeatSchema>;
export type LessonFrame = z.infer<typeof lessonFrameSchema>;

/** Public projection only. Private cues/answers must not become renderer input. */
export const lessonOutline = (plan: LessonPlan) =>
  plan.beats.flatMap((beat) =>
    beat.frames.map((frame) => ({
      id: frame.id,
      title: frame.title,
      claim: frame.title,
      keyPoints: frame.visibleContent,
      visualSuggestion: frame.visualCue,
    })),
  );

export const lessonStages = (plan: LessonPlan) =>
  plan.beats.flatMap((beat) => beat.frames.map((frame) => ({ beat, frame })));
