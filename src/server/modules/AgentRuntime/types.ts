import type { ToolExecuteData } from '@lobechat/agent-gateway-client';
import { type AgentState } from '@lobechat/agent-runtime';

import { type AgentOperationMetadata, type StepResult } from './AgentStateManager';
import { type StreamChunkData, type StreamEvent } from './StreamEventManager';

/** Opaque per-acquisition ownership; never reconstruct or reuse after release. */
export interface StepLease {
  readonly operationId: string;
  readonly ownerToken: string;
  readonly stepIndex: number;
}

/**
 * Agent State Manager Interface
 * Abstract interface for state persistence, supports Redis and in-memory implementations
 */
export interface IAgentStateManager {
  /** null means contention; backend failures reject (fail closed). */
  acquireStepLease: (
    operationId: string,
    stepIndex: number,
    ttlSeconds?: number,
  ) => Promise<StepLease | null>;

  /**
   * Clean up expired operation data
   */
  cleanupExpiredOperations: () => Promise<number>;

  /**
   * Create new operation metadata
   */
  createOperationMetadata: (
    operationId: string,
    data: {
      agentConfig?: any;
      modelRuntimeConfig?: any;
      userId?: string;
    },
  ) => Promise<void>;

  /**
   * Delete all data for Agent operation
   */
  deleteAgentOperation: (operationId: string) => Promise<void>;

  /**
   * Close connections
   */
  disconnect: () => Promise<void>;

  /**
   * Get all active operations
   */
  getActiveOperations: () => Promise<string[]>;

  /**
   * Get execution history
   */
  getExecutionHistory: (operationId: string, limit?: number) => Promise<any[]>;

  /**
   * Get operation metadata
   */
  getOperationMetadata: (operationId: string) => Promise<AgentOperationMetadata | null>;

  /**
   * Get statistics
   */
  getStats: () => Promise<{
    activeOperations: number;
    completedOperations: number;
    errorOperations: number;
    totalOperations: number;
  }>;

  /**
   * Load Agent state
   */
  loadAgentState: (operationId: string) => Promise<AgentState | null>;

  releaseStepLease: (lease: StepLease) => Promise<boolean>;
  /** false means ownership expired or changed; backend failures reject. */
  renewStepLease: (lease: StepLease, ttlSeconds?: number) => Promise<boolean>;

  /**
   * Save Agent state
   */
  saveAgentState: (operationId: string, state: AgentState) => Promise<void>;

  /** Atomic ownership check and state/metadata commit; false means lease lost. */
  saveAgentStateWithLease: (
    operationId: string,
    state: AgentState,
    lease: StepLease,
  ) => Promise<boolean>;

  /**
   * Save step execution result
   */
  saveStepResult: (operationId: string, stepResult: StepResult) => Promise<void>;

  /** Also fences step history and events; does not fence external side effects. */
  saveStepResultWithLease: (
    operationId: string,
    stepResult: StepResult,
    lease: StepLease,
  ) => Promise<boolean>;
}

/**
 * Stream Event Manager Interface
 * Abstract interface for stream event publishing, supports Redis and in-memory implementations
 */
export interface IStreamEventManager {
  /**
   * Clean up stream data for operation
   */
  cleanupOperation: (operationId: string) => Promise<void>;

  /**
   * Close connections
   */
  disconnect: () => Promise<void>;

  /**
   * Get count of active operations
   */
  getActiveOperationsCount: () => Promise<number>;

  /**
   * Get stream event history
   */
  getStreamHistory: (operationId: string, count?: number) => Promise<StreamEvent[]>;

  /**
   * Publish Agent runtime end event
   */
  publishAgentRuntimeEnd: (
    operationId: string,
    stepIndex: number,
    finalState: any,
    reason?: string,
    reasonDetail?: string,
  ) => Promise<string>;

  /**
   * Publish Agent runtime initialization event
   */
  publishAgentRuntimeInit: (operationId: string, initialState: any) => Promise<string>;

  /**
   * Publish stream content chunk
   */
  publishStreamChunk: (
    operationId: string,
    stepIndex: number,
    chunkData: StreamChunkData,
  ) => Promise<string>;

  /**
   * Publish stream event
   */
  publishStreamEvent: (
    operationId: string,
    event: Omit<StreamEvent, 'operationId' | 'timestamp'>,
  ) => Promise<string>;

  /**
   * Optional: dispatch a tool execution request to the client via Agent Gateway.
   * Rejects if the gateway is unavailable — callers decide their fallback path.
   * Only present on implementations that speak to a live gateway (not on the
   * in-memory / Redis-only managers).
   */
  sendToolExecute?: (operationId: string, data: ToolExecuteData) => Promise<void>;

  /**
   * Subscribe to stream events (for SSE endpoint)
   */
  subscribeStreamEvents: (
    operationId: string,
    lastEventId: string,
    onEvents: (events: StreamEvent[]) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
}
