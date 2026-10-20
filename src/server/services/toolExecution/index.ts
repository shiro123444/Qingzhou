import { canonicalToolName, invokeNativeTool } from '@lobechat/cordis-runtime';
import { type ChatToolPayload } from '@lobechat/types';
import { safeParseJSON } from '@lobechat/utils';
import debug from 'debug';

import { type CloudMCPParams, type StdioMCPParams, type ToolCallContent } from '@/libs/mcp';
import { contentBlocksToString } from '@/server/services/mcp/contentProcessor';
import { mcpProxyService } from '@/server/services/mcpProxy';
import {
  DEFAULT_TOOL_RESULT_MAX_LENGTH,
  truncateToolResult,
} from '@/server/utils/truncateToolResult';

import { DiscoverService } from '../discover';
import { type MCPService } from '../mcp';
import { type BuiltinToolsExecutor } from './builtin';
import { classifyToolError } from './errorClassification';
import {
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolExecutionResultResponse,
} from './types';

const log = debug('lobe-server:tool-execution-service');

interface ToolExecutionServiceDeps {
  builtinToolsExecutor: Pick<BuiltinToolsExecutor, 'execute'>;
  mcpService: Pick<MCPService, 'callTool'>;
}

const normalizeExecutionError = (error: unknown, fallbackMessage: string) => {
  const normalized = classifyToolError(error || fallbackMessage);
  const message = fallbackMessage || normalized.message;

  if (error && typeof error === 'object') {
    if (error instanceof Error) {
      return {
        code: normalized.code,
        kind: normalized.kind,
        message: error.message || message,
        name: error.name,
      };
    }

    const plainError = error as Record<string, unknown>;

    return {
      ...plainError,
      code: (plainError.code as string | undefined) || normalized.code,
      kind: normalized.kind,
      message: (plainError.message as string | undefined) || message,
    };
  }

  if (typeof error === 'string') {
    return { code: normalized.code, kind: normalized.kind, message: error };
  }

  return { code: normalized.code, kind: normalized.kind, message };
};

const assertExecutionAllowed = (context: ToolExecutionContext): void => {
  context.assertStepLease?.();
  context.signal?.throwIfAborted();
};

export class ToolExecutionService {
  private builtinToolsExecutor: Pick<BuiltinToolsExecutor, 'execute'>;
  private mcpService: Pick<MCPService, 'callTool'>;

  constructor({ mcpService, builtinToolsExecutor }: ToolExecutionServiceDeps) {
    this.builtinToolsExecutor = builtinToolsExecutor;
    this.mcpService = mcpService;
  }

