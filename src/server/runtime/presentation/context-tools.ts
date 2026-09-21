import { z } from 'zod';

import { AtomicRuntime } from '../atomic-runtime';

export const presentationToolOptions = z.object({
  search: z.boolean().default(false),
  skillIds: z.array(z.string().min(1).max(160)).max(12).default([]),
});
export interface PresentationContextServices {
  listSkills: () => Promise<{ id: string; name: string }[]>;
  readFile: (id: string) => Promise<{ name: string; content?: string; imageUrl?: string }>;
  readSkill: (id: string) => Promise<{ name: string; content: string }>;
  search: (query: string) => Promise<unknown>;
}
export function createPresentationContextRuntime(services: PresentationContextServices) {
  return new AtomicRuntime([
    {
      id: 'context',
      version: '1.0.0',
      operations: [
        {
          agent: { contexts: ['presentation.intake'] },
          name: 'context.readFile',
          description:
            'Read an owned uploaded file, including actual document text, image pixels, or an account-scoped mediaRef for audio/video.',
          input: z.object({ id: z.string().min(1) }).strict(),
          execute: ({ id }) => services.readFile(id),
        },
        {
          agent: { contexts: ['presentation.intake'] },
          name: 'context.readSkill',
          description:
            'Load the complete instructions of an owned installed or builtin skill. User selections are required guidance; discover other relevant skills with context.listSkills.',
          input: z.object({ id: z.string().min(1) }).strict(),
          execute: ({ id }) => services.readSkill(id),
        },
        {
          agent: { contexts: ['presentation.intake'] },
          name: 'context.listSkills',
          description: 'List available presentation and installed account skills.',
          input: z.object({}).strict(),
          execute: () => services.listSkills(),
        },
        {
          agent: { contexts: ['presentation.intake'] },
          name: 'context.search',
          description:
            'Search the web for factual references. Returns real results with source URLs.',
          input: z.object({ query: z.string().trim().min(2).max(500) }).strict(),
          execute: ({ query }) => services.search(query),
        },
      ],
    },
  ]);
}
