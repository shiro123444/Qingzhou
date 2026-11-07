import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { harnessDigest } from '@lobechat/agent-runtime';
import type { LobeChatDatabase } from '@lobechat/database';
import { and, eq } from 'drizzle-orm';
import { agentHarnessDecisions, agentHarnessHeads } from '@/database/schemas';
import type { HarnessScopeState } from '../improvement/contracts';
import { FileHarnessStore } from '../improvement/store';
import { learningRoots } from './files';
import { pruneHarnessHistory } from './retention';

/** Rotate bounded scans so one old scope cannot starve later accounts. */
export class LearningHistoryRetention {
  private cursor = 0;
  constructor(private db: LobeChatDatabase) {}
  async tick() {
    const root = learningRoots()[0];
    const keys = (
      await readdir(root).catch((error) => {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return [];
        throw error;
      })
    )
      .filter((key) => /^[a-f\d]{64}$/u.test(key))
      .sort();
    if (!keys.length) return;
    for (let i = 0; i < Math.min(keys.length, 16); i++) {
      const key = keys[this.cursor++ % keys.length];
      let state: HarnessScopeState;
      try {
        state = JSON.parse(await readFile(path.join(root, key, 'state.json'), 'utf8'));
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) continue;
        throw error;
      }
      if ((await harnessDigest(state.scope)) !== key) throw new Error('HARNESS_STORE_CORRUPT');
      const where = (table: typeof agentHarnessHeads | typeof agentHarnessDecisions) =>
        and(eq(table.userId, state.scope.userId), eq(table.agentId, state.scope.agentId));
      const heads = await this.db.select().from(agentHarnessHeads).where(where(agentHarnessHeads));
      const decisions = await this.db
        .select()
        .from(agentHarnessDecisions)
        .where(where(agentHarnessDecisions));
      const protectedIds = new Set<string>();
      for (const head of heads)
        for (const ref of [head.activeRevisionId, head.sourceRevisionId])
          if (ref) protectedIds.add(ref);
      // Publication proofs and user decisions are never subject to this scratch-history TTL.
      for (const decision of decisions) {
        const proof = decision.proof as any;
        for (const ref of [proof?.experiment?.id, proof?.baseline?.id, proof?.candidate?.id])
          if (ref) protectedIds.add(ref);
      }
      try {
        await new FileHarnessStore(root).transaction(state.scope, async (fresh, save) => {
          if (
            pruneHarnessHistory(
              fresh,
              protectedIds,
              Date.now(),
              Number(process.env.QINGZHOU_HARNESS_RETENTION_DAYS || 90),
            )
          )
            await save();
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !['HARNESS_BUSY', 'LEARNING_ACCOUNT_DELETING'].includes(error.message)
        )
          throw error;
      }
    }
  }
}
