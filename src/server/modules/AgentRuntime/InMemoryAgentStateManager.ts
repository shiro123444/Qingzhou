import { type AgentState } from '@lobechat/agent-runtime';
import debug from 'debug';

import { type AgentOperationMetadata, type StepResult } from './AgentStateManager';
import {
  assertStepLeaseOperation,
  createStepLease,
  DEFAULT_STEP_LEASE_TTL_SECONDS,
  stepLeaseTtlMs,
} from './stepLease';
import { type IAgentStateManager, type StepLease } from './types';

const log = debug('lobe-server:agent-runtime:in-memory-state-manager');

/**
 * In-Memory Agent State Manager
 * In-memory implementation for testing and local development environments
 */
export class InMemoryAgentStateManager implements IAgentStateManager {
  private leases = new Map<string, { expiresAt: number; ownerToken: string }>();
  private states: Map<string, AgentState> = new Map();
  private steps: Map<string, any[]> = new Map();
  private metadata: Map<string, AgentOperationMetadata> = new Map();
  private events: Map<string, any[][]> = new Map();

  async saveAgentState(operationId: string, state: AgentState): Promise<void> {
    // Deep clone to avoid reference issues
    this.states.set(operationId, structuredClone(state));

    // Update metadata
    const existingMeta = this.metadata.get(operationId);
    if (existingMeta) {
      existingMeta.lastActiveAt = new Date().toISOString();
      existingMeta.status = state.status;
      existingMeta.totalCost = state.cost?.total || 0;
      existingMeta.totalSteps = state.stepCount;
    }

    log('[%s] Saved state for step %d', operationId, state.stepCount);
  }

  async loadAgentState(operationId: string): Promise<AgentState | null> {
    const state = this.states.get(operationId);
    if (!state) {
      return null;
    }

    log('[%s] Loaded state (step %d)', operationId, state.stepCount);
    // Return deep clone to prevent external modifications from affecting internal state
    return structuredClone(state);
  }

  async saveStepResult(operationId: string, stepResult: StepResult): Promise<void> {
    // Save latest state
    // Use JSON round-trip instead of structuredClone to safely handle
    // non-cloneable objects (e.g. DOM ErrorEvent from Neon DB errors)
    this.states.set(operationId, JSON.parse(JSON.stringify(stepResult.newState)));

    // Save step history
    let stepHistory = this.steps.get(operationId);
    if (!stepHistory) {
      stepHistory = [];
      this.steps.set(operationId, stepHistory);
    }

    const stepData = {
      context: stepResult.nextContext,
      cost: stepResult.newState.cost?.total || 0,
      executionTime: stepResult.executionTime,
      status: stepResult.newState.status,
      stepIndex: stepResult.stepIndex,
      timestamp: Date.now(),
    };

    // Insert at beginning (newest first)
    stepHistory.unshift(stepData);
    // Keep most recent 200 steps
    if (stepHistory.length > 200) {
      stepHistory.length = 200;
    }

    // Save step event sequence
    if (stepResult.events && stepResult.events.length > 0) {
      let eventHistory = this.events.get(operationId);
      if (!eventHistory) {
        eventHistory = [];
        this.events.set(operationId, eventHistory);
      }
      eventHistory.unshift(stepResult.events);
      if (eventHistory.length > 200) {
        eventHistory.length = 200;
      }
    }

    // Update operation metadata
    const existingMeta = this.metadata.get(operationId);
    if (existingMeta) {
      existingMeta.lastActiveAt = new Date().toISOString();
      existingMeta.status = stepResult.newState.status;
      existingMeta.totalCost = stepResult.newState.cost?.total || 0;
      existingMeta.totalSteps = stepResult.newState.stepCount;
    }

    log(
      '[%s:%d] Saved step result with %d events',
      operationId,
      stepResult.stepIndex,
      stepResult.events?.length || 0,
    );
  }

  async getExecutionHistory(operationId: string, limit: number = 50): Promise<any[]> {
    const history = this.steps.get(operationId);
    if (!history) {
      return [];
    }

    // Return reversed array (earliest first)
    return history.slice(0, limit).reverse();
  }

  async getOperationMetadata(operationId: string): Promise<AgentOperationMetadata | null> {
    return this.metadata.get(operationId) ?? null;
  }

  async createOperationMetadata(
    operationId: string,
    data: {
      agentConfig?: any;
      modelRuntimeConfig?: any;
      userId?: string;
    },
  ): Promise<void> {
    const metadata: AgentOperationMetadata = {
      agentConfig: data.agentConfig,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      modelRuntimeConfig: data.modelRuntimeConfig,
      status: 'idle',
      totalCost: 0,
      totalSteps: 0,
      userId: data.userId,
    };

    this.metadata.set(operationId, metadata);
    log('[%s] Created operation metadata', operationId);
  }

  async deleteAgentOperation(operationId: string): Promise<void> {
    this.states.delete(operationId);
    this.steps.delete(operationId);
    this.metadata.delete(operationId);
    this.events.delete(operationId);
    log('Deleted operation %s', operationId);
  }

  async getActiveOperations(): Promise<string[]> {
    return Array.from(this.states.keys());
  }

