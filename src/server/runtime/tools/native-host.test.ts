import type { ChatToolPayload } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolExecutionContext } from '@/server/services/toolExecution/types';

import { CordisAtomicHost } from '../cordis-atomic-host';
import { CordisToolBridge } from './bridge';
import { createBuiltinToolsPlugin } from './builtin-plugin';
import { createMcpPluginManifest } from './mcp-plugin';
import type { McpClientLike } from './types';

describe('QZ-CORDIS-F Native Host Integration', () => {
  let host: CordisAtomicHost;

  beforeEach(() => {
    host = new CordisAtomicHost();
  });

  afterEach(async () => {
    await host.dispose();
  });

  const buildPayload = (
    apiName: string,
    argsStr: string,
    identifier = 'test',
  ): ChatToolPayload => ({
    apiName,
    arguments: argsStr,
    id: 'call_1',
    identifier,
    type: 'builtin' as const,
  });

  const baseContext: ToolExecutionContext = {
    toolManifestMap: {},
    userId: 'user-root',
  };

  describe('[1] builtin execution with trusted context', () => {
    it('executes builtin tool with trusted context and protects against payload overwriting', async () => {
      const capturedContexts: ToolExecutionContext[] = [];
      const mockHandler = vi.fn(async (args: unknown, context: ToolExecutionContext) => {
        capturedContexts.push(context);
        const record = args as Record<string, unknown>;
        return {
          content: `Sum: ${Number(record.a) + Number(record.b)}, user: ${context.userId}`,
          success: true,
        };
      });

      const plugin = createBuiltinToolsPlugin({
        id: 'math',
        tools: [
          {
            apiName: 'add',
            description: 'Add two numbers',
            handler: mockHandler,
            identifier: 'calculator',
          },
        ],
      });

      await host.mount(plugin);

      const bridge = new CordisToolBridge({
        context: host.context,
        toolRegistry: host.tools,
      });

      expect(bridge.hasTool('calculator', 'add')).toBe(true);

      const trustedContext: ToolExecutionContext = {
        activeDeviceId: 'device-1',
        agentId: 'agent-42',
        documentId: 'doc-55',
        groupId: 'group-7',
        messageId: 'msg-100',
        operationId: 'op-99',
        toolManifestMap: {},
        topicId: 'topic-88',
        userId: 'trusted-user-123',
      };

      // Payload contains an attacker attempt to overwrite trusted fields
      const maliciousPayload = buildPayload(
        'add',
        JSON.stringify({ a: 7, b: 3, agentId: 'hacked-agent', userId: 'attacker' }),
        'calculator',
      );

      const result = await bridge.execute(maliciousPayload, trustedContext);

      expect(result.success).toBe(true);
      expect(result.content).toBe('Sum: 10, user: trusted-user-123');
      expect(mockHandler).toHaveBeenCalledTimes(1);

      // Verify handler received the trusted context, not the spoofed arguments
      expect(capturedContexts).toHaveLength(1);
      const invokedCtx = capturedContexts[0];
      expect(invokedCtx.userId).toBe('trusted-user-123');
      expect(invokedCtx.agentId).toBe('agent-42');
      expect(invokedCtx.topicId).toBe('topic-88');
      expect(invokedCtx.documentId).toBe('doc-55');
    });
  });

  describe('[2] MCP lifecycle, failure recovery, and staging rejection', () => {
    it('mounts MCP tools, executes them, and cleans up client exactly once on unmount', async () => {
      const disconnectMock = vi.fn();
      const callToolMock = vi.fn(async (name: string, args: unknown) => ({
        content: [{ text: `Result of ${name}: ${JSON.stringify(args)}`, type: 'text' }],
        isError: false,
      }));

      const mockClient: McpClientLike = {
        callTool: callToolMock,
        disconnect: disconnectMock,
        listTools: vi.fn(async () => [
          {
            description: 'Fetch URL',
            inputSchema: { type: 'object' },
            name: 'fetch',
          },
        ]),
      };

      const plugin = createMcpPluginManifest({
        clientFactory: () => mockClient,
        clientParams: { args: [], command: 'node', name: 'webFetcher', type: 'stdio' },
        id: 'webFetcher',
      });

      const instance = await host.mount(plugin);
      expect(instance.state).toBe('active');

      const bridge = new CordisToolBridge({
        context: host.context,
        toolRegistry: host.tools,
      });

      expect(bridge.hasTool('webFetcher', 'fetch')).toBe(true);

      const payload = buildPayload(
        'fetch',
        JSON.stringify({ url: 'https://example.com' }),
        'webFetcher',
      );
      const result = await bridge.execute(payload, baseContext);

      expect(result.success).toBe(true);
      expect(result.content).toContain('https://example.com');
      expect(callToolMock).toHaveBeenCalledWith('fetch', { url: 'https://example.com' });

      // Unmount / dispose instance
      await instance.dispose();

      // Tool should be unregistered from registry
      expect(bridge.hasTool('webFetcher', 'fetch')).toBe(false);
      // Disconnect must have been called exactly once
      expect(disconnectMock).toHaveBeenCalledTimes(1);
    });

    it('disconnects MCP client exactly once when listTools fails during mount', async () => {
      const disconnectMock = vi.fn();
      const failingClient: McpClientLike = {
        callTool: vi.fn(),
        disconnect: disconnectMock,
        listTools: vi.fn(async () => {
          throw new Error('MCP server connection timed out');
        }),
      };

      const plugin = createMcpPluginManifest({
        clientFactory: () => failingClient,
        clientParams: { args: [], command: 'node', name: 'brokenServer', type: 'stdio' },
        id: 'brokenServer',
      });

      await expect(host.mount(plugin)).rejects.toThrow('MCP server connection timed out');

      // Failure cleanup by host must invoke client disconnect exactly once
      expect(disconnectMock).toHaveBeenCalledTimes(1);
      expect(host.tools.list().map((t) => t.name)).not.toContain('brokenServer:broken');
    });

    it('disconnects MCP client exactly once when allowEmptyTools is false and no tools returned', async () => {
      const disconnectMock = vi.fn();
      const emptyClient: McpClientLike = {
        callTool: vi.fn(),
        disconnect: disconnectMock,
        listTools: vi.fn(async () => []),
      };

      const plugin = createMcpPluginManifest({
        allowEmptyTools: false,
        clientFactory: () => emptyClient,
        clientParams: { args: [], command: 'node', name: 'emptyServer', type: 'stdio' },
        id: 'emptyServer',
      });

      await expect(host.mount(plugin)).rejects.toThrow(/returned no tools/);
      expect(disconnectMock).toHaveBeenCalledTimes(1);
    });

    it('rejects staged MCP mount because staged provide is unsupported and disconnects client once', async () => {
      // First mount a stable service to ensure existing providers remain intact
      const stableClient: McpClientLike = {
        callTool: vi.fn(async () => 'stable-result'),
        disconnect: vi.fn(),
        listTools: vi.fn(async () => [{ name: 'stableTool' }]),
      };
      const stablePlugin = createMcpPluginManifest({
        clientFactory: () => stableClient,
        clientParams: { args: [], command: 'node', name: 'stableServer', type: 'stdio' },
        id: 'stableServer',
      });
      await host.mount(stablePlugin);
      expect(host.context.has('mcp.client.stableServer')).toBe(true);

      const stagedDisconnectMock = vi.fn();
      const stagedClient: McpClientLike = {
        callTool: vi.fn(),
        disconnect: stagedDisconnectMock,
        listTools: vi.fn(async () => [{ name: 'stagedTool' }]),
      };

      const stagedPlugin = createMcpPluginManifest({
        clientFactory: () => stagedClient,
        clientParams: { args: [], command: 'node', name: 'stagedServer', type: 'stdio' },
        id: 'stagedServer',
      });

      // Mount in staged mode (second argument staged = true)
      await expect(host.mount(stagedPlugin, true)).rejects.toThrow(
        /Staged tool candidates cannot publish services/,
      );

      // Staged client must be disconnected exactly once
      expect(stagedDisconnectMock).toHaveBeenCalledTimes(1);
      // Existing stable provider must be unaffected
      expect(host.context.has('mcp.client.stableServer')).toBe(true);
      expect(host.tools.list().map((t) => t.name)).not.toContain('stagedServer:stagedTool');
    });

    it('handles factory race condition: disconnects late client once and skips listTools when disposed mid-factory', async () => {
      let resolveStarted!: () => void;
      const factoryStarted = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });

      let resolveFactory!: (client: McpClientLike) => void;
      const factoryPromise = new Promise<McpClientLike>((resolve) => {
        resolveFactory = resolve;
      });

      const disconnectMock = vi.fn();
      const listToolsMock = vi.fn(async () => [{ name: 'delayedTool' }]);

      const delayedClient: McpClientLike = {
        callTool: vi.fn(),
        disconnect: disconnectMock,
        listTools: listToolsMock,
      };

      const plugin = createMcpPluginManifest({
        clientFactory: () => {
          resolveStarted();
          return factoryPromise;
        },
        clientParams: { args: [], command: 'node', name: 'delayedServer', type: 'stdio' },
        id: 'delayedServer',
      });

      // Start mounting delayed plugin and observe outcome
      const mountPromise = host.mount(plugin);
      const mountOutcome = mountPromise.then(
        (v) => ({ error: undefined, value: v }),
        (e) => ({ error: e, value: undefined }),
      );

      // Await factory start
      await factoryStarted;

      // Initiate disposal without awaiting to avoid artificial deadlocks
      const disposal = host.dispose();

      try {
        // Resolve factory with the delayed client
        resolveFactory(delayedClient);

        // Await disposal and mount outcome
        await disposal;
        const outcome = await mountOutcome;

        // Mount must have failed
        expect(outcome.error).toBeDefined();

        // Client must be disconnected exactly once
        expect(disconnectMock).toHaveBeenCalledTimes(1);

        // listTools must NOT have been called after teardown
        expect(listToolsMock).not.toHaveBeenCalled();
      } finally {
        resolveFactory(delayedClient);
      }
    });
  });

  describe('[3] JSON error handling', () => {
    it('does not invoke tool when arguments JSON is malformed', async () => {
      const handlerSpy = vi.fn();
      const plugin = createBuiltinToolsPlugin({
        id: 'echo-plugin',
        tools: [
          {
            apiName: 'echo',
            handler: handlerSpy,
            identifier: 'echoService',
          },
        ],
      });
      await host.mount(plugin);

      const bridge = new CordisToolBridge({
        context: host.context,
        toolRegistry: host.tools,
      });

      const malformedPayload = buildPayload('echo', '{query: "test"}', 'echoService');
      const result = await bridge.execute(malformedPayload, baseContext);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_JSON_ARGUMENTS');
      expect(handlerSpy).not.toHaveBeenCalled();
    });

    it('does not invoke tool and reports TRUNCATED_ARGUMENTS when JSON is cut mid-string', async () => {
      const handlerSpy = vi.fn();
      const plugin = createBuiltinToolsPlugin({
        id: 'writer-plugin',
        tools: [
          {
            apiName: 'write',
            handler: handlerSpy,
            identifier: 'writer',
          },
        ],
      });
      await host.mount(plugin);

      const bridge = new CordisToolBridge({
        context: host.context,
        toolRegistry: host.tools,
      });

      const truncatedPayload = buildPayload(
        'write',
        '{"content": "This is a long text that got cut off midwa',
        'writer',
      );
      const result = await bridge.execute(truncatedPayload, baseContext);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TRUNCATED_ARGUMENTS');
      expect(result.content).toContain('possibly by extended-thinking tokens');
      expect(handlerSpy).not.toHaveBeenCalled();
    });
  });

  describe('[4] cross-scope isolation', () => {
    it('isolates scoped tools and rejects cross-scope execution without calling fallback', async () => {
      const scopeA = host.context.withScope('tenant-A');
      const scopedHandler = vi.fn(async () => ({
        content: 'vault-secret-data',
        success: true,
      }));

      // Register scoped tool using a manual scope owner
      host.tools.register(scopeA, {
        description: 'Tenant A Secret Vault',
        execute: scopedHandler,
        inputSchema: {},
        name: 'vault:getSecret',
      });

      // Register global tool
      const globalHandler = vi.fn(async () => ({
        content: 'public-service-data',
        success: true,
      }));
      host.tools.register(host.context, {
        description: 'Public common service',
        execute: globalHandler,
        inputSchema: {},
        name: 'common:info',
      });

      const fallbackSpy = vi.fn(async () => ({
        content: 'should-not-be-called',
        success: true,
      }));

      const bridge = new CordisToolBridge({
        context: host.context,
        fallbackExecutor: fallbackSpy,
        toolRegistry: host.tools,
      });

      // Discovery checks:
      // Scoped tool is discoverable ONLY by the matching scope
      expect(bridge.hasTool('vault', 'getSecret', 'tenant-A')).toBe(true);
      expect(bridge.hasTool('vault', 'getSecret', 'tenant-B')).toBe(false);
      expect(bridge.hasTool('vault', 'getSecret')).toBe(false);

      // Global tool is discoverable by any scope and without scope
      expect(bridge.hasTool('common', 'info', 'tenant-A')).toBe(true);
      expect(bridge.hasTool('common', 'info', 'tenant-B')).toBe(true);
      expect(bridge.hasTool('common', 'info')).toBe(true);

      // Execution checks:
      // 1. Cross-scope call from tenant-B MUST NOT invoke scoped tool and MUST NOT fall back
      const payloadSecret = buildPayload('getSecret', '{}', 'vault');
      const contextTenantB: ToolExecutionContext = {
        ...baseContext,
        scope: 'tenant-B',
      };
      const crossResult = await bridge.execute(payloadSecret, contextTenantB);
      expect(crossResult.success).toBe(false);
      expect(crossResult.error?.code).toBe('TOOL_SCOPE_MISMATCH');
      expect(scopedHandler).not.toHaveBeenCalled();
      // Crucial assertion: fallback MUST NOT be invoked to bypass isolation!
      expect(fallbackSpy).not.toHaveBeenCalled();

      // 2. Unscoped caller MUST NOT invoke scoped tool and MUST NOT fall back
      const unscopedResult = await bridge.execute(payloadSecret, baseContext);
      expect(unscopedResult.success).toBe(false);
      expect(unscopedResult.error?.code).toBe('TOOL_SCOPE_MISMATCH');
      expect(scopedHandler).not.toHaveBeenCalled();
      expect(fallbackSpy).not.toHaveBeenCalled();

      // 3. Matching scope caller successfully invokes scoped tool
      const contextTenantA: ToolExecutionContext = {
        ...baseContext,
        scope: 'tenant-A',
      };
      const allowedResult = await bridge.execute(payloadSecret, contextTenantA);
      expect(allowedResult.success).toBe(true);
      expect(allowedResult.content).toBe('vault-secret-data');
      expect(scopedHandler).toHaveBeenCalledTimes(1);

      // 4. Global tool is executable from all scopes
      const payloadGlobal = buildPayload('info', '{}', 'common');
      const globalResA = await bridge.execute(payloadGlobal, contextTenantA);
      expect(globalResA.success).toBe(true);
      expect(globalResA.content).toBe('public-service-data');

      const globalResB = await bridge.execute(payloadGlobal, contextTenantB);
      expect(globalResB.success).toBe(true);
      expect(globalResB.content).toBe('public-service-data');
      expect(globalHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe('[5] fallback executor for unknown and inaccessible tools', () => {
    it('delegates unknown tools to fallbackExecutor when configured without requiring bridge context', async () => {
      const fallbackMock = vi.fn(async (payload, context) => ({
        content: `fallback handled: ${payload.apiName} for ${context.userId}`,
        success: true,
      }));

      // No context provided: fallback works without runtimeContext
      const bridge = new CordisToolBridge({
        fallbackExecutor: fallbackMock,
        toolRegistry: host.tools,
      });

      expect(bridge.hasTool('legacyModule', 'perform')).toBe(false);

      const payload = buildPayload('perform', '{"action": "migrate"}', 'legacyModule');
      const result = await bridge.execute(payload, baseContext);

      expect(result.success).toBe(true);
      expect(result.content).toBe('fallback handled: perform for user-root');
      expect(fallbackMock).toHaveBeenCalledWith(payload, baseContext);
    });

    it('returns TOOL_NOT_FOUND when tool is unknown and no fallbackExecutor is configured', async () => {
      const bridge = new CordisToolBridge({
        context: host.context,
        toolRegistry: host.tools,
      });

      const payload = buildPayload('unknownOp', '{}', 'ghost');
      const result = await bridge.execute(payload, baseContext);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TOOL_NOT_FOUND');
      expect(result.content).toContain('ghost:unknownOp');
    });
  });
});
