import type {
  Agent,
  AgentRuntimeContext,
  AgentState,
  GeneralAgentConfig,
} from '@lobechat/agent-runtime';
import { AgentRuntime, findInMessages, GeneralChatAgent } from '@lobechat/agent-runtime';
import type { ISnapshotStore } from '@lobechat/agent-tracing';
import { dynamicInterventionAudits } from '@lobechat/builtin-tools/dynamicInterventionAudits';
import { getModelPropertyWithFallback } from '@lobechat/model-runtime';
import { AgentRuntimeErrorType, ChatErrorType, type ChatMessageError } from '@lobechat/types';
import debug from 'debug';
import urlJoin from 'url-join';

import { MessageModel } from '@/database/models/message';
import { type LobeChatDatabase } from '@/database/type';
import { appEnv } from '@/envs/app';
import { type AgentRuntimeCoordinatorOptions } from '@/server/modules/AgentRuntime';
import { AgentRuntimeCoordinator, createStreamEventManager } from '@/server/modules/AgentRuntime';
import { type RuntimeExecutorContext } from '@/server/modules/AgentRuntime/RuntimeExecutors';
import { createRuntimeExecutors } from '@/server/modules/AgentRuntime/RuntimeExecutors';
import {
  startStepLeaseRenewal,
  StepLeaseBackendError,
  StepLeaseLostError,
} from '@/server/modules/AgentRuntime/stepLease';
import { type IStreamEventManager } from '@/server/modules/AgentRuntime/types';
import { emitAgentSignalSourceEvent } from '@/server/services/agentSignal';
import { toAgentSignalTraceEvents } from '@/server/services/agentSignal/observability/traceEvents';
import { mcpService } from '@/server/services/mcp';
import { QueueService } from '@/server/services/queue';
import { LocalQueueServiceImpl } from '@/server/services/queue/impls';
import { type QueueMessage } from '@/server/services/queue/types';
import { ToolExecutionService } from '@/server/services/toolExecution';
import { BuiltinToolsExecutor } from '@/server/services/toolExecution/builtin';

import { isAbortError, throwIfAborted } from './abort';
import { CompletionLifecycle } from './CompletionLifecycle';
import { hookDispatcher } from './hooks';
import type { HookDispatchFailure } from './hooks/HookDispatcher';
import { collectBotCallbackIntents } from './hooks/payload';
import { HumanInterventionHandler } from './HumanInterventionHandler';
import { OperationTraceRecorder } from './OperationTraceRecorder';
import { buildStepPresentation, formatTokenCount } from './stepPresentation';
import {
  type AgentExecutionParams,
  type AgentExecutionResult,
  type OperationCreationParams,
  type OperationCreationResult,
  type OperationStatusResult,
  type PendingInterventionsResult,
  type StartExecutionParams,
  type StartExecutionResult,
  type StepCompletionReason,
} from './types';

if (process.env.VERCEL) {
  // eslint-disable-next-line no-console
  debug.log = console.log.bind(console);
}

const log = debug('lobe-server:agent-runtime-service');

/**
 * Formats an error into ChatMessageError structure
 * Handles various error formats from LLM execution and other sources
 */
function formatErrorForState(error: unknown): ChatMessageError {
  // Handle ChatCompletionErrorPayload format from LLM errors
  // e.g., { errorType: 'InvalidProviderAPIKey', error: { ... }, provider: 'openai' }
  if (error && typeof error === 'object' && 'errorType' in error) {
    const payload = error as {
      error?: unknown;
      errorType: ChatMessageError['type'];
      message?: string;
    };
    return {
      body: payload.error || error,
      message: payload.message || String(payload.errorType),
      type: payload.errorType,
    };
  }

  // Handle standard Error objects
  if (error instanceof Error) {
    return {
      body: { name: error.name },
      message: error.message,
      type: ChatErrorType.InternalServerError,
    };
  }

  // Fallback for unknown error types
  return {
    body: error,
    message: String(error),
    type: AgentRuntimeErrorType.AgentRuntimeError,
  };
}

const toAgentSignalSnapshotEvents = (
  emission: Awaited<ReturnType<typeof emitAgentSignalSourceEvent>> | undefined,
) => {
  if (!emission || emission.deduped) return [];

  return toAgentSignalTraceEvents({
    actions: emission.orchestration.actions,
    results: emission.orchestration.results,
    signals: emission.orchestration.emittedSignals,
    source: emission.source,
  });
};

export interface AgentRuntimeServiceOptions {
  /**
   * Custom agent factory. When provided, this function is called instead of
   * the default `new GeneralChatAgent(config)` to create the Agent instance.
   * This allows injecting alternative Agent implementations (e.g. GraphAgent)
   * without the service needing to know about them.
   */
  agentFactory?: (config: GeneralAgentConfig) => Agent;
  /**
   * Coordinator configuration options
   * Allows injection of custom stateManager and streamEventManager
   */
  coordinatorOptions?: AgentRuntimeCoordinatorOptions;
  /**
   * Custom QueueService
   * Set to null to disable queue scheduling (for synchronous execution tests)
   */
  queueService?: QueueService | null;
  /**
   * Optional snapshot store for persisting agent execution traces.
   * When provided, execution snapshots are recorded on every step and finalized on completion.
   * In dev mode without this option, falls back to FileSnapshotStore automatically.
   */
  snapshotStore?: ISnapshotStore;
  /**
   * Custom StreamEventManager
   * Defaults to Redis-based StreamEventManager
   * Can pass InMemoryStreamEventManager in test environments
   */
  streamEventManager?: IStreamEventManager;
}

/**
 * Agent Runtime Service
 * Encapsulates Agent execution logic and provides a unified service interface
 *
 * Supports dependency injection for testing with in-memory implementations:
 * ```ts
 * // Production environment (uses Redis by default)
 * const service = new AgentRuntimeService(db, userId);
 *
 * // Test environment
 * const service = new AgentRuntimeService(db, userId, {
 *   streamEventManager: new InMemoryStreamEventManager(),
 *   queueService: null, // Disable queue, use executeSync
 * });
 * ```
 */
export class AgentRuntimeService {
  private agentFactory?: (config: GeneralAgentConfig) => Agent;
  private completionLifecycle: CompletionLifecycle;
  private coordinator: AgentRuntimeCoordinator;
  private humanIntervention: HumanInterventionHandler;
  private streamManager: IStreamEventManager;
  private queueService: QueueService | null;
  private traceRecorder: OperationTraceRecorder;
  private toolExecutionService: ToolExecutionService;
  private get baseURL() {
    const baseUrl = process.env.AGENT_RUNTIME_BASE_URL || appEnv.APP_URL || 'http://localhost:3010';

    return urlJoin(baseUrl, '/api/agent');
  }
  private serverDB: LobeChatDatabase;
  private userId: string;
  private messageModel: MessageModel;

