import { z } from 'zod';

import { musicPlaybackSchema, musicTrackSchema } from '@/types/music';

import type { AtomicInvocation, AtomicPlugin } from '../atomic-runtime';
import { MusicError, type MusicProvider } from './contracts';

const trackInput = z.object({ trackId: z.string().min(1).max(200) }).strict();
function provider(ctx: AtomicInvocation) {
  const service = ctx.services?.music as MusicProvider | undefined;
  if (!service || service.userId !== ctx.scope.userId) throw new MusicError('MUSIC_FORBIDDEN', 403);
  return service;
}

export function createMusicPlugin(): AtomicPlugin {
  return {
    id: 'music',
    version: '1.0.0',
    operations: [
      {
        name: 'music.search',
        description: 'Search the authenticated account audio library by filename.',
        agent: { contexts: ['skills'], maxCalls: 5 },
        input: z
          .object({
            query: z.string().trim().max(200).default(''),
            limit: z.number().int().min(1).max(50).default(20),
          })
          .strict(),
        output: z.object({ tracks: z.array(musicTrackSchema).max(50) }).strict(),
        execute: async ({ query, limit }, ctx) => ({
          tracks: await provider(ctx).search(query, limit, ctx.signal),
        }),
      },
      {
        name: 'music.track.get',
        description: 'Read an owned audio track without exposing storage locations.',
        agent: { contexts: ['skills'], maxCalls: 5 },
        input: trackInput,
        output: musicTrackSchema,
        execute: ({ trackId }, ctx) => provider(ctx).track(trackId, ctx.signal),
      },
      {
        name: 'music.playback.resolve',
        description: 'Resolve an owned track to an authenticated same-origin stream.',
        input: trackInput,
        output: musicPlaybackSchema,
        execute: ({ trackId }, ctx) => provider(ctx).resolve(trackId, ctx.signal),
      },
    ],
  };
}
