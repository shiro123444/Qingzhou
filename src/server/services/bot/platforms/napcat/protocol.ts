import { z } from 'zod';

const id = z.union([z.number().int().safe(), z.string().regex(/^-?\d{1,16}$/)]).transform(String);
const eventSchema = z.object({
  post_type: z.literal('message'),
  self_id: id,
  user_id: id,
  message_id: id,
  message_type: z.enum(['group', 'private']),
  group_id: id.optional(),
  time: z.number().int().nonnegative(),
  message: z
    .array(z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) }))
    .max(1024),
  sender: z.object({ nickname: z.string().optional(), card: z.string().optional() }).optional(),
});
export type OneBotEvent = z.infer<typeof eventSchema>;

/** Only array-form text is accepted; CQ strings and self echoes never execute as messages. */
export function parseOneBotEvent(payload: unknown, selfId?: string) {
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) return null;
  const event = parsed.data;
  if ((selfId && event.self_id !== selfId) || event.user_id === event.self_id) return null;
  if (event.message_type === 'group' && !event.group_id) return null;
  const text = event.message
    .filter((segment) => segment.type === 'text' && typeof segment.data.text === 'string')
    .map((segment) => segment.data.text as string)
    .join('');
  if (!text.trim()) return null;
  const threadId = `napcat:${event.message_type === 'group' ? 'group' : 'private'}:${event.message_type === 'group' ? event.group_id : event.user_id}`;
  return {
    event,
    text,
    threadId,
    eventId: `${threadId}:${event.message_id}`,
    isMention: event.message.some(
      (segment) => segment.type === 'at' && String(segment.data.qq) === event.self_id,
    ),
  };
}

export function decodeThread(threadId: string) {
  const match = /^napcat:(group|private):([1-9]\d{0,15})$/.exec(threadId);
  if (!match) throw new Error('Invalid NapCat conversation');
  return { type: match[1] as 'group' | 'private', id: match[2] };
}
