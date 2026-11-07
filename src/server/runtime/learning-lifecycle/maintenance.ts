import type { HarnessScope } from '@lobechat/agent-runtime';
import type { LobeChatDatabase } from '@lobechat/database';
import { asc, eq, isNull, lt, or, sql, and } from 'drizzle-orm';

import { agentHarnessDecisions, learningBudgetRoots, users } from '@/database/schemas';
import type { HarnessPublicationPort, PublicationEvent } from '../improvement/publication';
import { LearningHistoryRetention } from './history';
import { eraseLearningFiles, pendingLearningErasures, requestLearningErasure } from './files';

/** Each process can run this worker. Durable per-entry claims fence publication acknowledgments. */
export class LearningMaintenance {
  private history: LearningHistoryRetention;
  private running?: Promise<{ scopes: number; erased: number }>;
  constructor(
    private db: LobeChatDatabase,
    private publication: HarnessPublicationPort,
    private deliver: (event: PublicationEvent) => Promise<void>,
  ) {
    this.history = new LearningHistoryRetention(db);
  }
  async requestErasure(userId: string) {
    requestLearningErasure(userId);
    await this.db
      .update(learningBudgetRoots)
      .set({ state: sql`jsonb_set(${learningBudgetRoots.state}, '{cancelled}', 'true'::jsonb)` })
      .where(eq(learningBudgetRoots.userId, userId));
  }
  tick() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async run() {
    const scopes = await this.db
      .selectDistinct({
        userId: agentHarnessDecisions.userId,
        agentId: agentHarnessDecisions.agentId,
      })
      .from(agentHarnessDecisions)
      .where(
        and(
          isNull(agentHarnessDecisions.deliveredAt),
          or(
            isNull(agentHarnessDecisions.leaseUntil),
            lt(agentHarnessDecisions.leaseUntil, sql`now()`),
          ),
        ),
      )
      .orderBy(asc(agentHarnessDecisions.userId), asc(agentHarnessDecisions.agentId))
      .limit(16);
    for (const scope of scopes)
      await this.publication.flushOutbox(scope as HarnessScope, this.deliver);
    let erased = 0;
    for (const job of await pendingLearningErasures()) {
      const [present] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, job.userId))
        .limit(1);
      // A failed/cancelled database deletion must never erase a live account's evidence.
      if (!present && (await eraseLearningFiles(job.userId))) erased++;
    }
    await this.history.tick();
    return { scopes: scopes.length, erased };
  }
  start(intervalMs = 30_000) {
    let stopped = false;
    const run = () => {
      if (!stopped)
        void this.tick().catch(() =>
          console.error('[learning-maintenance] Tick failed; durable work remains pending'),
        );
    };
    const timer = setInterval(run, intervalMs);
    timer.unref();
    run();
    return async () => {
      stopped = true;
      clearInterval(timer);
      await this.running;
    };
  }
}
