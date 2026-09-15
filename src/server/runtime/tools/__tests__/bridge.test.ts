import type { ChatToolPayload } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Context } from '../../../../../packages/cordis-kernel/src/context';
import { ToolRegistry } from '../../../../../packages/cordis-kernel/src/tool';
import { CordisToolBridge } from '../bridge';

describe('CordisToolBridge', () => {
  let context: Context;
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    context = new Context();
    toolRegistry = new ToolRegistry();
  });

  const buildPayload = (
    apiName: string,
    argsStr: string,
    identifier = 'test',
  ): ChatToolPayload => ({
    apiName,
    arguments: argsStr,
    id: 't1',
    identifier,
    type: 'builtin' as const,
  });

  const toolContext = {
    toolManifestMap: {},
    userId: 'user-1',
  };

  it('dispatches tool calls to registered Cordis tools with derived runtime context', async () => {
    const mockHandler = vi.fn(async (args: unknown, _ctx?: unknown) => {
      const record = args as { name: string };
      return {
        content: `Hello ${record.name}`,
        success: true,
      };
    });

    toolRegistry.register(context, {
      description: 'Greet user',
      execute: mockHandler,
      inputSchema: {},
      name: 'greeter:sayHello',
    });

    const bridge = new CordisToolBridge({ context, toolRegistry });
    expect(bridge.hasTool('greeter', 'sayHello')).toBe(true);

    const result = await bridge.execute(
      buildPayload('sayHello', '{"name": "Alice"}', 'greeter'),
      toolContext,
    );

    expect(result.success).toBe(true);
    expect(result.content).toBe('Hello Alice');
    expect(mockHandler).toHaveBeenCalledWith(
      { name: 'Alice' },
      expect.objectContaining({ userId: 'user-1' }),
    );

    const passedCtx = mockHandler.mock.calls[0][1] as Record<string, unknown>;
    expect(passedCtx).not.toBe(toolContext);
    expect(passedCtx.fiber).toBeDefined();
  });

  it('rejects execution of registered tool when bridge context is missing', async () => {
    toolRegistry.register(context, {
      description: 'Echo',
      execute: vi.fn(),
      inputSchema: {},
      name: 'srv:run',
    });

    const bridge = new CordisToolBridge({ toolRegistry });
    const result = await bridge.execute(buildPayload('run', '{}', 'srv'), toolContext);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNSAFE_EXECUTION_CONTEXT');
  });

  it('short-circuits with TRUNCATED_ARGUMENTS when JSON is cut mid-object', async () => {
    const bridge = new CordisToolBridge({ context, toolRegistry });
    const truncated = '{"query": "LobeHub arch';

    const result = await bridge.execute(
      buildPayload('search', truncated, 'webSearch'),
      toolContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TRUNCATED_ARGUMENTS');
    expect(result.content).toContain(truncated);
  });

  it('short-circuits with INVALID_JSON_ARGUMENTS for malformed JSON', async () => {
    const bridge = new CordisToolBridge({ context, toolRegistry });
    const malformed = '{query: "test"}';

    const result = await bridge.execute(
      buildPayload('search', malformed, 'webSearch'),
      toolContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_JSON_ARGUMENTS');
    expect(result.content).toContain(malformed);
  });

  it('delegates to fallbackExecutor when tool is not registered in Cordis without requiring context', async () => {
    const fallbackMock = vi.fn(async () => ({
      content: 'from fallback',
      success: true,
    }));

    // Fallback executor does not require runtime context
    const bridge = new CordisToolBridge({
      fallbackExecutor: fallbackMock,
      toolRegistry,
    });

    expect(bridge.hasTool('legacy', 'run')).toBe(false);

    const payload = buildPayload('run', '{"foo": "bar"}', 'legacy');
    const result = await bridge.execute(payload, toolContext);

    expect(result.content).toBe('from fallback');
    expect(fallbackMock).toHaveBeenCalledWith(payload, toolContext);
  });

  it('returns TOOL_NOT_FOUND when tool missing and no fallback provided', async () => {
    const bridge = new CordisToolBridge({ context, toolRegistry });
    const result = await bridge.execute(
      buildPayload('unknown', '{}', 'missingService'),
      toolContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TOOL_NOT_FOUND');
  });

  it('catches and normalizes runtime errors thrown by tool handler', async () => {
    toolRegistry.register(context, {
      description: 'Exploder',
      execute: () => {
        throw new Error('Explosion!');
      },
      inputSchema: {},
      name: 'bad:explode',
    });

    const bridge = new CordisToolBridge({ context, toolRegistry });
    const result = await bridge.execute(buildPayload('explode', '{}', 'bad'), toolContext);

    expect(result.success).toBe(false);
    expect(result.content).toBe('Explosion!');
  });

  it('strictly isolates providers so B:search never falls back to A:search alias', async () => {
    const handlerA = vi.fn(async () => 'result-A');
    const handlerB = vi.fn(async () => 'result-B');

    // Provider A registers canonical tool and bare alias
    toolRegistry.register(context, {
      description: 'Provider A search',
      execute: handlerA,
      inputSchema: {},
      name: 'providerA:search',
    });
    toolRegistry.register(context, {
      description: 'Bare search alias from provider A',
      execute: handlerA,
      inputSchema: {},
      name: 'search',
    });

    // Provider B registers canonical tool
    toolRegistry.register(context, {
      description: 'Provider B query',
      execute: handlerB,
      inputSchema: {},
      name: 'providerB:query',
    });

    const fallbackExecutor = vi.fn(async () => ({
      content: 'fallback-for-B',
      success: true,
    }));

    const bridge = new CordisToolBridge({ context, fallbackExecutor, toolRegistry });

    // hasTool with identifier 'providerB' and apiName 'search' must be FALSE
    expect(bridge.hasTool('providerB', 'search')).toBe(false);
    expect(bridge.hasTool('providerA', 'search')).toBe(true);
    expect(bridge.hasTool('', 'search')).toBe(true);

    // Requesting 'providerB:search' must NEVER execute providerA!
    const resultB = await bridge.execute(buildPayload('search', '{}', 'providerB'), toolContext);
    expect(handlerA).not.toHaveBeenCalled();
    expect(fallbackExecutor).toHaveBeenCalled();
    expect(resultB.content).toBe('fallback-for-B');

    // Requesting 'providerA:search' executes provider A
    const resultA = await bridge.execute(buildPayload('search', '{}', 'providerA'), toolContext);
    expect(handlerA).toHaveBeenCalled();
    expect(resultA.content).toBe('result-A');
  });

  it('maps MCP isError: true results to success: false with classified error', async () => {
    toolRegistry.register(context, {
      description: 'MCP failure simulator',
      execute: async () => ({
        content: [{ text: 'File not found on MCP server', type: 'text' }],
        isError: true,
      }),
      inputSchema: {},
      name: 'mcp:read_file',
    });

    const bridge = new CordisToolBridge({ context, toolRegistry });
    const result = await bridge.execute(buildPayload('read_file', '{}', 'mcp'), toolContext);

    expect(result.success).toBe(false);
    expect(result.content).toBe('File not found on MCP server');
    expect(result.error).toMatchObject({
      code: 'MCP_TOOL_ERROR',
      message: 'File not found on MCP server',
    });
  });

  it('maps MCP success results with text content to success: true', async () => {
    toolRegistry.register(context, {
      description: 'MCP success simulator',
      execute: async () => ({
        content: [{ text: 'File content read successfully', type: 'text' }],
        isError: false,
      }),
      inputSchema: {},
      name: 'mcp:read_file_ok',
    });

    const bridge = new CordisToolBridge({ context, toolRegistry });
    const result = await bridge.execute(buildPayload('read_file_ok', '{}', 'mcp'), toolContext);

    expect(result.success).toBe(true);
    expect(result.content).toBe('File content read successfully');
  });
});
