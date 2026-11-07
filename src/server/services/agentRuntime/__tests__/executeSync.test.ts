import { type AgentRuntimeContext } from '@lobechat/agent-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  InMemoryAgentStateManager,
  InMemoryStreamEventManager,
} from '@/server/modules/AgentRuntime';
import { applyHarnessPatch } from '@/server/runtime/improvement/coordinator';
import * as harnessProduction from '@/server/runtime/improvement/production';

import { AgentRuntimeService } from '../AgentRuntimeService';
import { captureOperationHarness } from '../harness';
import type { OperationCreationParams } from '../types';

// Mock database models
vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    query: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
  })),
}));

// Mock ModelRuntime
vi.mock('@/server/modules/ModelRuntime', () => ({
  initializeRuntimeOptions: vi.fn(),
  initModelRuntimeFromDB: vi.fn().mockResolvedValue({
    chat: vi.fn(),
  }),
  ApiKeyManager: vi.fn().mockImplementation(() => ({
    getApiKey: vi.fn(),
    getAllApiKeys: vi.fn(),
  })),
}));

// Mock search service
vi.mock('@/server/services/search', () => ({
  searchService: {
    search: vi.fn(),
  },
}));

// Mock MCP service
vi.mock('@/server/services/mcp', () => ({
  mcpService: {
    executeCommand: vi.fn(),
  },
}));

// Mock tool execution service
vi.mock('@/server/services/toolExecution', () => ({
  ToolExecutionService: vi.fn().mockImplementation(() => ({
    executeToolCall: vi.fn().mockResolvedValue({ result: 'success' }),
  })),
}));

vi.mock('@/server/services/toolExecution/builtin', () => ({
  BuiltinToolsExecutor: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
  })),
}));

