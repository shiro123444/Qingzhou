import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { agentBotProviders, channelDigestMessages, channelDigestRules } from '@/database/schemas';
import type { Transaction } from '@/database/type';

import {
  extractGroupSettings,
  extractUserAllowlist,
  shouldAllowSender,
  shouldHandleGroup,
} from './platforms/const';
import { parseOneBotEvent } from './platforms/napcat/protocol';

const qqText = z.object({
  op: z.literal(0),
  t: z.enum(['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE']),
  d: z.object({
    group_openid: z.string(),
    content: z.string(),
    author: z.object({ member_openid: z.string(), bot: z.boolean().optional() }),
  }),
});
const feishuText = z.object({
  header: z.object({ event_type: z.literal('im.message.receive_v1') }),
  event: z.object({
    sender: z.object({
      sender_type: z.literal('user'),
      sender_id: z.object({ open_id: z.string() }),
    }),
    message: z.object({
      chat_type: z.literal('group'),
      chat_id: z.string(),
      message_type: z.literal('text'),
      content: z.string(),
    }),
  }),
});

/** Only normalized group text from the already-authenticated adapter can enter the archive. */
export function digestMessage(platform: string, payload: unknown, threadId: string) {
  let groupId: string;
  let senderId: string;
  let content: string;
  if (platform === 'napcat') {
    const parsed = parseOneBotEvent(payload);
    if (!parsed || parsed.event.message_type !== 'group') return null;
    groupId = parsed.event.group_id!;
    senderId = parsed.event.user_id;
    content = parsed.text;
  } else if (platform === 'qq') {
    const parsed = qqText.safeParse(payload);
    if (!parsed.success || parsed.data.d.author.bot) return null;
    ({ group_openid: groupId, content } = parsed.data.d);
    senderId = parsed.data.d.author.member_openid;
  } else if (platform === 'feishu' || platform === 'lark') {
    const parsed = feishuText.safeParse(payload);
    if (!parsed.success) return null;
    groupId = parsed.data.event.message.chat_id;
    senderId = parsed.data.event.sender.sender_id.open_id;
    try {
      content = z
        .object({ text: z.string() })
        .parse(JSON.parse(parsed.data.event.message.content)).text;
    } catch {
      return null;
    }
  } else return null;
  if (
    !senderId ||
    senderId.length > 512 ||
    threadId !== `${platform}:group:${groupId}` ||
    !content.trim()
  )
    return null;
  return {
    groupId,
    senderId,
    content: content.replaceAll('\0', '').slice(0, 2000),
    truncated: content.length > 2000,
  };
}

export function digestGroupAllowed(settings: Record<string, unknown> | null, threadId: string) {
  return (
    /^(?:napcat|qq|feishu|lark):group:[\w-]+$/.test(threadId) &&
    shouldHandleGroup({
      candidateChannelIds: [threadId.split(':')[2]],
      groupSettings: extractGroupSettings(
        threadId.startsWith('napcat:') ? { groupPolicy: 'allowlist', ...settings } : settings,
      ),
      isDM: false,
    })
  );
}

export async function captureDigestMessage(
  tx: Transaction,
  input: {
    userId: string;
    platform: string;
    applicationId: string;
    payload: unknown;
    eventId: string;
    threadId: string;
  },
) {
  const message = digestMessage(input.platform, input.payload, input.threadId);
  if (!message) return;
  const [row] = await tx
    .select({ rule: channelDigestRules, settings: agentBotProviders.settings })
    .from(channelDigestRules)
    .innerJoin(
      agentBotProviders,
      and(
        eq(channelDigestRules.providerId, agentBotProviders.id),
        eq(agentBotProviders.userId, input.userId),
      ),
    )
    .where(
      and(
        eq(channelDigestRules.userId, input.userId),
        eq(channelDigestRules.threadId, input.threadId),
        eq(channelDigestRules.enabled, true),
        eq(agentBotProviders.platform, input.platform),
        eq(agentBotProviders.applicationId, input.applicationId),
        eq(agentBotProviders.enabled, true),
      ),
    )
    .for('update', { of: channelDigestRules });
  if (
    !row ||
    !digestGroupAllowed(row.settings, input.threadId) ||
    !shouldAllowSender({
      authorUserId: message.senderId,
      userAllowlist: extractUserAllowlist(row.settings),
    })
  )
    return;
  // Locking the rule serializes sequence allocation with claim/cursor updates: no late-commit gaps.
  await tx
    .insert(channelDigestMessages)
    .values({
      ruleId: row.rule.id,
      eventId: input.eventId,
      senderId: message.senderId,
      content: message.content,
      truncated: message.truncated,
      expiresAt: sql`clock_timestamp() + interval '7 days'`,
    })
    .onConflictDoNothing();
}
