import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';

import { agentBotProviders } from '../schemas/agentBotProvider';
import { botDeliveryJobs } from '../schemas/botDelivery';
import {
  channelDigestMessages as messages,
  channelDigestRules as rules,
  type ChannelDigestRun,
  channelDigestRuns as runs,
} from '../schemas/channelDigest';
import type { LobeChatDatabase, Transaction } from '../type';
import type { DeliveryEnvelope } from './botDelivery';

/** Daily schedules use China Standard Time; no process-local timers or DST assumptions. */
export function nextDigestAt(time: string, after: Date): Date {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('invalid_digest_time');
  const offset = 8 * 3600_000;
  const local = new Date(after.getTime() + offset);
  const [hour, minute] = time.split(':').map(Number);
  let next =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) -
    offset;
  if (next <= after.getTime()) next += 86400_000;
  return new Date(next);
}

export interface DigestSettings {
  enabled: boolean;
  scheduleTime: string;
  sendToSource: boolean;
  threadId: string;
}

export class ChannelDigestModel {
  constructor(private readonly db: LobeChatDatabase) {}

  private transaction<T>(run: (tx: Transaction) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5000ms'`);
      return run(tx);
    });
  }

  async list(userId: string, providerId: string) {
    const subscriptions = await this.db
      .select()
      .from(rules)
      .where(and(eq(rules.userId, userId), eq(rules.providerId, providerId)))
      .orderBy(asc(rules.createdAt));
    const history = subscriptions.length
      ? await this.db
          .select({ run: runs, threadId: rules.threadId })
          .from(runs)
          .innerJoin(rules, eq(runs.ruleId, rules.id))
          .where(and(eq(rules.userId, userId), eq(rules.providerId, providerId)))
          .orderBy(desc(runs.createdAt))
          .limit(30)
      : [];
    const deliveries = history.length
      ? await this.db
          .select({
            operationId: botDeliveryJobs.operationId,
            role: botDeliveryJobs.role,
            status: botDeliveryJobs.status,
          })
          .from(botDeliveryJobs)
          .where(
            and(
              eq(botDeliveryJobs.userId, userId),
              inArray(
                botDeliveryJobs.operationId,
                history.map(({ run }) => `channel-digest:${run.id}`),
              ),
            ),
          )
      : [];
    return {
      subscriptions,
      history: history.map((entry) => {
        const candidates = deliveries.filter(
          (job) => job.operationId === `channel-digest:${entry.run.id}`,
        );
        return {
          ...entry,
          deliveryStatus:
            (candidates.find((job) => job.role === 'inbox') ?? candidates[0])?.status ?? null,
        };
      }),
    };
  }

  async save(userId: string, providerId: string, settings: DigestSettings) {
    return this.transaction(async (tx) => {
      // Serialize creation and edits with provider deletion; cap subscriptions per installation.
      const [provider] = await tx
        .select({ id: agentBotProviders.id })
        .from(agentBotProviders)
        .where(and(eq(agentBotProviders.id, providerId), eq(agentBotProviders.userId, userId)))
        .for('update');
      if (!provider) throw new Error('digest_provider_not_found');
      const existing = await tx.select().from(rules).where(eq(rules.providerId, providerId));
      if (!existing.some((row) => row.threadId === settings.threadId) && existing.length >= 10)
        throw new Error('digest_rule_limit');
      const values = {
        ...settings,
        revision: randomUUID(),
        nextRunAt: nextDigestAt(settings.scheduleTime, new Date()),
      };
      await tx
        .insert(rules)
        .values({ ...values, userId, providerId })
        .onConflictDoUpdate({ target: [rules.providerId, rules.threadId], set: values });
    });
  }

  async remove(userId: string, providerId: string, id: string) {
    await this.transaction(async (tx) => {
      const [rule] = await tx
        .select({ id: rules.id })
        .from(rules)
        .where(and(eq(rules.id, id), eq(rules.userId, userId), eq(rules.providerId, providerId)))
        .for('update');
      if (!rule) return;
      await tx
        .update(botDeliveryJobs)
        .set({
          payload: null,
          status: sql`case when ${botDeliveryJobs.status} = 'delivered' then 'delivered' else 'dead' end`,
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCode: 'digest_deleted',
        })
        .where(
          and(
            eq(botDeliveryJobs.userId, userId),
            inArray(
              botDeliveryJobs.operationId,
              tx
                .select({ operationId: sql<string>`'channel-digest:' || ${runs.id}::text` })
                .from(runs)
                .where(eq(runs.ruleId, id)),
            ),
          ),
        );
      await tx.delete(rules).where(eq(rules.id, id));
    });
  }

  async claim() {
    return this.transaction(async (tx) => {
      const [row] = await tx
        .select({
          rule: rules,
          provider: {
            id: agentBotProviders.id,
            userId: agentBotProviders.userId,
            agentId: agentBotProviders.agentId,
            platform: agentBotProviders.platform,
            applicationId: agentBotProviders.applicationId,
            settings: agentBotProviders.settings,
          },
        })
        .from(rules)
        .innerJoin(
          agentBotProviders,
          and(
            eq(rules.providerId, agentBotProviders.id),
            eq(rules.userId, agentBotProviders.userId),
          ),
        )
        .where(
          and(
            eq(rules.enabled, true),
            eq(agentBotProviders.enabled, true),
            lte(rules.nextRunAt, sql`clock_timestamp()`),
            sql`not exists (select 1 from channel_digest_runs r where r.rule_id = ${rules.id} and r.status = 'running')`,
          ),
        )
        .orderBy(asc(rules.nextRunAt))
        .limit(1)
        .for('update', { of: rules, skipLocked: true });
      if (!row) return null;
      const candidates = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.ruleId, row.rule.id),
            gt(messages.id, row.rule.cursor),
            gt(messages.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .orderBy(asc(messages.id))
        .limit(201);
      const selected: typeof candidates = [];
      let size = 0;
      for (const message of candidates.slice(0, 200)) {
        if (size + message.content.length > 40_000) break;
        selected.push(message);
        size += message.content.length;
      }
      const [run] = await tx
        .insert(runs)
        .values({
          ruleId: row.rule.id,
          revision: row.rule.revision,
          status: 'running',
          scheduledFor: row.rule.nextRunAt,
          leaseExpiresAt: sql`clock_timestamp() + interval '90 seconds'`,
          lastMessageId: selected.at(-1)?.id ?? row.rule.cursor,
          messageCount: selected.length,
          hasMore: candidates.length > selected.length,
          truncated: selected.some((message) => message.truncated),
        })
        .returning();
      // A failed/unknown model call is never automatically replayed within this schedule.
      await tx
        .update(rules)
        .set({ nextRunAt: nextDigestAt(row.rule.scheduleTime, new Date()) })
        .where(eq(rules.id, row.rule.id));
      return { ...row, run, messages: selected };
    });
  }

  async finish(run: ChannelDigestRun, content: string | null, delivery?: DeliveryEnvelope) {
    return this.transaction(async (tx) => {
      const [rule] = await tx.select().from(rules).where(eq(rules.id, run.ruleId)).for('update');
      const [provider] = rule
        ? await tx
            .select({ enabled: agentBotProviders.enabled })
            .from(agentBotProviders)
            .where(
              and(
                eq(agentBotProviders.id, rule.providerId),
                eq(agentBotProviders.userId, rule.userId),
              ),
            )
        : [];
      if (!rule?.enabled || rule.revision !== run.revision || !provider?.enabled) {
        await tx
          .update(runs)
          .set({ status: 'cancelled' })
          .where(and(eq(runs.id, run.id), eq(runs.status, 'running')));
        return false;
      }
      const [finished] = await tx
        .update(runs)
        .set({ content, status: content ? 'completed' : 'empty' })
        .where(
          and(
            eq(runs.id, run.id),
            eq(runs.status, 'running'),
            gt(runs.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ id: runs.id });
      if (!finished) return false;
      await tx.update(rules).set({ cursor: run.lastMessageId }).where(eq(rules.id, rule.id));
      // Result and delivery intent commit together. Delivery retries never call the model again.
      if (delivery && content && rule.sendToSource)
        await tx
          .insert(botDeliveryJobs)
          .values({
            ...delivery,
            id: `outbox:${delivery.eventKey}`,
            role: 'outbox',
            payload: JSON.stringify(delivery.payload),
          })
          .onConflictDoNothing();
      return true;
    });
  }

  async fail(run: ChannelDigestRun, status: 'failed' | 'cancelled') {
    await this.db
      .update(runs)
      .set({ status })
      .where(and(eq(runs.id, run.id), eq(runs.status, 'running')));
  }

  async maintenance() {
    await this.db
      .update(runs)
      .set({ status: 'unknown' })
      .where(and(eq(runs.status, 'running'), lte(runs.leaseExpiresAt, sql`clock_timestamp()`)));
    await this.db.delete(messages).where(
      inArray(
        messages.id,
        this.db
          .select({ id: messages.id })
          .from(messages)
          .where(lte(messages.expiresAt, sql`clock_timestamp()`))
          .limit(5000),
      ),
    );
    await this.db.delete(runs).where(
      inArray(
        runs.id,
        this.db
          .select({ id: runs.id })
          .from(runs)
          .where(lte(runs.createdAt, sql`clock_timestamp() - interval '30 days'`))
          .limit(500),
      ),
    );
  }
}