  constructor(db: LobeChatDatabase, userId: string, options?: AgentRuntimeServiceOptions) {
    // Use factory function to auto-select Redis or InMemory implementation
    this.streamManager =
      options?.streamEventManager ??
      options?.coordinatorOptions?.streamEventManager ??
      createStreamEventManager();
    this.coordinator = new AgentRuntimeCoordinator({
      ...options?.coordinatorOptions,
      streamEventManager: this.streamManager,
    });
    this.queueService =
      options?.queueService === null ? null : (options?.queueService ?? new QueueService());
    this.traceRecorder = new OperationTraceRecorder(
      options?.snapshotStore ?? this.createDefaultSnapshotStore(),
    );
    this.agentFactory = options?.agentFactory;
    this.serverDB = db;
    this.userId = userId;
    this.messageModel = new MessageModel(db, this.userId);
    this.completionLifecycle = new CompletionLifecycle(db, userId);
    this.humanIntervention = new HumanInterventionHandler(db, this.messageModel);

    // Initialize ToolExecutionService with dependencies
    const builtinToolsExecutor = new BuiltinToolsExecutor(db, userId);

    this.toolExecutionService = new ToolExecutionService({
      builtinToolsExecutor,
      mcpService,
    });

    // Setup local execution callback for LocalQueueServiceImpl
    this.setupLocalExecutionCallback();
  }

  /**
   * Setup execution callback for LocalQueueServiceImpl
   * This breaks the circular dependency by using callback injection
   */
  private setupLocalExecutionCallback(): void {
    if (!this.queueService) return;

    const impl = this.queueService.getImpl();
    if (impl instanceof LocalQueueServiceImpl) {
      log('Setting up local execution callback');
      impl.setExecutionCallback(async (operationId, stepIndex, context, payload) => {
        await this.executeStep({ ...payload, context, operationId, stepIndex });
      });
    }
  }

  // ==================== Operation Interruption ====================

  /**
   * Interrupt a running agent operation by setting its state to 'interrupted'.
   * The agent will stop at the next step boundary (cannot abort an in-flight LLM call).
   * Works with both Redis and InMemory state managers via the coordinator abstraction.
   *
   * @returns true if the operation was interrupted, false if already in a terminal state or not found
   */
  async interruptOperation(operationId: string): Promise<boolean> {
    const state = await this.coordinator.loadAgentState(operationId);
    if (!state) return false;

    if (state.status === 'done' || state.status === 'error' || state.status === 'interrupted') {
      return false;
    }

    await this.coordinator.saveAgentState(operationId, {
      ...state,
      lastModified: new Date().toISOString(),
      status: 'interrupted',
    });

    log('[%s] Operation interrupted', operationId);
    return true;
  }

  // ==================== Operation Management ====================

  /**
   * Create a new Agent operation
   */
  async createOperation(params: OperationCreationParams): Promise<OperationCreationResult> {
    const {
      activeDeviceId,
      operationId,
      initialContext,
      agentConfig,
      modelRuntimeConfig,
      userId,
      autoStart = true,
      stream,
      initialMessages = [],
      appContext,
      toolSet,
      hooks,
      userInterventionConfig,
      queueRetries,
      queueRetryDelay,
      botContext,
      botPlatformContext,
      deviceAccessPolicy,
      discordContext,
      evalContext,
      maxSteps,
      userMemory,
      deviceSystemInfo,
      operationSkillSet,
      parentOperationId,
      signal,
      userTimezone,
      initialStepCount = 0,
    } = params;

    // Persist initial agent_operations row. CompletionLifecycle owns both
    // ends of the persistence lifecycle (start row here, terminal update
    // in dispatchHooks) and swallows DB errors so runtime startup is never
    // blocked.
    await this.completionLifecycle.recordStart({
      agentId: appContext?.agentId ?? null,
      appContext: {
        defaultTaskAssigneeAgentId: appContext?.defaultTaskAssigneeAgentId,
        documentId: appContext?.documentId,
        groupId: appContext?.groupId,
        scope: appContext?.scope,
        sourceMessageId: appContext?.sourceMessageId,
      },
      chatGroupId: appContext?.groupId ?? null,
      maxSteps,
      model: modelRuntimeConfig?.model,
      modelRuntimeConfig,
      operationId,
      parentOperationId: parentOperationId ?? null,
      provider: modelRuntimeConfig?.provider,
      taskId: appContext?.taskId ?? null,
      threadId: appContext?.threadId ?? null,
      topicId: appContext?.topicId ?? null,
      trigger: appContext?.trigger,
    });

    const operationToolSet = toolSet;
    let operationCreated = false;
    let hooksRegistered = false;

    try {
      throwIfAborted(signal, 'Agent execution aborted before operation startup');

      const memories = userMemory?.memories;
      log(
        '[%s] Creating new operation (autoStart: %s) with params: model=%s, provider=%s, tools=%d, messages=%d, manifests=%d, memory=%s',
        operationId,
        autoStart,
        agentConfig?.model,
        agentConfig?.provider,
        operationToolSet.tools?.length ?? 0,
        initialMessages.length,
        operationToolSet.manifestMap ? Object.keys(operationToolSet.manifestMap).length : 0,
        memories
          ? `{contexts:${memories.contexts?.length ?? 0},experiences:${memories.experiences?.length ?? 0},preferences:${memories.preferences?.length ?? 0},identities:${memories.identities?.length ?? 0},activities:${memories.activities?.length ?? 0},persona:${memories.persona ? 'yes' : 'no'}}`
          : 'none',
      );

      // Initialize operation state - create state before saving
      const initialState = {
        createdAt: new Date().toISOString(),
        // Store initialContext for executeSync to use
        initialContext,
        lastModified: new Date().toISOString(),
        // Use the passed initial messages
        messages: initialMessages,
        metadata: {
          activeDeviceId,
          agentConfig,
          botContext,
          botPlatformContext,
          deviceAccessPolicy,
          deviceSystemInfo,
          discordContext,
          evalContext,
          // need be removed
          modelRuntimeConfig,
          queueRetries,
          queueRetryDelay,
          stream,
          operationSkillSet,
          userId,
          userMemory,
          userTimezone,
          workingDirectory: agentConfig?.chatConfig?.runtimeEnv?.workingDirectory,
          ...appContext,
        },
        maxSteps,
        // modelRuntimeConfig at state level for executor fallback
        modelRuntimeConfig,
        operationId,
        operationToolSet,
        status: 'idle',
        stepCount: initialStepCount,
        // Backward-compat: resolved tool fields read by RuntimeExecutors
        toolExecutorMap: operationToolSet.executorMap,
        toolManifestMap: operationToolSet.manifestMap,
        toolSourceMap: operationToolSet.sourceMap,
        tools: operationToolSet.tools,
        // User intervention config for headless mode in async tasks
        userInterventionConfig,
      } as Partial<AgentState>;

      // Use coordinator to create operation, automatically sends initialization event
      await this.coordinator.createAgentOperation(operationId, {
        agentConfig,
        modelRuntimeConfig,
        userId,
      });
      operationCreated = true;

      // Save initial state
      await this.coordinator.saveAgentState(operationId, initialState as any);

      // Register external hooks
      if (hooks && hooks.length > 0) {
        hookDispatcher.register(operationId, hooks);
        hooksRegistered = true;

        // Persist webhook configs to state metadata for production mode
        const serializedHooks = hookDispatcher.getSerializedHooks(operationId);
        if (serializedHooks && serializedHooks.length > 0) {
          const currentState = await this.coordinator.loadAgentState(operationId);
          if (currentState) {
            await this.coordinator.saveAgentState(operationId, {
              ...currentState,
              metadata: {
                ...currentState.metadata,
                _hooks: serializedHooks,
              },
            });
          }
        }
      }

      throwIfAborted(signal, 'Agent execution aborted before first step scheduling');

      let messageId: string | undefined;
      let autoStarted = false;

      if (autoStart && this.queueService) {
        // Both local and queue modes use scheduleMessage
        // LocalQueueServiceImpl uses setTimeout + callback mechanism
        // QStashQueueServiceImpl schedules HTTP requests
        messageId = await this.queueService.scheduleMessage({
          context: initialContext,
          delay: 50, // Short delay for startup
          endpoint: `${this.baseURL}/run`,
          operationId,
          priority: 'high',
          retryDelay: queueRetryDelay,
          retries: queueRetries,
          stepIndex: initialStepCount,
        });
        autoStarted = true;
        log('[%s] Scheduled first step (messageId: %s)', operationId, messageId);
      }

      if (!autoStarted) {
        log('[%s] Created operation without auto-start', operationId);
      }

      return { autoStarted, messageId, operationId, success: true };
    } catch (error) {
      if (isAbortError(error)) {
        if (hooksRegistered) {
          hookDispatcher.unregister(operationId);
        }

        if (operationCreated) {
          try {
            await this.coordinator.deleteAgentOperation(operationId);
          } catch (cleanupError) {
            console.error('Failed to cleanup aborted operation %s: %O', operationId, cleanupError);
          }
        }

        log('[%s] Operation creation aborted before scheduling', operationId);
        throw error;
      }

      console.error('Failed to create operation %s: %O', operationId, error);
      throw error;
    }
  }

