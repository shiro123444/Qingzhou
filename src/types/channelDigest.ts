import { z } from 'zod';

export const channelDigestSettingsSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().uuid(),
  scheduleTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  sendToSource: z.boolean(),
  threadId: z
    .string()
    .max(300)
    .regex(/^(napcat|qq|feishu|lark):group:[\w-]+$/),
});
