import { ToolRegistry, ToolRegistryError } from '../../../../packages/cordis-kernel/src/tool';
import type { ScopeKey } from '../../../../packages/cordis-kernel/src/types';

interface ContextWithGet {
  get: (name: string) => unknown;
}

const isObject = (val: unknown): val is Record<PropertyKey, unknown> =>
  typeof val === 'object' && val !== null;

const hasGetMethod = (target: unknown): target is ContextWithGet =>
  isObject(target) && 'get' in target && typeof target.get === 'function';

export const resolveToolRegistry = (ctx: unknown, pluginName = 'plugin'): ToolRegistry => {
  if (!hasGetMethod(ctx)) {
    throw new Error(`cordis.tools service is required to mount ${pluginName}`);
  }
  const service = ctx.get.call(ctx, 'cordis.tools');
  if (!(service instanceof ToolRegistry)) {
    throw new Error(`cordis.tools service is required to mount ${pluginName}`);
  }
  return service;
};

export const isDuplicateToolError = (error: unknown): boolean => {
  if (error instanceof ToolRegistryError && error.code === 'TOOL_DUPLICATE') {
    return true;
  }
  return false;
};

export const scopeOfContext = (ctx: unknown): ScopeKey | undefined => {
  if (isObject(ctx) && 'scope' in ctx) {
    const scopeVal = ctx.scope;
    if (typeof scopeVal === 'string' || typeof scopeVal === 'symbol') {
      return scopeVal;
    }
  }
  return undefined;
};
