import { z } from 'zod';

import { musicTrackSchema } from './music';

export const musicAccountStatusSchema = z
  .object({
    connectedAt: z.number().int().nonnegative().optional(),
    displayName: z.string().max(200).optional(),
    expiresAt: z.number().int().nonnegative().optional(),
    revision: z.string().min(1).max(100),
    state: z.enum(['disconnected', 'connected', 'expired']),
  })
  .strict();
export const musicAccountLoginSchema = z
  .object({
    challengeId: z.string().uuid(),
    expiresAt: z.number().int().nonnegative(),
    pollAfterMs: z.number().int().min(1000).max(10000),
    qrUrl: z
      .string()
      .regex(
        /^https:\/\/h5\.kugou\.com\/apps\/loginQRCode\/html\/index\.html\?qrcode=[\w-]{1,256}$/u,
      ),
  })
  .strict();
export const musicAccountPollSchema = z
  .object({
    account: musicAccountStatusSchema.optional(),
    pollAfterMs: z.number().int().min(1000).max(10000),
    state: z.enum(['waiting', 'scanned', 'connected', 'expired', 'cancelled']),
  })
  .strict();
export type MusicAccountStatus = z.infer<typeof musicAccountStatusSchema>;
export type MusicAccountLogin = z.infer<typeof musicAccountLoginSchema>;
export type MusicAccountPoll = z.infer<typeof musicAccountPollSchema>;

export const musicLibraryPlaylistSchema = z
  .object({
    coverUrl: z
      .string()
      .regex(/^\/api\/runtime\/music\/account\/playlists\/\d{1,20}\/cover\?revision=[a-f\d-]{36}$/u)
      .optional(),
    id: z.string().regex(/^\d{1,20}$/u),
    kind: z.enum(['liked', 'created', 'collected', 'album']),
    name: z.string().max(500),
    trackCount: z.number().int().nonnegative(),
  })
  .strict();
export const musicLibrarySchema = z
  .object({
    hasMore: z.boolean(),
    page: z.number().int().positive(),
    playlists: z.array(musicLibraryPlaylistSchema).max(100),
    revision: z.string().uuid(),
  })
  .strict();
export const musicPlaylistTracksSchema = z
  .object({
    hasMore: z.boolean(),
    page: z.number().int().positive(),
    playlist: musicLibraryPlaylistSchema,
    revision: z.string().uuid(),
    total: z.number().int().nonnegative(),
    tracks: z.array(musicTrackSchema).max(100),
  })
  .strict();
export type MusicLibraryPlaylist = z.infer<typeof musicLibraryPlaylistSchema>;
export type MusicLibrary = z.infer<typeof musicLibrarySchema>;
export type MusicPlaylistTracks = z.infer<typeof musicPlaylistTracksSchema>;