  /**
   * Execute Agent step
   */
  async executeStep(params: AgentExecutionParams): Promise<AgentExecutionResult> {
    const {
      operationId,
      stepIndex,
      context,
      humanInput,
      approvedToolCall,
      rejectionReason,
      rejectAndContinue,
      toolMessageId,
      externalRetryCount = 0,
    } = params;

    // ===== Distributed lock: prevent duplicate execution from QStash retries =====
    const leaseStartedAt = Date.now();
    const lease = await this.coordinator.acquireStepLease(operationId, stepIndex, 35);
    if (!lease) {
      log(
        '[%s][%d] Step lock conflict — another instance is executing this step, returning locked',
        operationId,
        stepIndex,
      );
      return {
        locked: true,
        nextStepScheduled: false,
        state: {},
        success: false,
      };
    }

    const renewal = startStepLeaseRenewal({
      lease,
      renew: (currentLease, ttl) => this.coordinator.renewStepLease(currentLease, ttl),
      startedAt: leaseStartedAt,
    });
    const assertHeld = renewal.assertHeld;
    const hookDeliveryFailures: HookDispatchFailure[] = [];
    // Once committed, notification/queue failures must not rewrite a successful
    // tool result as an execution error or repeat that tool on a queue retry.
    let authoritativeCommitted = false;
    let lastKnownState: AgentState | undefined;

    // Hoisted so the error-path snapshot finalize can record an
    // approximate startedAt for the failing step. The inner `startAt` at the
    // runtime.step() call site stays as the authoritative start for the
    // success path.
    const stepStartAt = Date.now();
    let stepRuntime: AgentRuntime | undefined;

    try {
      assertHeld();
      log('[%s][%d] Start step executing...', operationId, stepIndex);

      // Publish step start event
      await this.streamManager.publishStreamEvent(operationId, {
        data: {},
        stepIndex,
        type: 'step_start',
      });

      // Get operation state and metadata
      const agentState = await this.coordinator.loadAgentState(operationId);
      assertHeld();

      if (!agentState) {
        throw new Error(`Agent state not found for operation ${operationId}`);
      }

      lastKnownState = agentState;
      agentState.metadata = {
        ...agentState.metadata,
        externalRetryCount,
      };

      // Delayed retries resume a committed continuation, never the completed tool.
      if (agentState.stepCount > stepIndex) {
        authoritativeCommitted = true;
        const pending = agentState.metadata?._pendingNextStep as QueueMessage | undefined;
        let nextStepScheduled = false;
        if (
          agentState.status !== 'done' &&
          agentState.status !== 'error' &&
          agentState.status !== 'interrupted' &&
          agentState.status !== 'waiting_for_human' &&
          agentState.stepCount === stepIndex + 1 &&
          pending?.stepIndex === agentState.stepCount &&
          pending.operationId === operationId &&
          this.queueService
        ) {
          await renewal.renewNow();
          await this.queueService.scheduleMessage({ ...pending, endpoint: `${this.baseURL}/run` });
          nextStepScheduled = true;
        } else if (['done', 'error', 'interrupted'].includes(agentState.status)) {
          await renewal.renewNow();
          const result = await this.completionLifecycle.dispatchHooks(
            operationId,
            agentState,
            this.determineCompletionReason(agentState),
            assertHeld,
          );
          hookDeliveryFailures.push(...(result?.failures ?? []));
        }
        return {
          hookDeliveryFailures,
          nextStepScheduled,
          state: agentState,
          stepResult: null,
          success: true,
        };
      }
      // Early exit: skip step if operation is already in a terminal state
      // This prevents executing expensive LLM/tool calls after timeout or interruption
      if (
        agentState.status === 'interrupted' ||
        agentState.status === 'done' ||
        agentState.status === 'error'
      ) {
        authoritativeCommitted = true;
        log(
          '[%s][%d] Skipping step — operation already in terminal state: %s',
          operationId,
          stepIndex,
          agentState.status,
        );

        const reason = this.determineCompletionReason(agentState);

        await this.completionLifecycle.emitSignalEvents(operationId, agentState, reason);

        // Dispatch completion hooks so consumers (e.g., bot local-mode promise) can finalize
        await renewal.renewNow();
        const completionDelivery = await this.completionLifecycle.dispatchHooks(
          operationId,
          agentState,
          reason,
          assertHeld,
        );
        hookDeliveryFailures.push(...(completionDelivery?.failures ?? []));

        return {
          hookDeliveryFailures,
          nextStepScheduled: false,
          state: agentState,
          stepResult: null,
          success: true,
        };
      }

      let beforeStepSignalEvents: Array<{ [key: string]: unknown; type: string }> = [];

      if (agentState.stepCount < stepIndex) {
        return { locked: true, nextStepScheduled: false, state: agentState, success: false };
      }

      // Dispatch beforeStep hooks
      try {
        await renewal.renewNow();
        const beforeStepMetadata = agentState?.metadata || {};
        const beforeStepSignalEmission = await emitAgentSignalSourceEvent(
          {
            payload: {
              agentId: beforeStepMetadata?.agentId,
              operationId,
              serializedContext: undefined,
              stepIndex,
              topicId: beforeStepMetadata?.topicId,
              turnCount: agentState?.stepCount || 0,
            },
            sourceId: `${operationId}:before:${stepIndex}`,
            sourceType: 'runtime.before_step',
          },
          {
            agentId: beforeStepMetadata?.agentId,
            db: this.serverDB,
            userId: beforeStepMetadata?.userId || this.userId,
          },
          { ignoreError: true },
        );
        beforeStepSignalEvents = toAgentSignalSnapshotEvents(beforeStepSignalEmission);
        assertHeld();
        const delivery = await hookDispatcher.dispatch(
          operationId,
          'beforeStep',
          {
            agentId: beforeStepMetadata?.agentId || '',
            finalState: agentState,
            operationId,
            stepIndex,
            steps: agentState?.stepCount || 0,
            userId: beforeStepMetadata?.userId || this.userId,
          },
          beforeStepMetadata._hooks,
          assertHeld,
        );
        hookDeliveryFailures.push(...(delivery?.failures ?? []));
      } catch (hookError) {
        assertHeld();
        log('[%s] beforeStep hook dispatch error: %O', operationId, hookError);
      }

      // Create Agent and Runtime instances
      // Use agentState.metadata which contains the full app context (topicId, agentId, etc.)
      // operationMetadata only contains basic fields (agentConfig, modelRuntimeConfig, userId)
      const { runtime } = await this.createAgentRuntime({
        metadata: agentState?.metadata,
        operationId,
        stepIndex,
        signal: renewal.signal,
        assertStepLease: assertHeld,
      });
      stepRuntime = runtime;
      assertHeld();

      // Handle human intervention
      let currentContext = context;
      let currentState = agentState;

      if (humanInput || approvedToolCall || rejectionReason) {
        await renewal.renewNow();
        const interventionResult = await this.humanIntervention.process(currentState, {
          approvedToolCall,
          humanInput,
          rejectAndContinue,
          rejectionReason,
          toolMessageId,
        });
        currentState = interventionResult.newState;
        currentContext = interventionResult.nextContext;
      }

      // Pre-step computation: extract device context from DB messages
      // Follows front-end computeStepContext pattern — computed at step boundary, not inside executors
      if (!currentState.metadata?.activeDeviceId) {
        const deviceContext = await this.computeDeviceContext(currentState);
        if (deviceContext && currentState.metadata) {
          currentState.metadata.activeDeviceId = deviceContext.activeDeviceId;
          currentState.metadata.devicePlatform = deviceContext.devicePlatform;
          currentState.metadata.deviceSystemInfo = deviceContext.deviceSystemInfo;
          log(
            '[%s][%d] Pre-step: device context computed from messages (deviceId: %s)',
            operationId,
            stepIndex,
            deviceContext.activeDeviceId,
          );
        }
      }

      // Execute step
      await renewal.renewNow();
      const startAt = Date.now();
      const stepResult = await runtime.step(currentState, currentContext);
      assertHeld();

      // Check if the operation was interrupted while the step was executing
      // (e.g., user clicked abort during a long LLM call)
      const latestState = await this.coordinator.loadAgentState(operationId);
      if (latestState?.status === 'interrupted') {
        stepResult.newState.status = 'interrupted';
        stepResult.newState.lastModified = new Date().toISOString();
        log('[%s][%d] Operation was interrupted during step execution', operationId, stepIndex);
      }

      const shouldContinue = this.shouldContinueExecution(
        stepResult.newState,
        stepResult.nextContext,
      );
      const { presentation: stepPresentationData, summary: stepSummary } = buildStepPresentation(
        stepResult,
        Date.now() - startAt,
      );
      const toolsCalling = stepPresentationData.toolsCalling;
      const content = stepPresentationData.content;
      const previousTracking = stepResult.newState.metadata?._stepTracking || {};
      if (
        stepResult.newState.metadata?._hooks?.some(
          (hook: { type: string }) => hook.type === 'afterStep',
        )
      ) {
        stepResult.newState.metadata._stepTracking = {
          lastLLMContent: content
            ? content.slice(0, 1800) + (content.length > 1800 ? '...' : '')
            : previousTracking.lastLLMContent,
          lastToolsCalling: toolsCalling || previousTracking.lastToolsCalling,
          totalToolCalls: (previousTracking.totalToolCalls ?? 0) + (toolsCalling?.length ?? 0),
        };
      }
      const pendingNextStep: QueueMessage | undefined =
        this.queueService && shouldContinue && stepResult.nextContext
          ? {
              context: stepResult.nextContext,
              delay: this.calculateStepDelay(stepResult),
              endpoint: `${this.baseURL}/run`,
              operationId,
              priority: this.calculatePriority(stepResult),
              retries:
                typeof stepResult.newState.metadata?.queueRetries === 'number'
                  ? stepResult.newState.metadata.queueRetries
                  : undefined,
              retryDelay:
                typeof stepResult.newState.metadata?.queueRetryDelay === 'string'
                  ? stepResult.newState.metadata.queueRetryDelay
                  : undefined,
              stepIndex: stepIndex + 1,
            }
          : undefined;
      stepResult.newState.metadata = {
        ...stepResult.newState.metadata,
        _pendingNextStep: pendingNextStep,
      };
      const metadata = stepResult.newState.metadata || {};
      const tracking = previousTracking;
      const elapsedMs = stepResult.newState.createdAt
        ? Date.now() - new Date(stepResult.newState.createdAt).getTime()
        : undefined;
      const stepLabel = metadata._stepLabel;
      const afterStepHookEvent = {
        agentId: metadata?.agentId || '',
        content,
        elapsedMs,
        executionTimeMs: stepPresentationData.executionTimeMs,
        finalState: stepResult.newState,
        ...(stepLabel && { stepLabel }),
        lastLLMContent: tracking.lastLLMContent,
        lastToolsCalling: tracking.lastToolsCalling,
        operationId,
        reasoning: stepPresentationData.reasoning,
        shouldContinue,
        status: stepResult.newState?.status,
        stepCost: stepPresentationData.stepCost,
        stepIndex,
        stepType: stepPresentationData.stepType,
        steps: stepResult.newState?.stepCount || 0,
        thinking: stepPresentationData.thinking,
        toolCalls: stepResult.newState?.usage?.tools?.totalCalls,
        toolsCalling: stepPresentationData.toolsCalling,
        toolsResult: stepPresentationData.toolsResult,
        topicId: metadata?.topicId,
        totalCost: stepPresentationData.totalCost,
        totalInputTokens: stepPresentationData.totalInputTokens,
        totalOutputTokens: stepPresentationData.totalOutputTokens,
        totalSteps: stepPresentationData.totalSteps,
        totalTokens: stepPresentationData.totalTokens,
        totalToolCalls: (tracking.totalToolCalls ?? 0) + (toolsCalling?.length ?? 0),
        userId: metadata?.userId || this.userId,
      };
      const pendingCallbacks = collectBotCallbackIntents(
        operationId,
        'afterStep',
        afterStepHookEvent,
        metadata._hooks,
      );
      if (!shouldContinue) {
        const completion = this.completionLifecycle.buildLifecycleEvent(
          operationId,
          stepResult.newState,
          this.determineCompletionReason(stepResult.newState),
        );
        pendingCallbacks.push(
          ...collectBotCallbackIntents(
            operationId,
            'onComplete',
            completion.event,
            completion.metadata._hooks,
          ),
        );
        if (completion.event.reason === 'error')
          pendingCallbacks.push(
            ...collectBotCallbackIntents(
              operationId,
              'onError',
              completion.event,
              completion.metadata._hooks,
            ),
          );
      }
      // The Lua state commit also writes a durable Redis->SQL handoff record.
      // A crash or SQL outage after commit can no longer silently drop these bot callbacks.
      // This is a wire-JSON snapshot, not an object clone: normalize Dates/undefined just like transport.
      const callbacksWire = JSON.stringify(pendingCallbacks);
      stepResult.newState.metadata._pendingBotCallbacks = JSON.parse(callbacksWire);
      await renewal.renewNow();
      if (
        !(await this.coordinator.saveStepResultWithLease(
          operationId,
          {
            ...stepResult,
            executionTime: Date.now() - startAt,
            stepIndex,
          },
          lease,
        ))
      )
        throw new StepLeaseLostError();
      authoritativeCommitted = true;
      assertHeld();
      let nextStepScheduled = false;

      // Publish step complete event
      await this.streamManager.publishStreamEvent(operationId, {
        data: {
          finalState: stepResult.newState,
          nextStepScheduled,
          stepIndex,
        },
        stepIndex,
        type: 'step_complete',
      });

      const { usage } = stepResult.newState;
      log(
        '[%s][%d] completed %s | total: %s tokens / $%s | llm×%d | tools×%d',
        operationId,
        stepIndex,
        stepSummary,
        formatTokenCount(stepPresentationData.totalTokens),
        stepPresentationData.totalCost.toFixed(4),
        usage?.llm?.apiCalls ?? 0,
        usage?.tools?.totalCalls ?? 0,
      );

      let afterStepSignalEvents: Array<{ [key: string]: unknown; type: string }> = [];

      // Dispatch afterStep hooks (enriched with step presentation + tracking data)
      try {
        await renewal.renewNow();
        afterStepSignalEvents = toAgentSignalSnapshotEvents(
          await emitAgentSignalSourceEvent(
            {
              payload: {
                agentId: metadata?.agentId,
                operationId,
                serializedContext: undefined,
                stepIndex,
                topicId: metadata?.topicId,
                turnCount: stepResult.newState?.stepCount || 0,
              },
              sourceId: `${operationId}:after:${stepIndex}`,
              sourceType: 'runtime.after_step',
            },
            {
              agentId: metadata?.agentId,
              db: this.serverDB,
              userId: metadata?.userId || this.userId,
            },
            { ignoreError: true },
          ),
        );

        assertHeld();
        const delivery = await hookDispatcher.dispatch(
          operationId,
          'afterStep',
          afterStepHookEvent,
          metadata._hooks,
          assertHeld,
        );
        hookDeliveryFailures.push(...(delivery?.failures ?? []));
      } catch (hookError) {
        assertHeld();
        log('[%s] afterStep hook dispatch error: %O', operationId, hookError);
      }

      assertHeld();
      await this.traceRecorder.appendStep(operationId, {
        afterStepSignalEvents,
        agentState,
        beforeStepSignalEvents,
        currentContext,
        externalRetryCount,
        presentation: stepPresentationData,
        startedAt: startAt,
        stepIndex,
        stepResult,
      });

      if (pendingNextStep && this.queueService) {
        await renewal.renewNow();
        await this.queueService.scheduleMessage(pendingNextStep);
        nextStepScheduled = true;
      }

      // Check if operation is complete
      if (!shouldContinue) {
        await renewal.renewNow();
        const reason = this.determineCompletionReason(stepResult.newState);

        const completionSignalEvents = await this.completionLifecycle.emitSignalEvents(
          operationId,
          stepResult.newState,
          reason,
        );

        // Dispatch completion hooks
        assertHeld();
        const delivery = await this.completionLifecycle.dispatchHooks(
          operationId,
          stepResult.newState,
          reason,
          assertHeld,
        );
        hookDeliveryFailures.push(...(delivery?.failures ?? []));

        // Finalize tracing snapshot. The error catch below uses the same
        // recorder so propagated failures still write the canonical S3
        // snapshot instead of orphaning the partial (LOBE-8533).
        await this.traceRecorder.finalize(operationId, {
          appendEventsToLastStep: completionSignalEvents,
          completionReason: reason,
          error: stepResult.newState.error
            ? {
                message:
                  this.completionLifecycle.extractErrorMessage(stepResult.newState.error) ??
                  JSON.stringify(stepResult.newState.error),
                type: String(
                  stepResult.newState.error.type ??
                    stepResult.newState.error.errorType ??
                    'unknown',
                ),
              }
            : undefined,
          state: stepResult.newState,
        });
      }

      return {
        hookDeliveryFailures,
        nextStepScheduled,
        state: stepResult.newState,
        stepResult,
        success: true,
      };
    } catch (error) {
      // Never let a stale worker write error state or emit completion over its successor.
      assertHeld();
      if (error instanceof StepLeaseLostError || error instanceof StepLeaseBackendError)
        throw error;
      if (authoritativeCommitted) {
        log(
          '[%s][%d] Post-commit work failed; committed state is preserved',
          operationId,
          stepIndex,
        );
        throw error;
      }
      await renewal.renewNow();
      log('Step %d failed for operation %s: %O', stepIndex, operationId, error);
      const formattedError = formatErrorForState(error);

      // Preserve the last known operation on a failed error-path reload; never
      // erase messages/hook metadata by replacing an existing operation with a
      // fabricated minimal state. The actual write still requires its lease.
      let finalStateWithError: any;
      try {
        await this.streamManager.publishStreamEvent(operationId, {
          data: {
            error: formattedError.message,
            errorType: String(formattedError.type),
            phase: 'step_execution',
            stepIndex,
          },
          stepIndex,
          type: 'error',
        });
      } catch (publishError) {
        log(
          '[%s] Failed to publish error event (infra may be down): %O',
          operationId,
          publishError,
        );
      }

      try {
        const errorState = (await this.coordinator.loadAgentState(operationId)) ?? lastKnownState;
        if (!errorState) throw error;
        finalStateWithError = {
          ...errorState!,
          error: formattedError,
          metadata: {
            ...errorState?.metadata,
            externalRetryCount,
          },
          status: 'error' as const,
          stepCount: errorState?.stepCount ?? stepIndex,
        };
      } catch (loadError) {
        log('[%s] Failed to load error state (infra may be down): %O', operationId, loadError);
        if (!lastKnownState) throw error;
        finalStateWithError = {
          ...lastKnownState,
          error: formattedError,
          metadata: { ...lastKnownState.metadata, externalRetryCount },
          status: 'error' as const,
        };
      }

      const errorCompletion = this.completionLifecycle.buildLifecycleEvent(
        operationId,
        finalStateWithError,
        'error',
      );
      finalStateWithError.metadata = {
        ...finalStateWithError.metadata,
        _pendingBotCallbacks: [
          ...collectBotCallbackIntents(
            operationId,
            'onComplete',
            errorCompletion.event,
            errorCompletion.metadata._hooks,
          ),
          ...collectBotCallbackIntents(
            operationId,
            'onError',
            errorCompletion.event,
            errorCompletion.metadata._hooks,
          ),
        ],
      };
      const errorCallbacksWire = JSON.stringify(finalStateWithError.metadata._pendingBotCallbacks);
      finalStateWithError.metadata._pendingBotCallbacks = JSON.parse(errorCallbacksWire);
      await renewal.renewNow();
      if (
        !(await this.coordinator.saveAgentStateWithLease(operationId, finalStateWithError, lease))
      ) {
        throw new StepLeaseLostError();
      }
      assertHeld();

      await this.completionLifecycle.emitSignalEvents(operationId, finalStateWithError, 'error');

      // Dispatch onComplete + onError hooks
      assertHeld();
      await this.completionLifecycle.dispatchHooks(
        operationId,
        finalStateWithError,
        'error',
        assertHeld,
      );

      // Finalize the partial snapshot into the canonical S3 path so the
      // failed op is observable in the same place as a successful run.
      // Without this, propagated errors (e.g. markPersistFatal from
      // RuntimeExecutors) leave the partial as an orphan at
      // `_partial/<op>.json.zst` and the canonical
      // `agent-traces/<agentId>/<topicId>/<op>.json.zst` returns 404 — see
      // LOBE-8533.
      //
      // `failedStep` synthesizes a step record for the failure because the
      // real step never reached `appendStepToPartial` — it threw before the
      // success path could push it. Without this synthetic step, the
      // snapshot's step count would lag the assistant message that
      // triggered the failing call.
      await this.traceRecorder.finalize(operationId, {
        completionReason: 'error',
        error: {
          message: formattedError.message ?? String(formattedError.type),
          type: String(formattedError.type),
        },
        failedStep: { startedAt: stepStartAt, stepIndex },
        state: finalStateWithError,
      });

      throw error;
    } finally {
      // Stop renewal and compare-and-delete only this owner's token. Cleanup
      // failure must not replace the actual execution/lease-loss error.
      await renewal.stop();
      try {
        await stepRuntime?.dispose();
      } finally {
        try {
          await this.coordinator.releaseStepLease(lease);
        } catch {
          log('[%s][%d] Lease cleanup failed; token will expire', operationId, stepIndex);
        }
      }
    }
  }

