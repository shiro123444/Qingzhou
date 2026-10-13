import { z } from 'zod';

import { lessonPlanSchema, teacherBriefSchema } from '@/types/presentationLesson';
import {
  type TeachingRecord,
  teachingRecordSchema,
  teachingSelectionSchema,
} from '@/types/presentationTeaching';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { AtomicInvocation, AtomicOperation, AtomicPlugin } from '../atomic-runtime';
import type { MultimodalChatPort } from '../presentation/multimodal-chat-provider';
import {
  assertLessonRevision,
  compiledLessonSchema,
  compileLesson,
  proposeLesson,
  validateLesson,
} from './lesson';

/** The application owns persistence; unloading teaching never deletes account memory. */
export interface TeachingMemory {
  compose: (
    scope: RuntimeScope,
    selection: z.infer<typeof teachingSelectionSchema>,
  ) => Promise<TeachingRecord[]>;
  search: (scope: RuntimeScope, query: string, course?: string) => Promise<TeachingRecord[]>;
}

export interface TeachingPluginOptions {
  chat?:
    | MultimodalChatPort
    | ((ctx: AtomicInvocation) => MultimodalChatPort | Promise<MultimodalChatPort>);
  memory?: TeachingMemory;
}

/** Teaching can mount without a presentation planner, template library or render worker. */
export function createTeachingPlugin(options: TeachingPluginOptions = {}): AtomicPlugin {
  const operations: AtomicOperation[] = [
    {
      name: 'teaching.lesson.compile',
      description:
        'Compile a lesson into ordered public teaching stages for any renderer. Private cues and withheld answers remain in the caller-owned lesson.',
      input: z.object({ plan: lessonPlanSchema }).strict(),
      output: compiledLessonSchema,
      agent: { contexts: ['skills'], maxCalls: 4 },
      execute: ({ plan }) => compileLesson(plan),
    },
    {
      name: 'teaching.lesson.revise',
      description:
        'Validate a proposed lesson revision. Preserve the teacher brief and locked beats; this does not confirm the proposal.',
      input: z.object({ previous: lessonPlanSchema, next: lessonPlanSchema }).strict(),
      output: lessonPlanSchema,
      agent: { contexts: ['skills'], maxCalls: 4 },
      execute: ({ previous, next }) => {
        assertLessonRevision(previous, next);
        return next;
      },
    },
    {
      name: 'teaching.lesson.validate',
      description:
        'Validate teaching-stage identity and separation of public content from withheld answers and private cues. Does not validate a renderer or certify learning outcomes.',
      input: z.object({ plan: lessonPlanSchema }).strict(),
      output: z.object({ passed: z.literal(true) }),
      agent: { contexts: ['skills'], maxCalls: 4 },
      execute: ({ plan }) => validateLesson(plan),
    },
  ];
  const { chat, memory } = options;
  if (chat)
    operations.unshift({
      name: 'teaching.lesson.plan',
      description:
        'Propose a teacher-led lesson with separate visible stages, private cues and student tasks. This is a proposal, not teacher approval.',
      input: z
        .object({
          brief: teacherBriefSchema,
          topic: z.string().min(1),
          material: z.unknown().optional(),
          current: lessonPlanSchema.optional(),
          instruction: z.string().trim().max(4000).optional(),
          teachingSelection: teachingSelectionSchema.optional(),
        })
        .strict(),
      output: lessonPlanSchema,
      agent: { contexts: ['skills'], maxCalls: 2 },
      execute: async (input, ctx) => {
        if (input.teachingSelection?.ids.length && !memory)
          throw new Error('Teaching memory is not configured');
        const patterns =
          input.teachingSelection && memory
            ? await memory.compose(ctx.scope, input.teachingSelection)
            : [];
        return proposeLesson(
          typeof chat === 'function' ? await chat(ctx) : chat,
          { ...input, patterns },
          { scope: ctx.scope, signal: ctx.signal },
        );
      },
    });
  if (memory)
    operations.push(
      {
        name: 'teaching.memory.search',
        description:
          'Retrieve teacher-confirmed teaching patterns in the selected course. Empty course permits account-wide patterns only.',
        input: z
          .object({ query: z.string().max(2000), course: z.string().max(120).default('') })
          .strict(),
        output: z.array(teachingRecordSchema),
        agent: { contexts: ['skills'], maxCalls: 3 },
        execute: ({ query, course }, ctx) => memory.search(ctx.scope, query, course),
      },
      {
        name: 'teaching.memory.compose',
        description:
          'Compose up to six confirmed conditional teaching patterns. Current teacher brief and locked beats take precedence; no effect claims.',
        input: teachingSelectionSchema,
        output: z.array(teachingRecordSchema),
        agent: { contexts: ['skills'], maxCalls: 2 },
        execute: (input, ctx) => memory.compose(ctx.scope, input),
      },
    );
  return { id: 'teaching', version: '1.0.0', operations };
}
