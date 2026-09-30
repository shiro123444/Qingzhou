import { describe, expect, it, vi } from 'vitest';

import { getMessageGatewayClient } from '@/server/services/gateway/MessageGatewayClient';
import { isQueueAgentRuntimeEnabled } from '@/server/services/queue/impls';

import { AgentBridgeService } from '../AgentBridgeService';
import type { BotCallbackBody } from '../BotCallbackService';
import { BotCallbackService } from '../BotCallbackService';
import { CALLBACK_LEASE_MS, CallbackDeliverySession } from '../callbackLedger';

// ==================== Hoisted mocks ====================

const mockFindByPlatformAndAppId = vi.hoisted(() => vi.fn());
const mockInitWithEnvKey = vi.hoisted(() => vi.fn());
const mockDecrypt = vi.hoisted(() => vi.fn());
const mockFindById = vi.hoisted(() => vi.fn());
const mockTopicUpdate = vi.hoisted(() => vi.fn());
const mockGenerateTopicTitle = vi.hoisted(() => vi.fn());

// Unified messenger mock methods (used by all platforms via PlatformClient)
const mockEditMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockTriggerTyping = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRemoveReaction = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCreateMessage = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'new-msg' }));
const mockUpdateThreadName = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
// Default replaceReaction fans out to removeReaction so existing '👀' assertions
// keep describing the effective behaviour (step swap / completion clear) end-to-end.
const mockReplaceReaction = vi.hoisted(() =>
  vi.fn().mockImplementation(async (messageId: string, prevEmoji: string | null) => {
    if (prevEmoji) await mockRemoveReaction(messageId, prevEmoji);
  }),
);

// Mock PlatformClient's getMessenger
const mockGetMessenger = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    createMessage: mockCreateMessage,
    editMessage: mockEditMessage,
    removeReaction: mockRemoveReaction,
    replaceReaction: mockReplaceReaction,
    triggerTyping: mockTriggerTyping,
    updateThreadName: mockUpdateThreadName,
  })),
);

const mockCreateBot = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    applicationId: 'mock-app',
    createAdapter: () => ({}),
    extractChatId: (id: string) => id,
    getMessenger: mockGetMessenger,
    parseMessageId: (id: string) => id,
    id: 'mock',
    start: vi.fn(),
    stop: vi.fn(),
  })),
);

// Mocks for messenger-originated callbacks (synthetic applicationIds like
// 'messenger-telegram'). Resolves credentials via the messenger installation
// store + binder, bypassing `agent_bot_providers` entirely.
const mockMessengerStoreResolveByKey = vi.hoisted(() => vi.fn());
const mockMessengerGetInstallationStore = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({ resolveByKey: mockMessengerStoreResolveByKey })),
);
const mockMessengerBinderCreateClient = vi.hoisted(() =>
  vi.fn().mockImplementation(async () => ({
    applicationId: 'mock-messenger-app',
    createAdapter: () => ({}),
    extractChatId: (id: string) => id,
    getMessenger: mockGetMessenger,
    parseMessageId: (id: string) => id,
  })),
);
const mockMessengerCreateBinder = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({ createClient: mockMessengerBinderCreateClient })),
);

vi.mock('@/server/services/queue/impls', () => ({
  isQueueAgentRuntimeEnabled: vi.fn().mockReturnValue(false),
}));

// ==================== vi.mock ====================

vi.mock('@/database/models/agentBotProvider', () => ({
  AgentBotProviderModel: {
    findByPlatformAndAppId: mockFindByPlatformAndAppId,
  },
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({
    findById: mockFindById,
    update: mockTopicUpdate,
  })),
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: {
    initWithEnvKey: mockInitWithEnvKey,
  },
}));

vi.mock('@/server/modules/AgentRuntime/redis', () => ({
  getAgentRuntimeRedisClient: vi.fn().mockReturnValue(null),
}));

vi.mock('../AgentBridgeService', () => ({
  AgentBridgeService: {
    clearActiveThread: vi.fn(),
  },
}));

vi.mock('@/server/services/gateway/MessageGatewayClient', () => ({
  getMessageGatewayClient: vi.fn().mockReturnValue({
    isConfigured: false,
    isEnabled: false,
    startTyping: vi.fn().mockResolvedValue(undefined),
    stopTyping: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/server/services/systemAgent', () => ({
  SystemAgentService: vi.fn().mockImplementation(() => ({
    generateTopicTitle: mockGenerateTopicTitle,
  })),
}));

vi.mock('@/server/services/messenger/installations', () => ({
  getInstallationStore: mockMessengerGetInstallationStore,
  messengerConnectionIdForUser: ({
    installationKey,
    userId,
  }: {
    installationKey: string;
    userId: string;
  }) => {
    if (installationKey.endsWith(':singleton')) {
      return `messenger:${installationKey.slice(0, -':singleton'.length)}:user-${userId}`;
    }
    return `messenger:${installationKey}:user-${userId}`;
  },
}));

vi.mock('@/server/services/messenger/platforms', () => ({
  messengerPlatformRegistry: {
    createBinder: mockMessengerCreateBinder,
    getPlatform: vi.fn().mockImplementation((platform: string) => ({
      connectionMode: platform === 'discord' ? 'websocket' : 'webhook',
      id: platform,
      name: platform,
    })),
  },
}));

vi.mock('../platforms', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    platformRegistry: {
      getPlatform: vi.fn().mockImplementation((platform: string) => {
        if (platform === 'unknown') return undefined;
        return {
          clientFactory: { createClient: mockCreateBot },
          credentials: [],
          name: platform,
          id: platform,
          schema: [],
          supportsMessageEdit: platform !== 'qq',
        };
      }),
    },
  };
});

// ==================== Helpers ====================

const FAKE_DB = {} as any;
const FAKE_BOT_TOKEN = 'fake-bot-token-123';
const FAKE_CREDENTIALS = JSON.stringify({ botToken: FAKE_BOT_TOKEN });