  /**
   * Get operation status
   */
  async getOperationStatus(params: {
    historyLimit?: number;
    includeHistory?: boolean;
    operationId: string;
  }): Promise<OperationStatusResult | null> {
    const { operationId, includeHistory = false, historyLimit = 10 } = params;

    try {
      log('Getting operation status for %s', operationId);

      // Get current state and metadata
      const [currentState, operationMetadata] = await Promise.all([
        this.coordinator.loadAgentState(operationId),
        this.coordinator.getOperationMetadata(operationId),
      ]);

      // Operation may have expired or does not exist, return null
      if (!currentState || !operationMetadata) {
        log('Operation %s not found (may have expired)', operationId);
        return null;
      }

      // Get execution history (if needed)
      let executionHistory;
      if (includeHistory) {
        try {
          executionHistory = await this.coordinator.getExecutionHistory(operationId, historyLimit);
        } catch (error) {
          log('Failed to load execution history: %O', error);
          executionHistory = [];
        }
      }

      // Get recent stream events (for debugging)
      let recentEvents;
      if (includeHistory) {
        try {
          recentEvents = await this.streamManager.getStreamHistory(operationId, 20);
        } catch (error) {
          log('Failed to load recent events: %O', error);
          recentEvents = [];
        }
      }

      // Calculate operation statistics
      const stats = {
        lastActiveTime: operationMetadata.lastActiveAt
          ? Date.now() - new Date(operationMetadata.lastActiveAt).getTime()
          : 0,
        totalCost: currentState.cost?.total || 0,
        totalMessages: currentState.messages?.length || 0,
        totalSteps: currentState.stepCount || 0,
        uptime: operationMetadata.createdAt
          ? Date.now() - new Date(operationMetadata.createdAt).getTime()
          : 0,
      };

      return {
        currentState: {
          cost: currentState.cost,
          costLimit: currentState.costLimit,
          error: currentState.error,
          interruption: currentState.interruption,
          lastModified: currentState.lastModified,
          maxSteps: currentState.maxSteps,
          pendingHumanPrompt: currentState.pendingHumanPrompt,
          pendingHumanSelect: currentState.pendingHumanSelect,
          pendingToolsCalling: currentState.pendingToolsCalling,
          status: currentState.status,
          stepCount: currentState.stepCount,
          usage: currentState.usage,
        },
        executionHistory: executionHistory?.slice(0, historyLimit),
        hasError: currentState.status === 'error',
        isActive: ['running', 'waiting_for_human'].includes(currentState.status),
        isCompleted: currentState.status === 'done',
        metadata: operationMetadata,
        needsHumanInput: currentState.status === 'waiting_for_human',
        operationId,
        recentEvents: recentEvents?.slice(0, 10),
        stats,
      };
    } catch (error) {
      log('Failed to get operation status for %s: %O', operationId, error);
      throw error;
    }
  }

