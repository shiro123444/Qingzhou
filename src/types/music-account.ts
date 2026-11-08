import { z } from 'zod';

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