describe('AgentRuntimeService.executeSync', () => {
  let service: AgentRuntimeService;
  let stateManager: InMemoryAgentStateManager;
  let streamEventManager: InMemoryStreamEventManager;

  const mockDb = {} as any;
  const userId = 'test-user-id';

  beforeEach(() => {
    vi.clearAllMocks();

    // Create in-memory managers
    stateManager = new InMemoryAgentStateManager();
    streamEventManager = new InMemoryStreamEventManager();

    // Create service with in-memory implementations and no queue
    service = new AgentRuntimeService(mockDb, userId, {
      coordinatorOptions: {
        stateManager,
        streamEventManager,
      },
      queueService: null, // Disable queue for sync execution
      streamEventManager,
    });
  });

  describe('createOperation with queueService disabled', () => {
    it('persists v2 operation bindings and restores adopted instructions with host/task constraints', async () => {
      const params: OperationCreationParams = {
        agentConfig: { model: 'model', provider: 'provider', systemRole: 'Author\n\nHost\n\nTask' },
        agentDocuments: [],
        appContext: { agentId: 'agent', scope: 'page' },
        autoStart: false,
        harnessSource: {
          agentConfig: { model: 'model', provider: 'provider', systemRole: 'Author' },
          promptSegments: [
            { kind: 'author', content: 'Author' },
            { kind: 'host', content: 'Host' },
            { kind: 'task', content: 'Task' },
          ],
        },
        initialContext: { phase: 'user_input' } as AgentRuntimeContext,
        modelRuntimeConfig: { model: 'model', provider: 'provider' },
        operationId: 'v2-operation',
        operationSkillSet: { skills: [], enabledPluginIds: [] },
        toolSet: { manifestMap: {}, tools: [] },
        userId,
      };
      const baseline = await captureOperationHarness(params);
      const candidate = await applyHarnessPatch(baseline.revision, {
        baseRevisionId: baseline.revision.id,
        surface: 'chat.systemRole',
        value: 'Adopted author instructions',
      });
      const resolve = vi.spyOn(harnessProduction, 'selectActiveHarness').mockResolvedValue({
        revision: candidate,
        publicationRef: { generation: 1, decisionId: 'confirmation' },
      });
      try {
        await service.createOperation(params);
        const state = await stateManager.loadAgentState(params.operationId);
        expect(state?.metadata?.agentConfig.systemRole).toBe(
          'Adopted author instructions\n\nHost\n\nTask',
        );
        expect(state?.metadata?.harnessRevisionId).toBe(candidate.id);
        expect(state?.metadata?.harnessSnapshotId).toBe(state?.metadata?.harness.snapshot.id);
        expect(state?.metadata?.harness.snapshot.material.publicationRef).toEqual({
          generation: 1,
          decisionId: 'confirmation',
        });
        expect(state?.metadata?.harness.snapshot.material.sourceRevisionId).toBe(
          baseline.revision.id,
        );
        expect(
          (await stateManager.getOperationMetadata(params.operationId))?.harnessBinding,
        ).toMatchObject({
          schemaVersion: 2,
          revisionId: candidate.id,
          snapshotId: state?.metadata?.harnessSnapshotId,
        });
      } finally {
        resolve.mockRestore();
      }
    });

    it('rejects non-serializable configuration before recording a running operation', async () => {
      const recordStart = vi.spyOn((service as any).completionLifecycle, 'recordStart');
      await expect(
        service.createOperation({
          agentConfig: { model: 'model', unsupported: new Map() },
          appContext: { agentId: 'agent' },
          initialContext: { phase: 'user_input' } as AgentRuntimeContext,
          operationId: 'invalid-config',
          toolSet: { manifestMap: {} },
          userId,
        }),
      ).rejects.toThrow('HARNESS_NON_SERIALIZABLE');
      expect(recordStart).not.toHaveBeenCalled();
      expect(await stateManager.loadAgentState('invalid-config')).toBeNull();
    });
    it('should create operation without scheduling queue message', async () => {
      const operationId = 'test-op-1';
      const initialContext: AgentRuntimeContext = {
        payload: { message: [{ content: 'Hello' }] },
        phase: 'user_input',
        session: {
          messageCount: 1,
          sessionId: operationId,
          status: 'idle',
          stepCount: 0,
        },
      };

      const result = await service.createOperation({
        agentConfig: { model: 'gpt-4o', provider: 'openai' },
        appContext: { agentId: 'test-agent' },
        autoStart: true, // Would normally trigger queue, but queue is disabled
        initialContext,
        initialMessages: [{ role: 'user', content: 'Hello' }],
        modelRuntimeConfig: { model: 'gpt-4o', provider: 'openai' },
        operationId,
        toolSet: { manifestMap: {}, tools: [] },
        userId,
      });

      expect(result.success).toBe(true);
      expect(result.operationId).toBe(operationId);
      // autoStarted should be false because queue is disabled
      expect(result.autoStarted).toBe(false);
      expect(result.messageId).toBeUndefined();

      // State should be saved
      const state = await stateManager.loadAgentState(operationId);
      expect(state).not.toBeNull();
      expect(state?.operationId).toBe(operationId);
      expect(state?.metadata?.harness?.binding).toMatchObject({
        operationId,
        source: 'server',
        scope: { userId, agentId: 'test-agent' },
      });
      const metadata = await stateManager.getOperationMetadata(operationId);
      expect(metadata?.harnessBinding).toEqual(state?.metadata?.harness?.binding);
    });

    it('should save initial state correctly', async () => {
      const operationId = 'test-op-2';
      const initialContext: AgentRuntimeContext = {
        payload: {},
        phase: 'user_input',
        session: {
          messageCount: 2,
          sessionId: operationId,
          status: 'idle',
          stepCount: 0,
        },
      };

      await service.createOperation({
        agentConfig: { systemRole: 'You are a helpful assistant' },
        appContext: { agentId: 'test-agent', topicId: 'topic-1' },
        autoStart: false,
        initialContext,
        initialMessages: [
          { role: 'system', content: 'You are a helpful assistant' },
          { role: 'user', content: 'Hello' },
        ],
        modelRuntimeConfig: { model: 'gpt-4o', provider: 'openai' },
        operationId,
        toolSet: { manifestMap: {}, tools: [] },
        userId,
      });

      const state = await stateManager.loadAgentState(operationId);
      expect(state).not.toBeNull();
      expect(state?.messages).toHaveLength(2);
      expect(state?.metadata?.agentId).toBe('test-agent');
      expect(state?.metadata?.topicId).toBe('topic-1');
    });
  });

  describe('getCoordinator', () => {
    it('should return the coordinator instance', () => {
      const coordinator = service.getCoordinator();
      expect(coordinator).toBeDefined();
    });
  });

  describe('InMemoryAgentStateManager', () => {
    it('should save and load state correctly', async () => {
      const operationId = 'state-test-1';
      const state = {
        createdAt: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        messages: [{ role: 'user', content: 'Hello' }],
        operationId,
        status: 'idle' as const,
        stepCount: 0,
      };

      await stateManager.createOperationMetadata(operationId, { userId });
      await stateManager.saveAgentState(operationId, state as any);

      const loaded = await stateManager.loadAgentState(operationId);
      expect(loaded).toEqual(state);
    });

    it('should return null for non-existent operation', async () => {
      const loaded = await stateManager.loadAgentState('non-existent');
      expect(loaded).toBeNull();
    });

    it('should track active operations', async () => {
      await stateManager.saveAgentState('op-1', { status: 'idle' } as any);
      await stateManager.saveAgentState('op-2', { status: 'running' } as any);

      const activeOps = await stateManager.getActiveOperations();
      expect(activeOps).toContain('op-1');
      expect(activeOps).toContain('op-2');
      expect(activeOps).toHaveLength(2);
    });

    it('should delete operation correctly', async () => {
      const operationId = 'delete-test';
      await stateManager.createOperationMetadata(operationId, {});
      await stateManager.saveAgentState(operationId, { status: 'idle' } as any);

      await stateManager.deleteAgentOperation(operationId);

      const loaded = await stateManager.loadAgentState(operationId);
      expect(loaded).toBeNull();

      const metadata = await stateManager.getOperationMetadata(operationId);
      expect(metadata).toBeNull();
    });

    it('should clear all data', () => {
      stateManager.clear();
      // After clear, getActiveOperations should return empty array
      expect(stateManager.getActiveOperations()).resolves.toEqual([]);
    });
  });

  describe('InMemoryStreamEventManager', () => {
    it('should publish and retrieve events', async () => {
      const operationId = 'stream-test-1';

      await streamEventManager.publishAgentRuntimeInit(operationId, { status: 'idle' });
      await streamEventManager.publishStreamChunk(operationId, 0, {
        chunkType: 'text',
        content: 'Hello',
      });

      const events = await streamEventManager.getStreamHistory(operationId);
      expect(events).toHaveLength(2);
    });

    it('should support event subscription', async () => {
      const operationId = 'subscribe-test';
      const receivedEvents: any[] = [];

      const unsubscribe = streamEventManager.subscribe(operationId, (events) => {
        receivedEvents.push(...events);
      });

      await streamEventManager.publishStreamChunk(operationId, 0, {
        chunkType: 'text',
        content: 'Test',
      });

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0].type).toBe('stream_chunk');

      unsubscribe();
    });

    it('should wait for specific event type', async () => {
      const operationId = 'wait-test';

      // Publish event after a small delay
      setTimeout(async () => {
        await streamEventManager.publishAgentRuntimeEnd(operationId, 1, { status: 'done' });
      }, 10);

      const event = await streamEventManager.waitForEvent(operationId, 'agent_runtime_end', 1000);

      expect(event.type).toBe('agent_runtime_end');
    });

    it('should clear all data', () => {
      streamEventManager.clear();
      // getAllEvents should return empty after clear
      expect(streamEventManager.getAllEvents('any')).toEqual([]);
    });
  });
});