  /**
   * Get list of pending human interventions
   */
  async getPendingInterventions(params: {
    operationId?: string;
    userId?: string;
  }): Promise<PendingInterventionsResult> {
    const { operationId, userId } = params;

    try {
      log('Getting pending interventions for operationId: %s, userId: %s', operationId, userId);

      let operations: string[] = [];

      if (operationId) {
        operations = [operationId];
      } else if (userId) {
        // Get all active operations for the user
        try {
          const activeOperations = await this.coordinator.getActiveOperations();

          // Filter operations belonging to this user
          const userOperations = [];
          for (const operation of activeOperations) {
            try {
              const metadata = await this.coordinator.getOperationMetadata(operation);
              if (metadata?.userId === userId) {
                userOperations.push(operation);
              }
            } catch (error) {
              log('Failed to get metadata for operation %s: %O', operation, error);
            }
          }
          operations = userOperations;
        } catch (error) {
          log('Failed to get active operations: %O', error);
          operations = [];
        }
      }

      // Check status of each operation
      const pendingInterventions = [];

      for (const operation of operations) {
        try {
          const [state, metadata] = await Promise.all([
            this.coordinator.loadAgentState(operation),
            this.coordinator.getOperationMetadata(operation),
          ]);

          if (state?.status === 'waiting_for_human') {
            const intervention: any = {
              lastModified: state.lastModified,
              modelRuntimeConfig: metadata?.modelRuntimeConfig,
              operationId: operation,
              status: state.status,
              stepCount: state.stepCount,
              userId: metadata?.userId,
            };

            // Add specific pending content
            if (state.pendingToolsCalling) {
              intervention.type = 'tool_approval';
              intervention.pendingToolsCalling = state.pendingToolsCalling;
            } else if (state.pendingHumanPrompt) {
              intervention.type = 'human_prompt';
              intervention.pendingHumanPrompt = state.pendingHumanPrompt;
            } else if (state.pendingHumanSelect) {
              intervention.type = 'human_select';
              intervention.pendingHumanSelect = state.pendingHumanSelect;
            }

            pendingInterventions.push(intervention);
          }
        } catch (error) {
          log('Failed to get state for operation %s: %O', operation, error);
        }
      }

      return {
        pendingInterventions,
        timestamp: new Date().toISOString(),
        totalCount: pendingInterventions.length,
      };
    } catch (error) {
      log('Failed to get pending interventions: %O', error);
      throw error;
    }
  }

