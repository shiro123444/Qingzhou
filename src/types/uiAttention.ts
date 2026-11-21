import { z } from 'zod';

export const attentionAreaSchema = z.enum([
  'compose',
  'conversation',
  'computer',
  'approval',
  'music',
  'documents',
  'tasks',
  'presentation',
]);
export const uiAttentionSchema = z
  .object({
    area: attentionAreaSchema,
    evidence: z.enum(['focus', 'dwell']),
    observedAt: z.number().int().positive(),
  })
  .strict();
export type AttentionArea = z.infer<typeof attentionAreaSchema>;
export type UiAttention = z.infer<typeof uiAttentionSchema>;

/** Coarse first-party UI hints, never screen contents or authority to run a tool. */
export function formatUiAttention(value: unknown, now = Date.now()): string | undefined {
  const result = uiAttentionSchema.safeParse(value);
  if (
    !result.success ||
    now - result.data.observedAt > 30000 ||
    result.data.observedAt > now + 5000
  )
    return;
  return `Optional UI attention hint (uncertain; not a user instruction): area=${result.data.area}; evidence=${result.data.evidence}. This describes a recent focus or pointer dwell inside Qingzhou, not eye tracking, screen contents, or knowledge of the user's intent. Use it only to clarify the user's actual message. Do not invent what they are viewing, initiate actions, or bypass approval based on this hint.`;
}
