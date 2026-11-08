import { z } from 'zod';

export const musicTrackSchema = z
  .object({
    album: z.string().max(500).optional(),
    artist: z.string().max(500).optional(),
    coverUrl: z
      .string()
      .regex(/^\/api\/runtime\/music\/tracks\/[^/?#]+\/cover$/u)
      .optional(),
    durationMs: z.number().int().nonnegative().optional(),
    id: z.string().min(1),
    mimeType: z.string().startsWith('audio/'),
    name: z.string(),
    size: z.number().int().nonnegative(),
    playbackKind: z.enum(['full', 'preview']).optional(),
    source: z.enum(['library', 'kugou']),
    version: z.string(),
  })
  .strict();

export const musicPlaybackSchema = z
  .object({
    src: z.string().startsWith('/api/runtime/music/tracks/'),
    track: musicTrackSchema,
  })
  .strict();

export type MusicTrack = z.infer<typeof musicTrackSchema>;
export type MusicPlayback = z.infer<typeof musicPlaybackSchema>;

export const MAX_MUSIC_UPLOAD_BYTES = 64 * 1024 * 1024;