  async cleanupExpiredOperations(): Promise<number> {
    const activeOperations = await this.getActiveOperations();
    let cleanedCount = 0;

    for (const operationId of activeOperations) {
      const metadata = this.metadata.get(operationId);

      if (metadata) {
        const lastActiveTime = new Date(metadata.lastActiveAt).getTime();
        const now = Date.now();
        const hoursSinceActive = (now - lastActiveTime) / (1000 * 60 * 60);

        // Clean up operations inactive for more than 1 hour
        if (hoursSinceActive > 1) {
          await this.deleteAgentOperation(operationId);
          cleanedCount++;
        }
      }
    }

    log('Cleaned up %d expired operations', cleanedCount);
    return cleanedCount;
  }

  async getStats(): Promise<{
    activeOperations: number;
    completedOperations: number;
    errorOperations: number;
    totalOperations: number;
  }> {
    const operations = await this.getActiveOperations();
    const stats = {
      activeOperations: 0,
      completedOperations: 0,
      errorOperations: 0,
      totalOperations: operations.length,
    };

    for (const operationId of operations) {
      const metadata = this.metadata.get(operationId);

      if (metadata) {
        switch (metadata.status) {
          case 'running':
          case 'waiting_for_human': {
            stats.activeOperations++;
            break;
          }
          case 'done': {
            stats.completedOperations++;
            break;
          }
          case 'error':
          case 'interrupted': {
            stats.errorOperations++;
            break;
          }
        }
      }
    }

    return stats;
  }

  private leaseKey(operationId: string, stepIndex: number): string {
    return JSON.stringify([operationId, stepIndex]);
  }

  private ownsLease(lease: StepLease): boolean {
    const key = this.leaseKey(lease.operationId, lease.stepIndex);
    const current = this.leases.get(key);
    if (current && current.expiresAt <= Date.now()) {
      this.leases.delete(key);
      return false;
    }
    return current?.ownerToken === lease.ownerToken;
  }

  async acquireStepLease(
    operationId: string,
    stepIndex: number,
    ttlSeconds: number = DEFAULT_STEP_LEASE_TTL_SECONDS,
  ): Promise<StepLease | null> {
    const ttlMs = stepLeaseTtlMs(ttlSeconds);
    const key = this.leaseKey(operationId, stepIndex);
    const current = this.leases.get(key);
    if (current && current.expiresAt > Date.now()) return null;
    const lease = createStepLease(operationId, stepIndex);
    this.leases.set(key, { expiresAt: Date.now() + ttlMs, ownerToken: lease.ownerToken });
    return lease;
  }

  async renewStepLease(
    lease: StepLease,
    ttlSeconds: number = DEFAULT_STEP_LEASE_TTL_SECONDS,
  ): Promise<boolean> {
    const ttlMs = stepLeaseTtlMs(ttlSeconds);
    if (!this.ownsLease(lease)) return false;
    this.leases.set(this.leaseKey(lease.operationId, lease.stepIndex), {
      expiresAt: Date.now() + ttlMs,
      ownerToken: lease.ownerToken,
    });
    return true;
  }

  async releaseStepLease(lease: StepLease): Promise<boolean> {
    if (!this.ownsLease(lease)) return false;
    this.leases.delete(this.leaseKey(lease.operationId, lease.stepIndex));
    return true;
  }

  private canCommitWithLease(
    operationId: string,
    state: AgentState,
    lease: StepLease,
    isStepResult: boolean,
  ): boolean {
    if (!this.ownsLease(lease)) return false;
    const previous = this.states.get(operationId);
    if (!previous) return true;
    return (
      Number.isFinite(previous.stepCount) &&
      Number.isFinite(state.stepCount) &&
      state.stepCount >= previous.stepCount &&
      previous.stepCount <= lease.stepIndex + 1 &&
      (!isStepResult || previous.stepCount === lease.stepIndex)
    );
  }

  async saveAgentStateWithLease(
    operationId: string,
    state: AgentState,
    lease: StepLease,
  ): Promise<boolean> {
    assertStepLeaseOperation(operationId, lease);
    if (!this.canCommitWithLease(operationId, state, lease, false)) return false;
    // saveAgentState performs every mutation synchronously before returning its promise.
    await this.saveAgentState(operationId, state);
    return true;
  }

  async saveStepResultWithLease(
    operationId: string,
    stepResult: StepResult,
    lease: StepLease,
  ): Promise<boolean> {
    assertStepLeaseOperation(operationId, lease);
    if (stepResult.stepIndex !== lease.stepIndex) throw new TypeError('Step lease index mismatch');
    if (!this.canCommitWithLease(operationId, stepResult.newState, lease, true)) return false;
    // No await between ownership validation and state/metadata/history mutations.
    await this.saveStepResult(operationId, stepResult);
    return true;
  }

  async disconnect(): Promise<void> {
    // In-memory implementation doesn't need to disconnect
    log('InMemoryAgentStateManager disconnected');
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this.leases.clear();
    this.states.clear();
    this.steps.clear();
    this.metadata.clear();
    this.events.clear();
    log('All data cleared');
  }

  /**
   * Get event history (for test verification)
   */
  getEventHistory(operationId: string): any[][] {
    return this.events.get(operationId) ?? [];
  }
}

/**
 * Singleton instance for testing and local development environments
 */
export const inMemoryAgentStateManager = new InMemoryAgentStateManager();
