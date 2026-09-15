import { CordisToolRuntime } from '@lobechat/cordis-runtime';
import { type ChatToolPayload } from '@lobechat/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolExecutionService } from '../index';
import type { ToolExecutionContext } from '../types';

afterEach(() => {
  vi.restoreAllMocks();
});
const payload: ChatToolPayload = {
  apiName: 'echo',
  arguments: 'false',
  id: 'call',
  identifier: 'probe',
  type: 'builtin',
};

describe('server native tool entry', () => {
  it('routes through native tools and retains authenticated context plus truncation', async () => {
    const execute = vi.fn(async () => ({ content: 'ok', success: true }));
    const route = vi.spyOn(CordisToolRuntime.prototype, 'execute');
    const dispose = vi.spyOn(CordisToolRuntime.prototype, 'dispose');
    const service = new ToolExecutionService({
      builtinToolsExecutor: { execute },
      mcpService: { callTool: vi.fn() },
    });
    const context: ToolExecutionContext = {
      scope: 'page',
      toolManifestMap: {},
      userId: 'authenticated-user',
    };
    expect(await service.executeTool(payload, context)).toMatchObject({
      content: 'ok',
      success: true,
    });
    expect(route).toHaveBeenCalledWith('probe:echo', 'false');
    expect(execute).toHaveBeenCalledWith(payload, context);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('normalizes adapter failures while still retiring the native request', async () => {
    const dispose = vi.spyOn(CordisToolRuntime.prototype, 'dispose');
    const execute = vi.fn(async () => {
      throw new Error('adapter unavailable');
    });
    const service = new ToolExecutionService({
      builtinToolsExecutor: { execute },
      mcpService: { callTool: vi.fn() },
    });
    expect(
      await service.executeTool(payload, { toolManifestMap: {}, userId: 'alice' }),
    ).toMatchObject({ content: 'adapter unavailable', success: false });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
