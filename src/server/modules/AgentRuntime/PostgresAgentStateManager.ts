import type { AgentState } from '@lobechat/agent-runtime';
import { eq, sql } from 'drizzle-orm';

import { agentRuntimeCheckpoints } from '@/database/schemas/agentRuntime';
import type { LobeChatDatabase } from '@/database/type';
import { NativeAgentStore } from '@/server/runtime/tasks/store';

import type { AgentOperationMetadata, StepResult } from './AgentStateManager';
import { withStepLeaseTimeout } from './stepLease';
import type { IAgentStateManager } from './types';

/** Adapter for the existing Agent/Cordis execution protocol. No alternative agent loop. */
export class PostgresAgentStateManager implements IAgentStateManager {
  readonly store: NativeAgentStore;
  constructor(database: LobeChatDatabase | (() => Promise<LobeChatDatabase>)) {
    this.store = new NativeAgentStore(database);
  }
  acquireStepLease: IAgentStateManager['acquireStepLease'] = (...args) =>
    withStepLeaseTimeout('acquire', () => this.store.acquireStep(...args));
  renewStepLease: IAgentStateManager['renewStepLease'] = (...args) =>
    withStepLeaseTimeout('renew', () => this.store.renewStep(...args));
  releaseStepLease: IAgentStateManager['releaseStepLease'] = (...args) =>
    withStepLeaseTimeout('release', () => this.store.releaseStep(...args));
  createOperationMetadata: IAgentStateManager['createOperationMetadata'] = (id, data) =>
    this.store.create(id, data);
  async loadAgentState(id: string) {
    return ((await this.store.checkpoint(id))?.state as AgentState | null) ?? null;
  }
  async getOperationMetadata(id: string) {
    return ((await this.store.checkpoint(id))?.metadata as AgentOperationMetadata | null) ?? null;
  }
  async saveAgentState(id: string, state: AgentState) {
    await this.store.save(id, state);
  }
  async saveStepResult(id: string, result: StepResult) {
    await this.store.save(id, result.newState, undefined, result);
  }
  saveAgentStateWithLease: IAgentStateManager['saveAgentStateWithLease'] = (id, state, lease) =>
    withStepLeaseTimeout('commit', () => this.store.save(id, state, lease));
  saveStepResultWithLease: IAgentStateManager['saveStepResultWithLease'] = (id, result, lease) =>
    withStepLeaseTimeout('commit', () => this.store.save(id, result.newState, lease, result));
  async getExecutionHistory(id: string, limit = 20) {
    return (
      (await this.store.checkpoint(id))?.history.slice(0, Math.max(0, Math.min(200, limit))) ?? []
    );
  }
  async deleteAgentOperation(id: string) {
    await (
      await this.store.db()
    )
      .delete(agentRuntimeCheckpoints)
      .where(eq(agentRuntimeCheckpoints.id, id));
  }
  async getActiveOperations() {
    return (
      await (
        await this.store.db()
      )
        .select({ id: agentRuntimeCheckpoints.id })
        .from(agentRuntimeCheckpoints)
        .where(
          sql`${agentRuntimeCheckpoints.metadata}->>'status' IN ('idle', 'running', 'waiting_for_human')`,
        )
    ).map((row) => row.id);
  }
  async getStats() {
    const rows = await (
      await this.store.db()
    )
      .select({
        status: sql<string>`${agentRuntimeCheckpoints.metadata}->>'status'`,
        count: sql<number>`count(*)::int`,
      })
      .from(agentRuntimeCheckpoints)
      .groupBy(sql`${agentRuntimeCheckpoints.metadata}->>'status'`);
    const count = (statuses: string[]) =>
      rows.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row.count, 0);
    return {
      activeOperations: count(['idle', 'running', 'waiting_for_human']),
      completedOperations: count(['done']),
      errorOperations: count(['error']),
      totalOperations: rows.reduce((sum, row) => sum + row.count, 0),
    };
  }
  // Durable checkpoints have an explicit account/data lifecycle, never the Redis cache TTL.
  async cleanupExpiredOperations() {
    return 0;
  }
  async disconnect() {} // Database connection belongs to the application, not an operation.
}