  /**
   * Explicitly start operation execution
   */
  async startExecution(params: StartExecutionParams): Promise<StartExecutionResult> {
    const { operationId, context, priority = 'normal', delay = 50 } = params;

    try {
      log('Starting execution for operation %s', operationId);

      // Check if operation exists
      const operationMetadata = await this.coordinator.getOperationMetadata(operationId);
      if (!operationMetadata) {
        throw new Error(`Operation ${operationId} not found`);
      }

      // Get current state
      const currentState = await this.coordinator.loadAgentState(operationId);
      if (!currentState) {
        throw new Error(`Agent state not found for operation ${operationId}`);
      }

      // Check operation status
      if (currentState.status === 'running') {
        throw new Error(`Operation ${operationId} is already running`);
      }

      if (currentState.status === 'done') {
        throw new Error(`Operation ${operationId} is already completed`);
      }

      if (currentState.status === 'error') {
        throw new Error(`Operation ${operationId} is in error state`);
      }

      // Build execution context
      let executionContext = context;
      if (!executionContext) {
        // If no context provided, build default context from metadata
        // Note: AgentRuntimeContext requires sessionId for compatibility with @lobechat/agent-runtime
        executionContext = {
          payload: {
            isFirstMessage: true,
            message: [{ content: '' }],
          },
          phase: 'user_input' as const,
          session: {
            messageCount: currentState.messages?.length || 0,
            sessionId: operationId,
            status: 'idle' as const,
            stepCount: currentState.stepCount || 0,
          },
        };
      }

      // Update operation status to running
      await this.coordinator.saveAgentState(operationId, {
        ...currentState,
        lastModified: new Date().toISOString(),
        status: 'running',
      });

      // Schedule execution (if queue service is available)
      let messageId: string | undefined;
      if (this.queueService) {
        messageId = await this.queueService.scheduleMessage({
          context: executionContext,
          delay,
          endpoint: `${this.baseURL}/run`,
          operationId,
          priority,
          stepIndex: currentState.stepCount || 0,
        });
        log('Scheduled execution for operation %s (messageId: %s)', operationId, messageId);
      } else {
        log('Queue service disabled, skipping schedule for operation %s', operationId);
      }

      return {
        messageId,
        operationId,
        scheduled: !!messageId,
        success: true,
      };
    } catch (error) {
      log('Failed to start execution for operation %s: %O', operationId, error);
      throw error;
    }
  }

