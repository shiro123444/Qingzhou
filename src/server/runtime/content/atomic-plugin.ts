import { z } from 'zod';

import type { AtomicPlugin } from '../atomic-runtime';
import { type CompiledLesson, compiledLessonSchema } from '../teaching/lesson';

const publicText = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Content formatting consumes public stages, never a teacher's private lesson plan. */
export function createContentPlugin(): AtomicPlugin {
  return {
    id: 'content',
    version: '1.0.0',
    operations: [
      {
        name: 'content.lesson.markdown',
        description:
          'Render compiled public teaching stages as a Markdown handout or blog draft. Does not publish or execute content.',
        agent: { contexts: ['skills'], maxCalls: 2 },
        input: z
          .object({
            lesson: compiledLessonSchema.strict(),
            title: z.string().trim().min(1).max(60),
            description: z.string().max(160),
            publishDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            tags: z.array(z.string().max(80)).max(20).default([]),
          })
          .strict(),
        output: z.object({ content: z.string(), fingerprint: z.string() }),
        execute: ({ lesson, title, description, publishDate, tags }) => ({
          fingerprint: lesson.fingerprint,
          content: [
            '---',
            `title: ${JSON.stringify(title)}`,
            `description: ${JSON.stringify(description)}`,
            `publishDate: ${publishDate}`,
            `tags: ${JSON.stringify(tags)}`,
            'draft: true',
            '---',
            '',
            `# ${publicText(title)}`,
            ...lesson.stages.flatMap((stage: CompiledLesson['stages'][number]) => [
              '',
              `## ${publicText(stage.title)}`,
              '',
              ...stage.visibleContent.flatMap((point: string) => [publicText(point), '']),
            ]),
            '',
          ].join('\n'),
        }),
      },
    ],
  };
}