  async executeTool(
    payload: ChatToolPayload,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResultResponse> {
    assertExecutionAllowed(context);
    const { identifier, apiName, type } = payload;

    log('Executing tool: %s:%s (type: %s)', identifier, apiName, type);

    const startTime = Date.now();
    try {
      const data = await invokeNativeTool<ToolExecutionResult>(
        {
          name: canonicalToolName(identifier, apiName),
          execute: async (input) => {
            assertExecutionAllowed(context);
            const resolvedPayload = {
              ...payload,
              arguments: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
            };
            // The authenticated server context stays in this closure. Cloud MCP,
            // proxy/file handling and builtin authorization remain in their adapters.
            if ((type as string) === 'mcp') return this.executeMCPTool(resolvedPayload, context);
            return this.builtinToolsExecutor.execute(resolvedPayload, context);
          },
        },
        payload.arguments,
      );

      assertExecutionAllowed(context);
      const executionTime = Date.now() - startTime;

      // Truncate result content to prevent context overflow
      // Use agent-specific config if provided, otherwise use default
      const truncatedContent = truncateToolResult(data.content, context.toolResultMaxLength);

      // Log if content was truncated
      if (truncatedContent !== data.content) {
        const maxLength = context.toolResultMaxLength ?? DEFAULT_TOOL_RESULT_MAX_LENGTH;
        log(
          'Tool result truncated for %s:%s - original: %d chars, truncated: %d chars (limit: %d)',
          identifier,
          apiName,
          data.content.length,
          truncatedContent.length,
          maxLength,
        );
      }

      if (!data.success) {
        return {
          ...data,
          content: truncatedContent,
          error: normalizeExecutionError(data.error, data.content),
          executionTime,
        };
      }

      return {
        ...data,
        content: truncatedContent,
        executionTime,
      };

      // Handle MCP and other types (default, standalone, markdown, mcp)
    } catch (error) {
      assertExecutionAllowed(context);
      const executionTime = Date.now() - startTime;
      log('Error executing tool %s:%s: %O', identifier, apiName, error);
      const errorMessage = (error as Error).message;

      return {
        content: truncateToolResult(errorMessage),
        error: normalizeExecutionError(error, errorMessage),
        executionTime,
        success: false,
      };
    }
  }

  private async executeMCPTool(
    payload: ChatToolPayload,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const { identifier, apiName, arguments: args } = payload;

    log('Executing MCP tool: %s:%s', identifier, apiName);

    // Get the manifest from context
    const manifest = context.toolManifestMap[identifier];
    if (!manifest) {
      log('Manifest not found for MCP tool: %s', identifier);
      return {
        content: `Manifest not found for tool: ${identifier}`,
        error: {
          code: 'MANIFEST_NOT_FOUND',
          message: `Manifest not found for tool: ${identifier}`,
        },
        success: false,
      };
    }

    // Extract MCP params from manifest (stored in customParams.mcp in LobeTool)
    const mcpParams = (manifest as any).mcpParams;
    if (!mcpParams) {
      log('MCP configuration not found in manifest for: %s ', identifier);
      return {
        content: `MCP configuration not found for tool: ${identifier}, please tell user TRY TO REINSTALL THE MCP PLUGIN`,
        error: {
          code: 'MCP_CONFIG_NOT_FOUND',
          message: `MCP configuration not found for tool: ${identifier}`,
        },
        success: false,
      };
    }

    log(
      'Calling MCP service with params for: %s:%s (type: %s)',
      identifier,
      apiName,
      mcpParams.type,
    );

    try {
      // Check if this is a cloud MCP endpoint
      if (mcpParams.type === 'cloud') {
        return await this.executeCloudMCPTool(payload, context, mcpParams);
      }

      // Check if this is an MCP Proxy connection (server-side stdio for web clients)
      if ((mcpParams.type as any) === 'mcpProxy') {
        return await this.executeMcpProxyTool(payload, context, mcpParams);
      }

      // For stdio/http/sse types, use standard MCP service
      const result = await this.mcpService.callTool({
        argsStr: args,
        clientParams: mcpParams,
        toolName: apiName,
      });

      log('MCP tool execution successful for: %s:%s', identifier, apiName);

      return {
        content: typeof result === 'string' ? result : JSON.stringify(result),
        state: typeof result === 'object' ? result : undefined,
        success: true,
      };
    } catch (error) {
      log('MCP tool execution failed for %s:%s: %O', identifier, apiName, error);
      return {
        content: (error as Error).message,
        error: {
          code: 'MCP_EXECUTION_ERROR',
          message: (error as Error).message,
        },
        success: false,
      };
    }
  }

  private async executeCloudMCPTool(
    payload: ChatToolPayload,
    context: ToolExecutionContext,

    _mcpParams: CloudMCPParams,
  ): Promise<ToolExecutionResult> {
    const { identifier, apiName, arguments: args } = payload;

    log('Executing Cloud MCP tool: %s:%s via cloud gateway', identifier, apiName);

    try {
      // Create DiscoverService with user context
      const discoverService = new DiscoverService({
        userInfo: context.userId ? { userId: context.userId } : undefined,
      });

      // Parse arguments
      const apiParams = safeParseJSON(args) || {};

      // Call cloud MCP endpoint via Market API
      // Returns CloudGatewayResponse: { content: ToolCallContent[], isError?: boolean }
      const cloudResult = await discoverService.callCloudMcpEndpoint({
        apiParams,
        identifier,
        toolName: apiName,
      });

      const cloudResultContent = (cloudResult?.content ?? []) as ToolCallContent[];

      // Convert content blocks to string (same as market router does)
      const content = contentBlocksToString(cloudResultContent);
      const state = { ...cloudResult, content: cloudResultContent };

      log('Cloud MCP tool execution successful for: %s:%s', identifier, apiName);

      return {
        content,
        state,
        success: !cloudResult?.isError,
      };
    } catch (error) {
      log('Cloud MCP tool execution failed for %s:%s: %O', identifier, apiName, error);
      return {
        content: (error as Error).message,
        error: {
          code: 'CLOUD_MCP_EXECUTION_ERROR',
          message: (error as Error).message,
        },
        success: false,
      };
    }
  }

  private async executeMcpProxyTool(
    payload: ChatToolPayload,
    context: ToolExecutionContext,
    mcpParams: StdioMCPParams,
  ): Promise<ToolExecutionResult> {
    const { identifier, apiName, arguments: args } = payload;

    log('Executing MCP Proxy tool: %s:%s via server-side stdio', identifier, apiName);

    try {
      const parsedArgs = safeParseJSON(args) || {};

      const result = await mcpProxyService.callTool({
        args: parsedArgs,
        clientParams: mcpParams,
        toolName: apiName,
      });

      // Process content blocks (upload images, etc.)
      const { processContentBlocks } = await import('@/server/services/mcp/contentProcessor');
      const { FileService } = await import('@/server/services/file');
      const fileService =
        context.userId && context.serverDB
          ? new FileService(context.serverDB, context.userId)
          : undefined;

      const newContent = result.isError
        ? result.content
        : fileService
          ? await processContentBlocks(result.content, fileService)
          : result.content;

      const content = contentBlocksToString(newContent);
      const state = { ...result, content: newContent };

      log('MCP Proxy tool execution successful for: %s:%s', identifier, apiName);

      return {
        content,
        state,
        success: !result.isError,
      };
    } catch (error) {
      log('MCP Proxy tool execution failed for %s:%s: %O', identifier, apiName, error);
      return {
        content: (error as Error).message,
        error: {
          code: 'MCP_PROXY_EXECUTION_ERROR',
          message: (error as Error).message,
        },
        success: false,
      };
    }
  }
}

export * from './types';
