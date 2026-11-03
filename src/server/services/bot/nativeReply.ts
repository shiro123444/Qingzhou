import { z } from 'zod';

import type { CallbackDeliverySession } from './callbackLedger';
import { CallbackDeliveryError, callbackHash } from './callbackLedger';
import type { PlatformMessenger, ReplyCard, ReplyStreamFrame } from './platforms/types';
import { splitMessage } from './replyTemplate';

interface StreamReceipt {
  content?: string;
  final: boolean;
  index: number;
  msgSeq: number;
  paused?: boolean;
  remainingCharacters?: number;
  replyMessageId: string;
  sentAt?: number;
  streamId: string;
}

const streamReceiptSchema = z.object({
  content: z.string().max(2000).optional(),
  final: z.boolean(),
  index: z.number().int().nonnegative(),
  msgSeq: z.number().int().positive(),
  paused: z.boolean().optional(),
  replyMessageId: z.string().min(1),
  streamId: z.string().min(1),
  remainingCharacters: z.number().int().nonnegative().optional(),
  sentAt: z.number().finite().nonnegative().optional(),
});

type NativePlan = {
  artifacts: string[];
  mode: 'native';
  reply:
    | { cards: ReplyCard[]; kind: 'card' }
    | { frame: ReplyStreamFrame; kind: 'stream' }
    | { chunks: string[]; frame: ReplyStreamFrame; kind: 'stream-text' };
};

/** Native sends share the durable event plan and its unknown-delivery boundary. */
export async function deliverNativeReply({
  actions,
  artifacts = [],
  content,
  delivery,
  deliveryId,
  final,
  pause = false,
  messenger,
  title,
  fallbackText,
  charLimit,
}: {
  actions?: ReplyCard['actions'];
  artifacts?: string[];
  content: string;
  delivery: CallbackDeliverySession;
  deliveryId: string;
  final: boolean;
  pause?: boolean;
  fallbackText?: string;
  charLimit?: number;
  messenger: PlatformMessenger;
  title: string;
}): Promise<{ artifacts: string[] } | undefined> {
  const frozen = delivery.frozenPlan<{ mode?: string }>();
  if (frozen && frozen.mode !== 'native') return;
  const previous = delivery
    .transportReceiptEntries<unknown>('qq-stream')
    .map((entry) => {
      const parsed = streamReceiptSchema.safeParse(entry.value);
      if (!parsed.success) throw new CallbackDeliveryError('payload_conflict');
      return parsed.data;
    })
    .sort((a, b) => b.index - a.index)[0];
  if (previous && !previous.final && previous.content === undefined)
    throw new CallbackDeliveryError('payload_conflict');
  if (!frozen && previous?.final && previous.paused) return;
  if (!frozen && !previous && !messenger.createReplyCard && !messenger.sendReplyStreamFrame) return;

  let proposal: NativePlan;
  if (frozen) {
    proposal = frozen as NativePlan;
  } else if (previous || messenger.sendReplyStreamFrame) {
    if (!messenger.prepareReplyStream || !messenger.sendReplyStreamFrame)
      throw new Error('The active native reply stream is unavailable');
    if (previous?.final) throw new Error('The native reply stream has already finished');
    const prefix = previous?.content ?? '';
    const cumulative = !prefix || content.startsWith(prefix) ? content : `${prefix}\n\n${content}`;
    // This is a Qingzhou rendering budget, not an asserted QQ protocol maximum.
    const limit = Math.min(charLimit ?? 2000, 2000);
    const exceedsBudget =
      cumulative.length > limit ||
      (previous?.remainingCharacters !== undefined &&
        cumulative.length - prefix.length > previous.remainingCharacters);
    if (exceedsBudget && !previous) return final ? undefined : { artifacts: [] };
    if (exceedsBudget && !final) return { artifacts: [] };
    const target = previous ?? (await messenger.prepareReplyStream());
    const frame: ReplyStreamFrame = {
      content: exceedsBudget ? prefix : cumulative,
      final,
      index: previous ? previous.index + 1 : 0,
      msgSeq: target.msgSeq,
      replyMessageId: target.replyMessageId,
      streamId: previous?.streamId,
    };
    proposal = {
      artifacts,
      mode: 'native',
      reply: exceedsBudget
        ? {
            kind: 'stream-text',
            frame,
            chunks: splitMessage(fallbackText ?? content, charLimit),
          }
        : { kind: 'stream', frame },
    };
  } else {
    const chunks = splitMessage(content, 3000);
    proposal = {
      artifacts,
      mode: 'native',
      reply: {
        kind: 'card',
        cards: chunks.map((chunk, index) => ({
          actions: index === chunks.length - 1 ? actions : undefined,
          content: chunk,
          deliveryId: callbackHash([deliveryId, index]),
          title: chunks.length > 1 ? `${title} (${index + 1}/${chunks.length})` : title,
        })),
      },
    };
  }
  const plan = await delivery.plan(proposal);
  if (plan.reply.kind === 'card') {
    if (!messenger.createReplyCard) throw new Error('Native reply cards are unavailable');
    for (const [index, card] of plan.reply.cards.entries())
      await delivery.effect(`reply-card:${index}`, () => messenger.createReplyCard!(card));
  } else {
    if (!messenger.sendReplyStreamFrame)
      throw new Error('The active native reply stream is unavailable');
    const frame = plan.reply.frame;
    if (previous?.final && !delivery.hasDeliveredEffect('qq-stream'))
      throw new Error('The native reply stream has already finished');
    if (!delivery.hasDeliveredEffect('qq-stream') && previous?.sentAt) {
      const delay = previous.sentAt + 300 - Date.now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    await delivery.effectWithReceipt('qq-stream', async () => {
      const receipt = await messenger.sendReplyStreamFrame!(frame);
      if (!receipt.streamId || (frame.streamId && frame.streamId !== receipt.streamId))
        throw new Error('Native reply stream receipt mismatch');
      return {
        content: frame.content,
        final: frame.final,
        index: frame.index,
        msgSeq: frame.msgSeq,
        paused: pause || undefined,
        replyMessageId: frame.replyMessageId,
        streamId: receipt.streamId,
        remainingCharacters: receipt.remainingCharacters,
        sentAt: Date.now(),
      } satisfies StreamReceipt;
    });
    if (plan.reply.kind === 'stream-text') {
      for (const [index, chunk] of plan.reply.chunks.entries())
        await delivery.effect(`chunk:${index}`, () => messenger.createMessage(chunk));
    }
  }
  return { artifacts: plan.artifacts };
}
