import { type ChatToolPayload } from '@lobechat/types';
import { detectTruncatedJSON, safeParseJSON } from '@lobechat/utils';
import debug from 'debug';

import type {
  ToolExecutionContext,
  ToolExecutionResult,
} from '@/server/services/toolExecution/types';

import type {
  ToolExecutionContext as KernelToolExecutionContext,
  ToolRegistry,
} from '../../../../packages/cordis-kernel/src/tool';
import type { RuntimeContext, ScopeKey } from '../../../../packages/cordis-kernel/src/types';
import { scopeOfContext } from './registry-helper';
import type { CordisToolBridgeDeps } from './types';

const log = debug('lobe-server:cordis-tool-bridge');

export class CordisToolBridge {
  private readonly toolRegistry: ToolRegistry;
  private readonly fallbackExecutor?: CordisToolBridgeDeps['fallbackExecutor'];
  private readonly context?: KernelToolExecutionContext;

  constructor(deps: CordisToolBridgeDeps) {
    this.toolRegistry = deps.toolRegistry;
    this.fallbackExecutor = deps.fallbackExecutor;
    this.context = deps.context;
  }

  hasTool(identifier: string, apiName: string, scope?: ScopeKey): boolean {
    const effectiveScope = scope ?? scopeOfContext(this.context);
    const tools = this.toolRegistry.list();
    const targetName = identifier ? `${identifier}:${apiName}` : apiName;
    const tool = tools.find((t) => t.name === targetName);
    if (!tool) return false;

    // Scoped tools are only discoverable by the matching scope
    if (tool.scope !== undefined) {
      return effectiveScope !== undefined && tool.scope === effectiveScope;
    }

    // Global tools are always discoverable
    return true;
  }

  async execute(
    payload: ChatToolPayload,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!context || typeof context !== 'object') {
      return {
        content: 'Execution context is required',
        error: {
          code: 'INVALID_EXECUTION_CONTEXT',
          message: 'Execution context is required',
        },
        success: false,
      };
    }

    const { identifier, apiName, arguments: argsStr } = payload;
    const parsed = safeParseJSON(argsStr);

    // Validate JSON arguments and preserve truncation diagnostics
    if (parsed === undefined && argsStr) {
      const truncationReason = detectTruncatedJSON(argsStr);
      const explanation = truncationReason
        ? `The tool call arguments JSON appears to be truncated (${truncationReason}), ` +
          `likely because the model's max_tokens budget was exhausted ` +
          `(possibly by extended-thinking tokens). ` +
          `Either reduce the size of the content you are about to write, ` +
          `or ask the user to increase the model's max_tokens ` +
          `(and/or disable extended thinking or set a separate thinking budget). ` +
          `Do not retry with the same payload.`
        : `The tool call arguments string is not valid JSON and could not be parsed, ` +
          `so the tool was not invoked. Fix the JSON syntax and try again.`;
      const content = `${explanation}\n\nThe received arguments string was:\n${argsStr}`;
      const code = truncationReason ? 'TRUNCATED_ARGUMENTS' : 'INVALID_JSON_ARGUMENTS';
      log('Rejected invalid arguments for %s:%s (%s): %s', identifier, apiName, code, argsStr);
      return {
        content,
        error: { code, message: explanation },
        success: false,
      };
    }

    const args = parsed ?? {};

    const registeredTools = this.toolRegistry.list();
    const requestedName = identifier ? `${identifier}:${apiName}` : apiName;
    const resolvedTool = registeredTools.find((t) => t.name === requestedName);

    // If tool is not registered in Cordis, delegate to fallbackExecutor or return TOOL_NOT_FOUND
    if (!resolvedTool) {
      if (this.fallbackExecutor) {
        log('Tool %s not found in Cordis registry, delegating to fallback executor', requestedName);
        return await this.fallbackExecutor(payload, context);
      }

      return {
        content: `Tool "${requestedName}" is not registered in Cordis kernel`,
        error: {
          code: 'TOOL_NOT_FOUND',
          message: `Tool "${requestedName}" is not registered in Cordis kernel`,
        },
        success: false,
      };
    }

    // Determine trusted scope from execution context or bridge context (never payload)
    const trustedScope: ScopeKey | undefined =
      (typeof context.scope === 'string' && context.scope ? context.scope : undefined) ??
      scopeOfContext(this.context);