  /**
   * Process human intervention
   */
  async processHumanIntervention(params: {
    action: 'approve' | 'reject' | 'reject_continue' | 'input' | 'select';
    approvedToolCall?: any;
    humanInput?: any;
    operationId: string;
    rejectAndContinue?: boolean;
    rejectionReason?: string;
    stepIndex: number;
    toolMessageId?: string;
  }): Promise<{ messageId?: string }> {
    const {
      operationId,
      stepIndex,
      action,
      approvedToolCall,
      humanInput,
      rejectAndContinue,
      rejectionReason,
      toolMessageId,
    } = params;

    try {
      log(
        'Processing human intervention for operation %s:%d (action: %s)',
        operationId,
        stepIndex,
        action,
      );

      // Schedule execution with high priority (if queue service is available)
      let messageId: string | undefined;
      if (this.queueService) {
        messageId = await this.queueService.scheduleMessage({
          context: undefined, // Will be retrieved from state manager
          delay: 100,
          endpoint: `${this.baseURL}/run`,
          operationId,
          payload: {
            approvedToolCall,
            humanInput,
            rejectAndContinue,
            rejectionReason,
            toolMessageId,
          },
          priority: 'high',
          stepIndex,
        });
        log(
          'Scheduled immediate execution for operation %s (messageId: %s)',
          operationId,
          messageId,
        );
      } else {
        log('Queue service disabled, skipping schedule for operation %s', operationId);
      }

      return { messageId };
    } catch (error) {
      log('Failed to process human intervention for operation %s: %O', operationId, error);
      throw error;
    }
  }

  /**
   * Create Agent Runtime instance
   */
  private async createAgentRuntime({
    metadata,
    operationId,
    stepIndex,
    signal,
    assertStepLease,
  }: {
    metadata?: any;
    operationId: string;
    stepIndex: number;
    signal?: AbortSignal;
    assertStepLease?: () => void;
  }) {
    const contextWindowTokens =
      metadata?.modelRuntimeConfig?.model && metadata?.modelRuntimeConfig?.provider
        ? await getModelPropertyWithFallback<number | undefined>(
            metadata.modelRuntimeConfig.model,
            'contextWindowTokens',
            metadata.modelRuntimeConfig.provider,
          )
        : undefined;

    // Create Agent instance — use custom factory if provided, otherwise default to GeneralChatAgent
    const generalConfig = {
      agentConfig: metadata?.agentConfig,
      compressionConfig: {
        enabled: metadata?.agentConfig?.chatConfig?.enableContextCompression ?? true,
        maxWindowToken: contextWindowTokens ?? undefined,
      },
      dynamicInterventionAudits,
      modelRuntimeConfig: metadata?.modelRuntimeConfig,
      operationId,
      userId: metadata?.userId,
    };

    const agent = this.agentFactory
      ? this.agentFactory(generalConfig)
      : new GeneralChatAgent(generalConfig);

    // Create streaming executor context
    const executorContext: RuntimeExecutorContext = {
      signal,
      assertStepLease,
      agentConfig: metadata?.agentConfig,
      botPlatformContext: metadata?.botPlatformContext,
      discordContext: metadata?.discordContext,
      userTimezone: metadata?.userTimezone,
      evalContext: metadata?.evalContext,
      hookDispatcher,
      loadAgentState: this.coordinator.loadAgentState.bind(this.coordinator),
      messageModel: this.messageModel,
      operationId,
      serverDB: this.serverDB,
      stepIndex,
      stream: metadata?.stream,
      streamManager: this.streamManager,
      toolExecutionService: this.toolExecutionService,
      topicId: metadata?.topicId,
      userId: metadata?.userId,
    };

    // Create Agent Runtime instance
    const runtime = new AgentRuntime(agent as any, {
      executors: createRuntimeExecutors(executorContext),
    });

    return { agent, runtime };
  }

