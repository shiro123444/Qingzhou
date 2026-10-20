import { type ChatToolPayload } from '@lobechat/types';

import type { MCPClientParams } from '@/libs/mcp';
import type {
  ToolExecutionContext,
  ToolExecutionResult,
} from '@/server/services/toolExecution/types';

import type { ToolRegistry } from '../../../../packages/cordis-kernel/src/tool';
import type { RuntimeContext } from '../../../../packages/cordis-kernel/src/types';

export interface McpClientLike {
  callTool: (name: string, args: unknown) => Promise<unknown>;
  close?: () => void | Promise<void>;
  disconnect?: () => void | Promise<void>;
  initialize?: (options?: unknown) => Promise<unknown>;
  listTools: () => Promise<Array<{ description?: string; inputSchema?: unknown; name: string }>>;
}

export interface McpPluginOptions {
  allowEmptyTools?: boolean;
  clientFactory?: (params: MCPClientParams) => Promise<McpClientLike> | McpClientLike;
  clientParams: MCPClientParams;
  description?: string;
  id: string;
  version?: string;
}

export interface BuiltinToolEntry {
  apiName: string;
  description?: string;
  handler: (args: unknown, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
  identifier: string;
  inputSchema?: unknown;
}

export interface BuiltinToolsPluginOptions {
  id?: string;
  tools: BuiltinToolEntry[];
  version?: string;
}

export interface CordisToolBridgeDeps {
  context?: RuntimeContext;
  fallbackExecutor?: (
    payload: ChatToolPayload,
    context: ToolExecutionContext,
  ) => Promise<ToolExecutionResult>;
  toolRegistry: ToolRegistry;
}