    // Check scope accessibility: scoped tools can only be executed by the matching trusted scope
    // Scope mismatch must return error directly and must NOT bypass isolation via fallback
    if (
      resolvedTool.scope !== undefined &&
      (trustedScope === undefined || resolvedTool.scope !== trustedScope)
    ) {
      log(
        'Tool %s belongs to scope %s, inaccessible from caller scope %s',
        resolvedTool.name,
        String(resolvedTool.scope),
        String(trustedScope),
      );
      return {
        content: `Tool "${resolvedTool.name}" is not accessible in the current scope`,
        error: {
          code: 'TOOL_SCOPE_MISMATCH',
          message: `Tool "${resolvedTool.name}" is not accessible in the current scope`,
        },
        success: false,
      };
    }

    // All registered tools require a real RuntimeContext to execute safely
    if (!this.context) {
      return {
        content: `Tool "${resolvedTool.name}" cannot be safely executed without a RuntimeContext`,
        error: {
          code: 'UNSAFE_EXECUTION_CONTEXT',
          message: `Tool "${resolvedTool.name}" cannot be safely executed without a RuntimeContext`,
        },
        success: false,
      };
    }

    try {
      log('Executing tool %s through Cordis kernel', resolvedTool.name);

      // Derive fresh invocation context
      const baseContext: RuntimeContext =
        trustedScope !== undefined
          ? this.context.withScope(trustedScope)
          : Object.create(this.context);

      // Explicitly pick only declared ToolExecutionContext fields to avoid leaking null scopes
      // or overwriting runtime fiber/root/withScope methods
      const invocationContext = Object.assign(baseContext, {
        activeDeviceId: context.activeDeviceId,
        agentId: context.agentId,
        documentId: context.documentId,
        groupId: context.groupId,
        memoryEmbeddingRuntime: context.memoryEmbeddingRuntime,
        memoryToolPermission: context.memoryToolPermission,
        messageId: context.messageId,
        operationId: context.operationId,
        policy: this.context.policy,
        scope: trustedScope,
        serverDB: context.serverDB,
        taskId: context.taskId,
        threadId: context.threadId,
        toolCallId: context.toolCallId,
        toolManifestMap: context.toolManifestMap,
        toolResultMaxLength: context.toolResultMaxLength,
        topicId: context.topicId,
        userId: context.userId,
      });

      const rawResult = await this.toolRegistry.execute(resolvedTool.name, args, invocationContext);

      if (rawResult && typeof rawResult === 'object') {
        const record = rawResult as Record<string, unknown>;
        if ('success' in record && typeof record.success === 'boolean') {
          return rawResult as ToolExecutionResult;
        }

        // Handle MCP result format: { content: Array<{ type: 'text', text: string }>, isError?: boolean }
        if (record.isError === true) {
          let errorText = '';
          if (Array.isArray(record.content)) {
            errorText = record.content
              .map((c: unknown) => {
                if (
                  typeof c === 'object' &&
                  c !== null &&
                  'type' in c &&
                  (c as { type: unknown }).type === 'text'
                ) {
                  const textVal = (c as { text?: unknown }).text;
                  return typeof textVal === 'string' ? textVal : JSON.stringify(c);
                }
                return JSON.stringify(c);
              })
              .join('\n');
          } else if (typeof record.content === 'string') {
            errorText = record.content;
          }
          const message = errorText || 'MCP tool reported an error';
          return {
            content: message,
            error: {
              code: 'MCP_TOOL_ERROR',
              message,
            },
            state: record,
            success: false,
          };
        }

        if (Array.isArray(record.content)) {
          const text = record.content
            .map((c: unknown) => {
              if (
                typeof c === 'object' &&
                c !== null &&
                'type' in c &&
                (c as { type: unknown }).type === 'text'
              ) {
                const textVal = (c as { text?: unknown }).text;
                return typeof textVal === 'string' ? textVal : JSON.stringify(c);
              }
              return JSON.stringify(c);
            })
            .join('\n');
          return {
            content: text,
            state: record,
            success: true,
          };
        }
      }

      const content =
        typeof rawResult === 'string'
          ? rawResult
          : rawResult === undefined
            ? 'ok'
            : JSON.stringify(rawResult);

      return {
        content,
        state:
          typeof rawResult === 'object' && rawResult !== null
            ? (rawResult as Record<string, unknown>)
            : undefined,
        success: true,
      };
    } catch (e) {
      const error = e as Error;
      log('Error executing tool %s through Cordis kernel: %O', resolvedTool.name, error);
      return {
        content: error.message || 'Tool execution failed',
        error,
        success: false,
      };
    }
  }
}