  /**
   * Create default snapshot store based on environment.
   * - ENABLE_AGENT_S3_TRACING=1 → S3SnapshotStore
   * - NODE_ENV=development → FileSnapshotStore
   * - Otherwise → null (no tracing)
   */
  private createDefaultSnapshotStore(): ISnapshotStore | null {
    if (process.env.ENABLE_AGENT_S3_TRACING === '1') {
      try {
        const { S3SnapshotStore } = require('@/server/modules/AgentTracing');
        return new S3SnapshotStore();
      } catch {
        // S3SnapshotStore not available
      }
    }

    if (process.env.NODE_ENV === 'development') {
      try {
        const { FileSnapshotStore } = require('@lobechat/agent-tracing');
        return new FileSnapshotStore();
      } catch {
        // agent-tracing not available
      }
    }

    return null;
  }

  /**
   * Compute device context from DB messages at step boundary.
   * Uses findInMessages visitor to scan tool messages for device activation.
   */
  private async computeDeviceContext(state: any) {
    try {
      const dbMessages = await this.messageModel.query({
        agentId: state.metadata?.agentId,
        threadId: state.metadata?.threadId,
        topicId: state.metadata?.topicId,
      });

      return findInMessages(
        dbMessages,
        (msg) => {
          const activeDeviceId = msg.pluginState?.metadata?.activeDeviceId;
          if (activeDeviceId) {
            return {
              activeDeviceId,
              devicePlatform: msg.pluginState?.metadata?.devicePlatform as string | undefined,
              deviceSystemInfo: msg.pluginState?.metadata?.deviceSystemInfo as
                Record<string, string> | undefined,
            };
          }
        },
        { role: 'tool' },
      );
    } catch (error) {
      log('computeDeviceContext error: %O', error);
    }

    return undefined;
  }

  /**
   * Decide whether to continue execution
   */
  private shouldContinueExecution(state: any, context?: any): boolean {
    // Completed
    if (state.status === 'done') return false;

    // Needs human intervention
    if (state.status === 'waiting_for_human') return false;

    // Error occurred
    if (state.status === 'error') return false;

    // Interrupted
    if (state.status === 'interrupted') return false;

    // maxSteps is handled by runtime.step() which sets forceFinish → status:'done'
    // No redundant check here — trust the runtime state machine

    // Exceeded cost limit
    if (state.costLimit && state.cost?.total >= state.costLimit.maxTotalCost) {
      return state.costLimit.onExceeded !== 'stop';
    }

    // No next context
    if (!context) return false;

    return true;
  }

  /**
   * Calculate step delay
   */
  private calculateStepDelay(stepResult: any): number {
    const baseDelay = 50;

    // If there are tool calls, add longer delay
    if (stepResult.events?.some((e: any) => e.type === 'tool_result')) {
      return baseDelay + 50;
    }

    // If there are errors, use exponential backoff
    if (stepResult.events?.some((e: any) => e.type === 'error')) {
      return Math.min(baseDelay * 2, 1000);
    }

    return baseDelay;
  }

  /**
   * Calculate priority
   */
  private calculatePriority(stepResult: any): 'high' | 'normal' | 'low' {
    // If human intervention needed, high priority
    if (stepResult.newState?.status === 'waiting_for_human') {
      return 'high';
    }

    // If there are errors, normal priority
    if (stepResult.events?.some((e: any) => e.type === 'error')) {
      return 'normal';
    }

    return 'normal';
  }

  /**
   * Determine operation completion reason
   */
  private determineCompletionReason(state: AgentState): StepCompletionReason {
    if (state.status === 'done') return 'done';
    if (state.status === 'error') return 'error';
    if (state.status === 'interrupted') return 'interrupted';
    if (state.status === 'waiting_for_human') return 'waiting_for_human';
    if (state.maxSteps && state.stepCount >= state.maxSteps) return 'max_steps';
    if (state.costLimit && state.cost?.total >= state.costLimit.maxTotalCost) return 'cost_limit';
    return 'done';
  }

  /**
   * Synchronously execute Agent operation until completion
   *
   * Used in test scenarios, doesn't depend on QueueService, executes all steps directly in the current process.
   *
   * @param operationId Operation ID
   * @param options Execution options
   * @returns Final state
   *
   * @example
   * ```ts
   * // Create operation (without auto-starting queue)
   * const result = await service.createOperation({ ...params, autoStart: false });
   *
   * // Synchronously execute to completion
   * const finalState = await service.executeSync(result.operationId);
   * expect(finalState.status).toBe('done');
   * ```
   */
  async executeSync(
    operationId: string,
    options?: {
      /** Initial context (if not provided, inferred from state) */
      initialContext?: AgentRuntimeContext;
      /** Maximum step limit to prevent infinite loops, defaults to 9999 */
      maxSteps?: number;
      /** Callback after each step execution (for debugging) */
      onStepComplete?: (stepIndex: number, state: AgentState) => void;
    },
  ): Promise<AgentState> {
    const { maxSteps = 999, onStepComplete, initialContext } = options ?? {};

    log('[%s] Starting sync execution (maxSteps: %d)', operationId, maxSteps);

    // Load initial state
    const initialState = await this.coordinator.loadAgentState(operationId);
    if (!initialState) {
      throw new Error(`Agent state not found for operation ${operationId}`);
    }

    let state: AgentState = initialState;

    // Build initial context
    // Priority: explicit initialContext param > saved initialContext in state > default
    let context: AgentRuntimeContext | undefined =
      initialContext ??
      (state as any).initialContext ??
      ({
        payload: {},
        phase: 'user_input' as const,
        session: {
          messageCount: state.messages?.length ?? 0,
          sessionId: operationId,
          status: state.status,
          stepCount: state.stepCount,
        },
      } as AgentRuntimeContext);

    let stepIndex = state.stepCount;

    // Execution loop
    while (stepIndex < maxSteps) {
      // Check termination conditions
      if (state.status === 'done' || state.status === 'error' || state.status === 'interrupted') {
        log('[%s] Sync execution finished with status: %s', operationId, state.status);
        break;
      }

      // Check if human intervention is needed
      if (state.status === 'waiting_for_human') {
        log('[%s] Sync execution paused: waiting for human intervention', operationId);
        break;
      }

      // Execute one step
      log('[%s][%d] Start executing...', operationId, stepIndex);
      const result = await this.executeStep({
        context,
        operationId,
        stepIndex,
      });

      state = result.state as AgentState;
      context = result.stepResult.nextContext;
      stepIndex++;

      // Callback
      if (onStepComplete) {
        onStepComplete(stepIndex, state);
      }

      // Check if should continue
      if (!this.shouldContinueExecution(state, context)) {
        log('[%s] Sync execution stopped: shouldContinue=false', operationId);
        break;
      }
    }

    if (stepIndex >= maxSteps) {
      log('[%s] Sync execution stopped: reached maxSteps (%d)', operationId, maxSteps);
      // If stopped due to executeSync's maxSteps limit, need to manually dispatch onComplete hooks
      // Note: If stopped due to state.maxSteps being reached, onComplete has already been called in executeStep
      if (state.status !== 'done' && state.status !== 'error') {
        await this.completionLifecycle.emitSignalEvents(operationId, state, 'max_steps');
        await this.completionLifecycle.dispatchHooks(operationId, state, 'max_steps');
      }
    }

    return state;
  }

  /**
   * Get Coordinator instance (for testing)
   */
  getCoordinator(): AgentRuntimeCoordinator {
    return this.coordinator;
  }
}