function setupCredentials(credentials = FAKE_CREDENTIALS, extra?: Record<string, unknown>) {
  // Step rendering is opt-in (schema default: false). The legacy bot path
  // tests in this file all exercise step rendering, so the default fixture
  // turns it on. Tests that need to exercise the off-path can override
  // `settings` via `extra`.
  mockFindByPlatformAndAppId.mockResolvedValue({
    credentials,
    settings: { displayToolCalls: true },
    ...extra,
  });
  mockInitWithEnvKey.mockResolvedValue({ decrypt: mockDecrypt });
  mockDecrypt.mockResolvedValue({ plaintext: credentials });
}

let operationCounter = 0;

function makeBody(overrides: Partial<BotCallbackBody> = {}): BotCallbackBody {
  return {
    applicationId: 'app-123',
    operationId: `test-op-${++operationCounter}`,
    stepIndex: 0,
    platformThreadId: 'discord:guild:channel-id',
    progressMessageId: 'progress-msg-1',
    type: 'step',
    ...overrides,
  };
}

function makeTelegramBody(overrides: Partial<BotCallbackBody> = {}): BotCallbackBody {
  return makeBody({
    platformThreadId: 'telegram:chat-456',
    ...overrides,
  });
}

// ==================== Tests ====================

describe('BotCallbackService', () => {
  let service: BotCallbackService;

  beforeEach(() => {
    vi.clearAllMocks();
    (getMessageGatewayClient() as any).isEnabled = false;
    vi.mocked(isQueueAgentRuntimeEnabled).mockReturnValue(false);
    service = new BotCallbackService(FAKE_DB);
    setupCredentials();

    // vi.clearAllMocks wipes the hoisted default impl; reinstall it so the
    // replaceReaction spy keeps fanning out to removeReaction.
    mockReplaceReaction.mockImplementation(async (messageId: string, prevEmoji: string | null) => {
      if (prevEmoji) await mockRemoveReaction(messageId, prevEmoji);
    });

    // Default: getMessenger returns the main messenger mock
    mockGetMessenger.mockImplementation(() => ({
      createMessage: mockCreateMessage,
      editMessage: mockEditMessage,
      removeReaction: mockRemoveReaction,
      replaceReaction: mockReplaceReaction,
      triggerTyping: mockTriggerTyping,
      updateThreadName: mockUpdateThreadName,
    }));

    // Default messenger install store + binder responses for messenger-* runs.
    mockMessengerStoreResolveByKey.mockResolvedValue({
      applicationId: 'telegram:singleton',
      botToken: 'fake-token',
      installationKey: 'telegram:singleton',
      metadata: {},
      platform: 'telegram',
      tenantId: '',
    });
    mockMessengerGetInstallationStore.mockImplementation(() => ({
      resolveByKey: mockMessengerStoreResolveByKey,
    }));
    mockMessengerBinderCreateClient.mockImplementation(async () => ({
      applicationId: 'mock-messenger-app',
      createAdapter: () => ({}),
      extractChatId: (id: string) => id,
      getMessenger: mockGetMessenger,
      parseMessageId: (id: string) => id,
    }));
    mockMessengerCreateBinder.mockImplementation(() => ({
      createClient: mockMessengerBinderCreateClient,
    }));
  });

  // ==================== Platform detection ====================

  describe('platform detection from platformThreadId', () => {
    it('should detect discord platform from platformThreadId prefix', async () => {
      const body = makeBody({
        shouldContinue: true,
        stepType: 'call_llm',
        type: 'step',
      });

      await service.handleCallback(body);

      expect(mockFindByPlatformAndAppId).toHaveBeenCalledWith(FAKE_DB, 'discord', 'app-123');
    });

    it('should detect telegram platform from platformThreadId prefix', async () => {
      const body = makeTelegramBody({
        shouldContinue: true,
        stepType: 'call_llm',
        type: 'step',
      });

      await service.handleCallback(body);

      expect(mockFindByPlatformAndAppId).toHaveBeenCalledWith(FAKE_DB, 'telegram', 'app-123');
    });
  });

  // ==================== Messenger-originated runs ====================

  describe('messenger-originated callbacks', () => {
    it('should resolve telegram credentials via messenger install store, not agent_bot_providers, when messengerInstallationKey is set', async () => {
      const body = makeTelegramBody({
        // The applicationId is intentionally just a runtime bookkeeping
        // handle — we never inspect its shape. The deterministic switch is
        // `messengerInstallationKey`, set by `MessengerRouter`.
        applicationId: 'messenger-telegram',
        messengerInstallationKey: 'telegram:singleton',
        shouldContinue: true,
        stepType: 'call_llm',
        type: 'step',
      });

      await service.handleCallback(body);

      // Crucially: never hits agent_bot_providers — that lookup throws for
      // messenger-originated runs and was the cause of LOBE-8654.
      expect(mockFindByPlatformAndAppId).not.toHaveBeenCalled();
      expect(mockMessengerGetInstallationStore).toHaveBeenCalledWith('telegram');
      expect(mockMessengerStoreResolveByKey).toHaveBeenCalledWith('telegram:singleton');
      expect(mockMessengerBinderCreateClient).toHaveBeenCalled();
      // `displayToolCalls` defaults to off (schema default + runtime gate),
      // so step events don't edit the progress message — only completion does.
      // This test only asserts the credential-resolution path; the gating is
      // implicit confirmation that no `editMessage` side-effect leaked.
      expect(mockEditMessage).not.toHaveBeenCalled();
    });

    it('should pass through the messenger install key verbatim for slack workspaces', async () => {
      mockMessengerStoreResolveByKey.mockResolvedValue({
        applicationId: 'A0123',
        botToken: 'xoxb-fake',
        installationKey: 'slack:T0123',
        metadata: {},
        platform: 'slack',
        tenantId: 'T0123',
      });

      const body = makeBody({
        applicationId: 'messenger-slack-T0123',
        messengerInstallationKey: 'slack:T0123',
        platformThreadId: 'slack:C0123:thread-1',
        shouldContinue: true,
        stepType: 'call_llm',
        type: 'step',
      });

      await service.handleCallback(body);

      expect(mockMessengerGetInstallationStore).toHaveBeenCalledWith('slack');
      expect(mockMessengerStoreResolveByKey).toHaveBeenCalledWith('slack:T0123');
    });

    it('should throw a clear error when messenger install is not found', async () => {
      mockMessengerStoreResolveByKey.mockResolvedValue(null);

      const body = makeTelegramBody({
        applicationId: 'messenger-telegram',
        messengerInstallationKey: 'telegram:singleton',
        type: 'completion',
      });

      await expect(service.handleCallback(body)).rejects.toThrow(
        'Messenger install not found for telegram (key=telegram:singleton)',
      );
    });

    it('should fall back to agent_bot_providers when messengerInstallationKey is absent, even if applicationId looks messenger-like', async () => {
      // Defensive guard: a row in agent_bot_providers happens to be named
      // 'messenger-anything' — we should still treat it as a per-user bot
      // because the discriminator is the explicit field, not the name shape.
      const body = makeBody({
        applicationId: 'messenger-looking-but-real-bot',
        shouldContinue: true,
        stepType: 'call_llm',
        type: 'step',
      });

      await service.handleCallback(body);

      expect(mockFindByPlatformAndAppId).toHaveBeenCalledWith(
        FAKE_DB,
        'discord',
        'messenger-looking-but-real-bot',
      );
      expect(mockMessengerStoreResolveByKey).not.toHaveBeenCalled();
    });
  });

  // ==================== Messenger creation errors ====================

  describe('messenger creation failures', () => {
    it('should throw when bot provider not found', async () => {
      mockFindByPlatformAndAppId.mockResolvedValue(null);

      const body = makeBody({ type: 'step' });

      await expect(service.handleCallback(body)).rejects.toThrow(
        'Bot provider not found for discord appId=app-123',
      );
    });

    it('should fall back to raw credentials when decryption fails', async () => {
      mockFindByPlatformAndAppId.mockResolvedValue({
        credentials: FAKE_CREDENTIALS,
        settings: { displayToolCalls: true },
      });
      mockInitWithEnvKey.mockResolvedValue({
        decrypt: vi.fn().mockRejectedValue(new Error('decrypt failed')),
      });

      const body = makeBody({
        shouldContinue: true,
        stepType: 'call_llm',
        type: 'step',
      });

      // Should not throw because it falls back to raw JSON parse
      await service.handleCallback(body);

      expect(mockEditMessage).toHaveBeenCalled();
    });
  });

  // ==================== handleCallback routing ====================

  describe('handleCallback routing', () => {
    it('should route step type to handleStep', async () => {
      const body = makeBody({
        content: 'Thinking...',
        shouldContinue: true,
        stepType: 'call_llm',
        type: 'step',
      });

      await service.handleCallback(body);

      expect(mockEditMessage).toHaveBeenCalledWith('progress-msg-1', expect.any(String));
    });

    it('should route completion type to handleCompletion', async () => {
      const body = makeBody({
        lastAssistantContent: 'Here is the answer.',
        reason: 'completed',
        type: 'completion',
      });

      await service.handleCallback(body);

      expect(mockEditMessage).toHaveBeenCalledWith(
        'progress-msg-1',
        expect.stringContaining('Here is the answer.'),
      );
    });
  });

  // ==================== Step handling ====================

  describe('step handling', () => {
    it('should skip step processing when shouldContinue is false', async () => {
      const body = makeBody({
        shouldContinue: false,
        type: 'step',
      });

      await service.handleCallback(body);

      expect(mockEditMessage).not.toHaveBeenCalled();
    });

    it('should edit progress message and trigger typing for non-final LLM step', async () => {
      const body = makeBody({
        content: 'Processing...',
        shouldContinue: true,
        stepType: 'call_llm',
        toolsCalling: [{ apiName: 'search', arguments: '{}', identifier: 'web' }],
        type: 'step',
      });

      await service.handleCallback(body);

      expect(mockEditMessage).toHaveBeenCalledTimes(1);
      expect(mockTriggerTyping).toHaveBeenCalledTimes(1);
    });

    it('should NOT trigger typing for final LLM response (no tool calls + has content)', async () => {
      const body = makeBody({
        content: 'Final answer here',
        shouldContinue: true,
        stepType: 'call_llm',
        toolsCalling: [],
        type: 'step',
      });

      await service.handleCallback(body);

      expect(mockEditMessage).toHaveBeenCalledTimes(1);
      expect(mockTriggerTyping).not.toHaveBeenCalled();
    });

    it('should handle tool step type', async () => {
      const body = makeBody({
        lastToolsCalling: [{ apiName: 'search', identifier: 'web' }],
        shouldContinue: true,
        stepType: 'call_tool',
        toolsResult: [{ apiName: 'search', identifier: 'web', output: 'result data' }],
        type: 'step',
      });

      await service.handleCallback(body);

      expect(mockEditMessage).toHaveBeenCalledTimes(1);
      expect(mockTriggerTyping).toHaveBeenCalledTimes(1);
    });

    it('should report unknown delivery when edit message fails during step', async () => {
      mockEditMessage.mockRejectedValueOnce(new Error('API error'));

      const body = makeBody({
        content: 'Processing...',
        shouldContinue: true,
        stepType: 'call_llm',
        type: 'step',
      });

      // Should not throw - error is logged but swallowed
      await expect(service.handleCallback(body)).rejects.toMatchObject({
        status: 'unknown_delivery',
      });
    });
  });

  // ==================== Completion handling ====================

  describe('completion handling', () => {
    it('should render operation id when reason is error', async () => {
      const body = makeBody({
        errorMessage: 'Model quota exceeded',
        operationId: 'op-xyz-1',
        reason: 'error',
        type: 'completion',
      });

      await service.handleCallback(body);

      expect(mockEditMessage).toHaveBeenCalledWith(
        'progress-msg-1',
        expect.stringContaining('op-xyz-1'),
      );
      expect(mockEditMessage).toHaveBeenCalledWith(
        'progress-msg-1',
        expect.not.stringContaining('Model quota exceeded'),
      );
    });

    it('should reject a callback without operationId', async () => {
      const body = makeBody({
        operationId: undefined,
        reason: 'error',
        type: 'completion',
      });

      await expect(service.handleCallback(body)).rejects.toMatchObject({
        status: 'invalid_callback',
      });

      expect(mockEditMessage).not.toHaveBeenCalled();
    });

    it('should render stopped message when reason is interrupted', async () => {
      const body = makeBody({
        lastAssistantContent: 'Partial answer that should not be shown',
        reason: 'interrupted',
        type: 'completion',
      });

      await service.handleCallback(body);

      expect(mockCreateMessage).toHaveBeenCalledWith('Execution stopped.');
      expect(mockEditMessage).not.toHaveBeenCalled();
    });

    it('should render custom stopped message when interrupted has errorMessage', async () => {
      const body = makeBody({
        errorMessage: 'Execution stopped by user.',
        lastAssistantContent: 'Partial answer that should not be shown',
        reason: 'interrupted',
        type: 'completion',
      });

      await service.handleCallback(body);

      expect(mockCreateMessage).toHaveBeenCalledWith('Execution stopped by user.');
      expect(mockEditMessage).not.toHaveBeenCalled();
    });

    it('should skip when no lastAssistantContent on successful completion', async () => {
      const body = makeBody({
        reason: 'completed',
        type: 'completion',
      });

      await service.handleCallback(body);

      expect(mockEditMessage).not.toHaveBeenCalled();
    });

    it('should edit progress message with final reply content', async () => {
      const body = makeBody({
        cost: 0.005,
        duration: 3000,
        lastAssistantContent: 'The answer is 42.',
        llmCalls: 2,
        reason: 'completed',
        toolCalls: 1,
        totalTokens: 1500,
        type: 'completion',
      });

      await service.handleCallback(body);

      expect(mockEditMessage).toHaveBeenCalledWith(
        'progress-msg-1',
        expect.stringContaining('The answer is 42.'),
      );
    });

    it('should report unknown delivery when editing completion message fails', async () => {
      mockEditMessage.mockRejectedValueOnce(new Error('Edit failed'));

      const body = makeBody({
        lastAssistantContent: 'Some response',
        reason: 'completed',
        type: 'completion',
      });

      await expect(service.handleCallback(body)).rejects.toMatchObject({
        status: 'unknown_delivery',
      });
    });

    it('should not append createMessage when edit outcome is unknown', async () => {
      mockEditMessage.mockRejectedValueOnce(
        new Error("Telegram API editMessageText failed: 400 Bad Request: can't parse entities"),
      );

      const body = makeBody({
        lastAssistantContent: 'The actual answer the user needs.',
        reason: 'completed',
        type: 'completion',
      });

      await expect(service.handleCallback(body)).rejects.toMatchObject({
        status: 'unknown_delivery',
      });
      expect(mockEditMessage).toHaveBeenCalledTimes(1);
      expect(mockCreateMessage).not.toHaveBeenCalled();
    });

    it('should preserve unknown error-state edit without fallback', async () => {
      mockEditMessage.mockRejectedValueOnce(new Error('message to edit not found'));

      const body = makeBody({
        operationId: 'op-fallback-1',
        reason: 'error',
        type: 'completion',
      });

      await expect(service.handleCallback(body)).rejects.toMatchObject({
        status: 'unknown_delivery',
      });
      expect(mockCreateMessage).not.toHaveBeenCalled();
    });

    it('should skip send when lastAssistantContent is whitespace-only', async () => {
      const body = makeBody({
        // Whitespace passes the original `!lastAssistantContent` check but
        // collapses to empty downstream — Telegram would reject with
        // "message text is empty" and silently drop the reply.
        lastAssistantContent: '   \n\n   ',
        reason: 'completed',
        type: 'completion',
      });

      await service.handleCallback(body);

      expect(mockEditMessage).not.toHaveBeenCalled();
      expect(mockCreateMessage).not.toHaveBeenCalled();
    });

    it('should stop and retain partial chunks on unknown delivery', async () => {
      // Default 1800-char limit -> long content splits into multiple chunks.
      const longContent = 'A'.repeat(2000) + '\n\n' + 'B'.repeat(2000) + '\n\n' + 'C'.repeat(2000);

      // First follow-up chunk is ambiguous; do not send it or later chunks on retry.
      mockCreateMessage.mockRejectedValueOnce(
        new Error('Telegram API sendMessage failed: 429 Too Many Requests'),
      );

      const body = makeBody({
        lastAssistantContent: longContent,
        reason: 'completed',
        type: 'completion',
      });

      await expect(service.handleCallback(body)).rejects.toMatchObject({
        status: 'unknown_delivery',
      });
      await expect(service.handleCallback(body)).rejects.toMatchObject({
        status: 'unknown_delivery',
      });
      expect(mockEditMessage).toHaveBeenCalledTimes(1);
      expect(mockCreateMessage).toHaveBeenCalledTimes(1);
    });

    it('should report unknown delivery when sending interrupted message fails', async () => {
      mockCreateMessage.mockRejectedValueOnce(new Error('Send failed'));

      const body = makeBody({
        reason: 'interrupted',
        type: 'completion',
      });

      await expect(service.handleCallback(body)).rejects.toMatchObject({
        status: 'unknown_delivery',
      });
    });
  });

  describe('delivery ledger ordering', () => {
    it('skips a human-approval pause without poisoning resumed steps or the eventual final reply', async () => {
      const pause = makeBody({
        type: 'completion',
        reason: 'waiting_for_human',
        lastAssistantContent: 'awaiting approval',
      });
      const begin = vi.spyOn(CallbackDeliverySession, 'begin');
      try {
        await expect(service.handleCallback(pause)).resolves.toEqual({ status: 'skipped' });
        expect(begin).not.toHaveBeenCalled();
        expect(mockFindByPlatformAndAppId).not.toHaveBeenCalled();
        expect(mockEditMessage).not.toHaveBeenCalled();
        expect(mockCreateMessage).not.toHaveBeenCalled();
        expect(AgentBridgeService.clearActiveThread).not.toHaveBeenCalled();
        expect(getMessageGatewayClient().stopTyping).not.toHaveBeenCalled();
        await expect(
          service.handleCallback({
            ...pause,
            type: 'step',
            reason: undefined,
            stepIndex: 2,
            shouldContinue: true,
            stepType: 'call_tool',
          }),
        ).resolves.toEqual({ status: 'delivered' });
        expect(mockEditMessage).toHaveBeenCalledTimes(1);
        const completion = { ...pause, reason: 'completed', lastAssistantContent: 'final answer' };
        await expect(service.handleCallback(completion)).resolves.toEqual({ status: 'delivered' });
        await expect(service.handleCallback(completion)).resolves.toEqual({ status: 'skipped' });
        expect(mockEditMessage).toHaveBeenCalledTimes(2);
        expect(mockEditMessage).toHaveBeenLastCalledWith('progress-msg-1', 'final answer');
        expect(AgentBridgeService.clearActiveThread).toHaveBeenCalledTimes(1);
      } finally {
        begin.mockRestore();
      }
    });

    it('permits terminal redispatch with new duration and hook identity after pre-send credential failure', async () => {
      const body = makeBody({
        type: 'completion',
        duration: 100,
        hookId: 'original-hook',
        lastAssistantContent: 'answer',
      });
      mockFindByPlatformAndAppId.mockRejectedValueOnce(new Error('temporary database failure'));
      await expect(service.handleCallback(body)).rejects.toThrow('temporary database failure');
      await expect(
        service.handleCallback({
          ...body,
          duration: 200,
          hookId: 'redispatch-hook',
          hookType: 'onComplete',
        }),
      ).resolves.toEqual({ status: 'delivered' });
      expect(mockEditMessage).toHaveBeenCalledTimes(1);
    });

    it('freezes rendered duration after the first chunk and refuses mixed content on partial retries', async () => {
      const makeClient = () => ({
        getMessenger: mockGetMessenger,
        formatReply: (text: string, stats: { elapsedMs?: number }) =>
          `${text} duration=${stats.elapsedMs}`,
      });
      mockCreateBot.mockImplementationOnce(makeClient).mockImplementationOnce(makeClient);
      const body = makeBody({
        type: 'completion',
        duration: 100,
        lastAssistantContent: 'A'.repeat(2000),
      });
      const originalEffect = CallbackDeliverySession.prototype.effect;
      let interrupt = true;
      const effect = vi
        .spyOn(CallbackDeliverySession.prototype, 'effect')
        .mockImplementation(async function (this: CallbackDeliverySession, id, send) {
          if (id === 'chunk:1' && interrupt) {
            interrupt = false;
            throw new Error('worker stopped before dispatch');
          }
          return originalEffect.call(this, id, send);
        });
      try {
        await expect(service.handleCallback(body)).rejects.toThrow(
          'worker stopped before dispatch',
        );
        expect(mockEditMessage).toHaveBeenCalledTimes(1);
        expect(mockCreateMessage).not.toHaveBeenCalled();
        await expect(
          service.handleCallback({ ...body, lastAssistantContent: 'different content' }),
        ).rejects.toMatchObject({ status: 'payload_conflict' });
        await expect(
          service.handleCallback({ ...body, duration: 999, hookId: 'redispatch' }),
        ).resolves.toEqual({ status: 'delivered' });
        expect(mockEditMessage).toHaveBeenCalledTimes(1);
        expect(mockCreateMessage).toHaveBeenCalledWith(expect.stringContaining('duration=100'));
        expect(mockCreateMessage).not.toHaveBeenCalledWith(expect.stringContaining('duration=999'));
      } finally {
        effect.mockRestore();
      }
    });

    it('delivers an independent final message after an ambiguous progress edit without retrying either', async () => {
      const step = makeBody({ shouldContinue: true, stepType: 'call_tool' });
      mockEditMessage.mockRejectedValueOnce(new Error('progress edit timed out'));
      await expect(service.handleCallback(step)).rejects.toMatchObject({
        status: 'unknown_delivery',
      });
      await expect(service.handleCallback({ ...step, stepIndex: 1 })).rejects.toMatchObject({
        status: 'unknown_delivery',
      });
      const completion = {
        ...step,
        type: 'completion' as const,
        lastAssistantContent: 'final answer',
      };
      await expect(service.handleCallback(completion)).resolves.toEqual({ status: 'delivered' });
      await expect(service.handleCallback(completion)).resolves.toEqual({ status: 'skipped' });
      expect(mockEditMessage).toHaveBeenCalledTimes(1);
      expect(mockCreateMessage).toHaveBeenCalledTimes(1);
      expect(mockCreateMessage).toHaveBeenCalledWith('final answer');
    });

    it('does not retry an uncertain final create after an uncertain progress edit', async () => {
      const step = makeBody({ shouldContinue: true, stepType: 'call_tool' });
      mockEditMessage.mockRejectedValueOnce(new Error('progress timeout'));
      await expect(service.handleCallback(step)).rejects.toMatchObject({
        status: 'unknown_delivery',
      });
      mockCreateMessage.mockRejectedValueOnce(new Error('final create timeout'));
      const completion = { ...step, type: 'completion' as const, lastAssistantContent: 'answer' };
      await expect(service.handleCallback(completion)).rejects.toMatchObject({
        status: 'unknown_delivery',
      });
      await expect(service.handleCallback(completion)).rejects.toMatchObject({
        status: 'unknown_delivery',
      });
      expect(mockEditMessage).toHaveBeenCalledTimes(1);
      expect(mockCreateMessage).toHaveBeenCalledTimes(1);
    });

    it('a late progress response cannot overwrite completion ledger ownership or resend the final reply', async () => {
      vi.useFakeTimers();
      try {
        let finishProgress!: () => void;
        let notifyStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          notifyStarted = resolve;
        });
        mockEditMessage.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishProgress = resolve;
              notifyStarted();
            }),
        );
        const step = makeBody({ shouldContinue: true, stepType: 'call_tool' });
        const oldWorker = service.handleCallback(step);
        await started;
        // Simulate a suspended worker: lease expires without its heartbeat running.
        vi.setSystemTime(Date.now() + CALLBACK_LEASE_MS + 1);
        const completion = {
          ...step,
          type: 'completion' as const,
          lastAssistantContent: 'final answer',
        };
        await expect(new BotCallbackService(FAKE_DB).handleCallback(completion)).resolves.toEqual({
          status: 'delivered',
        });
        finishProgress();
        await expect(oldWorker).rejects.toMatchObject({ status: 'lease_lost' });
        await expect(service.handleCallback(completion)).resolves.toEqual({ status: 'skipped' });
        expect(mockCreateMessage).toHaveBeenCalledTimes(1);
        expect(mockEditMessage).toHaveBeenCalledTimes(1);
        expect(mockTriggerTyping).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('still delivers final content when gateway stopTyping fails', async () => {
      const gateway = getMessageGatewayClient();
      (gateway as any).isEnabled = true;
      vi.mocked(gateway.stopTyping).mockRejectedValueOnce(new Error('network secret'));
      const body = makeBody({ type: 'completion', lastAssistantContent: 'final answer' });
      await expect(service.handleCallback(body)).resolves.toEqual({ status: 'delivered' });
      expect(mockEditMessage).toHaveBeenCalledWith('progress-msg-1', 'final answer');
      await expect(service.handleCallback(body)).resolves.toEqual({ status: 'skipped' });
      expect(mockEditMessage).toHaveBeenCalledTimes(1);
    });

    it('does not let failed step typing poison the later final reply', async () => {
      const body = makeBody({ shouldContinue: true, stepType: 'call_tool' });
      mockTriggerTyping.mockRejectedValueOnce(new Error('typing failed'));
      await expect(service.handleCallback(body)).resolves.toEqual({ status: 'delivered' });
      await expect(
        service.handleCallback({
          ...body,
          type: 'completion',
          lastAssistantContent: 'final answer',
        }),
      ).resolves.toEqual({ status: 'delivered' });
      expect(mockEditMessage).toHaveBeenLastCalledWith('progress-msg-1', 'final answer');
    });

    it('does not let failed step reactions poison the later final reply', async () => {
      const body = makeBody({ shouldContinue: true, userMessageId: 'user', stepType: 'call_tool' });
      mockReplaceReaction.mockRejectedValueOnce(new Error('reaction failed'));
      await expect(service.handleCallback(body)).resolves.toEqual({ status: 'delivered' });
      await expect(
        service.handleCallback({
          ...body,
          type: 'completion',
          lastAssistantContent: 'final answer',
        }),
      ).resolves.toEqual({ status: 'delivered' });
      expect(mockEditMessage).toHaveBeenLastCalledWith('progress-msg-1', 'final answer');
    });

    it('does not turn a title rename failure into a failed final delivery', async () => {
      mockFindById.mockResolvedValueOnce({ title: '' });
      mockGenerateTopicTitle.mockResolvedValueOnce('title');
      mockUpdateThreadName.mockRejectedValueOnce(new Error('rename failed'));
      const body = makeBody({
        type: 'completion',
        lastAssistantContent: 'answer',
        userId: 'user',
        topicId: 'topic',
        userPrompt: 'prompt',
      });
      await expect(service.handleCallback(body)).resolves.toEqual({ status: 'delivered' });
      await expect(service.handleCallback(body)).resolves.toEqual({ status: 'skipped' });
      expect(mockEditMessage).toHaveBeenCalledTimes(1);
    });

    it('fails closed in queue mode without Redis before loading credentials or sending', async () => {
      vi.mocked(isQueueAgentRuntimeEnabled).mockReturnValue(true);
      await expect(
        service.handleCallback(makeBody({ type: 'completion', lastAssistantContent: 'done' })),
      ).rejects.toMatchObject({ status: 'backend_unavailable' });
      expect(mockFindByPlatformAndAppId).not.toHaveBeenCalled();
      expect(mockCreateMessage).not.toHaveBeenCalled();
    });

    it('uses create once on a non-edit platform, never probes edit or duplicates completion', async () => {
      const body = makeBody({
        type: 'completion',
        platformThreadId: 'qq:thread',
        lastAssistantContent: 'done',
      });
      await service.handleCallback(body);
      await service.handleCallback(body);
      expect(mockEditMessage).not.toHaveBeenCalled();
      expect(mockCreateMessage).toHaveBeenCalledTimes(1);
    });

    it('skips duplicate completion even if reason or hookId changes', async () => {
      const body = makeBody({ type: 'completion', lastAssistantContent: 'done' });
      await service.handleCallback(body);
      expect(
        await new BotCallbackService(FAKE_DB).handleCallback({
          ...body,
          reason: 'error',
          hookId: 'other',
        }),
      ).toEqual({ status: 'skipped' });
      expect(mockEditMessage).toHaveBeenCalledTimes(1);
    });

    it('ignores late steps after completion, including progress, reactions and typing', async () => {
      const body = makeBody({ type: 'completion', lastAssistantContent: 'done' });
      await service.handleCallback(body);
      vi.clearAllMocks();
      expect(
        await service.handleCallback({
          ...body,
          type: 'step',
          stepIndex: 99,
          shouldContinue: true,
          userMessageId: 'user',
        }),
      ).toEqual({ status: 'skipped' });
      expect(mockFindByPlatformAndAppId).not.toHaveBeenCalled();
      expect(mockEditMessage).not.toHaveBeenCalled();
      expect(mockReplaceReaction).not.toHaveBeenCalled();
      expect(mockTriggerTyping).not.toHaveBeenCalled();
    });

    it('isolates identical operation/thread IDs across applications and users', async () => {
      const body = makeBody({ type: 'completion', lastAssistantContent: 'done', userId: 'u1' });
      await service.handleCallback(body);
      await service.handleCallback({ ...body, applicationId: 'other-app' });
      await service.handleCallback({ ...body, userId: 'u2' });
      expect(mockEditMessage).toHaveBeenCalledTimes(3);
    });

    it('does not send duplicates on non-edit platforms after ambiguous create', async () => {
      const body = makeBody({
        type: 'completion',
        progressMessageId: undefined,
        lastAssistantContent: 'done',
      });
      mockCreateMessage.mockRejectedValueOnce(new Error('connection reset after send'));
      await expect(service.handleCallback(body)).rejects.toMatchObject({
        status: 'unknown_delivery',
      });
      await expect(new BotCallbackService(FAKE_DB).handleCallback(body)).rejects.toMatchObject({
        status: 'unknown_delivery',
      });
      expect(mockCreateMessage).toHaveBeenCalledTimes(1);
      expect(mockEditMessage).not.toHaveBeenCalled();
    });
  });

  // ==================== Message splitting ====================

  describe('message splitting', () => {
    it('should split long messages into multiple chunks', async () => {
      const longContent = 'A'.repeat(3000);

      const body = makeBody({
        lastAssistantContent: longContent,
        reason: 'completed',
        type: 'completion',
      });

      await service.handleCallback(body);

      // First chunk via editMessage, additional chunks via createMessage
      expect(mockEditMessage).toHaveBeenCalledTimes(1);
      expect(mockCreateMessage).toHaveBeenCalled();
    });

    it('should use custom charLimit from provider settings', async () => {
      setupCredentials(FAKE_CREDENTIALS, { settings: { charLimit: 4000 } });

      // Content just over default 1800 but under 4000 should NOT split
      const mediumContent = 'B'.repeat(2500);

      const body = makeTelegramBody({
        lastAssistantContent: mediumContent,
        reason: 'completed',
        type: 'completion',
      });

      await service.handleCallback(body);

      // Should be single message (4000 limit), so only editMessage
      expect(mockEditMessage).toHaveBeenCalledTimes(1);
      expect(mockCreateMessage).not.toHaveBeenCalled();
    });

    it('should split messages that exceed custom charLimit', async () => {
      setupCredentials(FAKE_CREDENTIALS, { settings: { charLimit: 4000 } });
      const longContent = 'C'.repeat(6000);

      const body = makeTelegramBody({
        lastAssistantContent: longContent,
        reason: 'completed',
        type: 'completion',
      });

      await service.handleCallback(body);

      expect(mockEditMessage).toHaveBeenCalledTimes(1);
      expect(mockCreateMessage).toHaveBeenCalled();
    });
  });

  // ==================== Eyes reaction removal ====================

  describe('removeEyesReaction', () => {
    it('should remove eyes reaction on completion', async () => {
      const body = makeBody({
        lastAssistantContent: 'Done.',
        reason: 'completed',
        type: 'completion',
        userMessageId: 'user-msg-1',
      });

      await service.handleCallback(body);

      expect(mockRemoveReaction).toHaveBeenCalledWith('user-msg-1', '👀');
    });

    it('should skip reaction removal when no userMessageId', async () => {
      const body = makeBody({
        lastAssistantContent: 'Done.',
        reason: 'completed',
        type: 'completion',
      });

      await service.handleCallback(body);

      expect(mockRemoveReaction).not.toHaveBeenCalled();
    });

    it('should remove reaction for Telegram using messenger', async () => {
      const body = makeTelegramBody({
        lastAssistantContent: 'Done.',
        reason: 'completed',
        type: 'completion',
        userMessageId: 'telegram:chat-456:789',
      });

      await service.handleCallback(body);

      expect(mockRemoveReaction).toHaveBeenCalledWith('telegram:chat-456:789', '👀');
    });

    it('should preserve delivered message status when best-effort reaction removal fails', async () => {
      mockRemoveReaction.mockRejectedValueOnce(new Error('Reaction not found'));

      const body = makeBody({
        lastAssistantContent: 'Done.',
        reason: 'completed',
        type: 'completion',
        userMessageId: 'user-msg-1',
      });

      await expect(service.handleCallback(body)).resolves.toEqual({
        status: 'delivered',
      });
    });
  });

  // ==================== Topic title summarization ====================

  describe('topic title summarization', () => {
    it('should summarize topic title on successful completion', async () => {
      mockFindById.mockResolvedValue({ title: null });
      mockGenerateTopicTitle.mockResolvedValue('Generated Topic Title');
      mockTopicUpdate.mockResolvedValue(undefined);

      const body = makeBody({
        lastAssistantContent: 'Here is the answer.',
        reason: 'completed',
        topicId: 'topic-1',
        type: 'completion',
        userId: 'user-1',
        userPrompt: 'What is the meaning of life?',
      });

      await service.handleCallback(body);

      await vi.waitFor(() => {
        expect(mockFindById).toHaveBeenCalledWith('topic-1');
      });

      await vi.waitFor(() => {
        expect(mockGenerateTopicTitle).toHaveBeenCalledWith({
          lastAssistantContent: 'Here is the answer.',
          userPrompt: 'What is the meaning of life?',
        });
      });

      await vi.waitFor(() => {
        expect(mockTopicUpdate).toHaveBeenCalledWith('topic-1', {
          title: 'Generated Topic Title',
        });
      });
    });

    it('should not summarize when topic already has a title', async () => {
      mockFindById.mockResolvedValue({ title: 'Existing Title' });

      const body = makeBody({
        lastAssistantContent: 'Here is the answer.',
        reason: 'completed',
        topicId: 'topic-1',
        type: 'completion',
        userId: 'user-1',
        userPrompt: 'What is the meaning of life?',
      });

      await service.handleCallback(body);

      await vi.waitFor(() => {
        expect(mockFindById).toHaveBeenCalledWith('topic-1');
      });

      expect(mockGenerateTopicTitle).not.toHaveBeenCalled();
    });

    it('should skip summarization when reason is error', async () => {
      const body = makeBody({
        errorMessage: 'Failed',
        lastAssistantContent: 'partial',
        reason: 'error',
        topicId: 'topic-1',
        type: 'completion',
        userId: 'user-1',
        userPrompt: 'test',
      });

      await service.handleCallback(body);

      // Wait a tick to ensure no async work was started
      await new Promise((r) => setTimeout(r, 50));
      expect(mockFindById).not.toHaveBeenCalled();
    });

    it('should skip summarization when reason is interrupted', async () => {
      const body = makeBody({
        lastAssistantContent: 'partial',
        reason: 'interrupted',
        topicId: 'topic-1',
        type: 'completion',
        userId: 'user-1',
        userPrompt: 'test',
      });

      await service.handleCallback(body);

      await new Promise((r) => setTimeout(r, 50));
      expect(mockFindById).not.toHaveBeenCalled();
      expect(mockGenerateTopicTitle).not.toHaveBeenCalled();
      expect(mockTopicUpdate).not.toHaveBeenCalled();
    });

    it('should skip summarization when topicId is missing', async () => {
      const body = makeBody({
        lastAssistantContent: 'Done.',
        reason: 'completed',
        type: 'completion',
        userId: 'user-1',
        userPrompt: 'test',
      });

      await service.handleCallback(body);

      await new Promise((r) => setTimeout(r, 50));
      expect(mockFindById).not.toHaveBeenCalled();
    });

    it('should skip summarization when userId is missing', async () => {
      const body = makeBody({
        lastAssistantContent: 'Done.',
        reason: 'completed',
        topicId: 'topic-1',
        type: 'completion',
        userPrompt: 'test',
      });

      await service.handleCallback(body);

      await new Promise((r) => setTimeout(r, 50));
      expect(mockFindById).not.toHaveBeenCalled();
    });

    it('should update thread name after generating title', async () => {
      mockFindById.mockResolvedValue({ title: null });
      mockGenerateTopicTitle.mockResolvedValue('New Title');
      mockTopicUpdate.mockResolvedValue(undefined);

      const body = makeBody({
        lastAssistantContent: 'Answer.',
        platformThreadId: 'discord:guild:channel-id:thread-id',
        reason: 'completed',
        topicId: 'topic-1',
        type: 'completion',
        userId: 'user-1',
        userPrompt: 'Question?',
      });

      await service.handleCallback(body);

      await vi.waitFor(() => {
        expect(mockUpdateThreadName).toHaveBeenCalledWith('New Title');
      });
    });

    it('should not update thread name when generated title is empty', async () => {
      mockFindById.mockResolvedValue({ title: null });
      mockGenerateTopicTitle.mockResolvedValue('');
      mockTopicUpdate.mockResolvedValue(undefined);

      const body = makeBody({
        lastAssistantContent: 'Answer.',
        platformThreadId: 'discord:guild:channel-id:thread-id',
        reason: 'completed',
        topicId: 'topic-1',
        type: 'completion',
        userId: 'user-1',
        userPrompt: 'Question?',
      });

      await service.handleCallback(body);

      // Wait for async chain
      await new Promise((r) => setTimeout(r, 50));
      expect(mockTopicUpdate).not.toHaveBeenCalled();
      expect(mockUpdateThreadName).not.toHaveBeenCalled();
    });
  });

  // ==================== Completion + reaction + summarization flow ====================

  describe('full completion flow', () => {
    it('should execute completion, reaction removal, and topic summarization', async () => {
      mockFindById.mockResolvedValue({ title: null });
      mockGenerateTopicTitle.mockResolvedValue('Summary Title');
      mockTopicUpdate.mockResolvedValue(undefined);

      const body = makeBody({
        cost: 0.01,
        lastAssistantContent: 'Complete answer.',
        reason: 'completed',
        topicId: 'topic-1',
        type: 'completion',
        userId: 'user-1',
        userMessageId: 'user-msg-1',
        userPrompt: 'Tell me something.',
      });

      await service.handleCallback(body);

      // Completion: edit message
      expect(mockEditMessage).toHaveBeenCalled();

      // Reaction removal
      expect(mockRemoveReaction).toHaveBeenCalled();

      // Topic summarization (async)
      await vi.waitFor(() => {
        expect(mockTopicUpdate).toHaveBeenCalledWith('topic-1', { title: 'Summary Title' });
      });
    });

    it('should not run reaction removal or summarization for step type', async () => {
      const body = makeBody({
        shouldContinue: true,
        stepType: 'call_llm',
        topicId: 'topic-1',
        type: 'step',
        userId: 'user-1',
        userMessageId: 'user-msg-1',
        userPrompt: 'test',
      });

      await service.handleCallback(body);

      expect(mockRemoveReaction).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 50));
      expect(mockFindById).not.toHaveBeenCalled();
    });
  });

  describe('hook-based webhook payload compatibility', () => {
    // These tests verify that payloads from HookDispatcher (which include
    // hookId/hookType fields) are handled correctly by BotCallbackService.
    // This is the critical contract between the hooks framework and the bot callback.

    it('should handle step payload with hookId and hookType fields', async () => {
      const body = makeBody({
        content: 'thinking...',
        executionTimeMs: 100,
        hookId: 'bot-step-progress',
        hookType: 'afterStep',
        shouldContinue: true,
        stepType: 'call_llm' as const,
        thinking: true,
        totalCost: 0.01,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalSteps: 1,
        totalTokens: 150,
        type: 'step',
      });

      await service.handleCallback(body);

      expect(mockEditMessage).toHaveBeenCalledWith('progress-msg-1', expect.any(String));
    });

    it('should handle completion payload with hookId and hookType fields', async () => {
      const body = makeBody({
        cost: 0.05,
        duration: 5000,
        hookId: 'bot-completion',
        hookType: 'onComplete',
        lastAssistantContent: 'Here is the answer',
        llmCalls: 3,
        reason: 'done',
        toolCalls: 2,
        totalTokens: 500,
        type: 'completion',
        userId: 'user-1',
        userPrompt: 'test question',
      });

      await service.handleCallback(body);

      expect(mockEditMessage).toHaveBeenCalledWith(
        'progress-msg-1',
        expect.stringContaining('Here is the answer'),
      );
    });

    it('should handle completion error payload from hooks', async () => {
      const body = makeBody({
        errorMessage: 'Rate limit exceeded',
        hookId: 'bot-completion',
        hookType: 'onComplete',
        operationId: 'op-hook-1',
        reason: 'error',
        type: 'completion',
      });

      await service.handleCallback(body);

      expect(mockEditMessage).toHaveBeenCalledWith(
        'progress-msg-1',
        expect.stringContaining('op-hook-1'),
      );
      expect(mockEditMessage).toHaveBeenCalledWith(
        'progress-msg-1',
        expect.not.stringContaining('Rate limit exceeded'),
      );
    });
  });
});
