import { createHash } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';

import type { ChannelTask } from '../schemas/botDelivery';
import { botDeliveryLedgers } from '../schemas/botDelivery';
import type { LobeChatDatabase } from '../type';

/** Separate namespace: task results never overwrite a live callback lease or send ledger. */
export class ChannelTaskModel {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
  ) {}

  private scope(
    task: Pick<ChannelTask, 'platform' | 'applicationId' | 'platformThreadId' | 'operationId'>,
  ) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          'channel-task',
          this.userId,
          task.platform,
          task.applicationId,
          task.platformThreadId,
          task.operationId,
        ]),
      )
      .digest('hex');
  }

  async record(task: ChannelTask) {
    const id = this.scope(task);
    await this.db.transaction(async (tx) => {
      await tx
        .insert(botDeliveryLedgers)
        .values({
          scopeKey: id,
          userId: this.userId,
          state: { effects: {}, events: {}, channelTask: task },
        })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(botDeliveryLedgers)
        .where(and(eq(botDeliveryLedgers.scopeKey, id), eq(botDeliveryLedgers.userId, this.userId)))
        .for('update');
      if (!row?.state.channelTask) throw new Error('channel_task_conflict');
      // The first terminal result is immutable, including during retries and late progress.
      if (!row.state.channelTask.completed)
        await tx
          .update(botDeliveryLedgers)
          .set({ state: { ...row.state, channelTask: task }, updatedAt: new Date() })
          .where(eq(botDeliveryLedgers.scopeKey, id));
    });
    return id;
  }

  async delivery(id: string, delivery: ChannelTask['delivery'], reason?: string) {
    await this.db
      .update(botDeliveryLedgers)
      .set({
        state: sql`jsonb_set(${botDeliveryLedgers.state}, '{channelTask}', (${botDeliveryLedgers.state}->'channelTask') || ${JSON.stringify({ delivery, reason: reason ?? null })}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(botDeliveryLedgers.scopeKey, id),
          eq(botDeliveryLedgers.userId, this.userId),
          sql`${botDeliveryLedgers.state}->'channelTask' is not null`,
        ),
      );
  }

  async list(
    platform: string,
    applicationId: string,
    sender?: { threadId: string; userId: string },
    id?: string,
  ) {
    const rows = await this.db
      .select({
        id: botDeliveryLedgers.scopeKey,
        state: botDeliveryLedgers.state,
        createdAt: botDeliveryLedgers.createdAt,
        updatedAt: botDeliveryLedgers.updatedAt,
      })
      .from(botDeliveryLedgers)
      .where(
        and(
          eq(botDeliveryLedgers.userId, this.userId),
          sql`${botDeliveryLedgers.state}->'channelTask'->>'platform' = ${platform}`,
          sql`${botDeliveryLedgers.state}->'channelTask'->>'applicationId' = ${applicationId}`,
          id ? eq(botDeliveryLedgers.scopeKey, id) : undefined,
          sender
            ? sql`${botDeliveryLedgers.state}->'channelTask'->>'platformThreadId' = ${sender.threadId}`
            : undefined,
          sender
            ? sql`${botDeliveryLedgers.state}->'channelTask'->>'senderExternalUserId' = ${sender.userId}`
            : undefined,
          sender
            ? sql`${botDeliveryLedgers.state}->'channelTask'->>'completed' = 'true'`
            : undefined,
        ),
      )
      .orderBy(desc(botDeliveryLedgers.createdAt), desc(botDeliveryLedgers.scopeKey))
      .limit(id || sender ? 1 : 30);
    return rows.map(({ state, ...row }) => ({ ...row, ...state.channelTask! }));
  }
}
