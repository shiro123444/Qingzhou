import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CapabilityContext } from '../../../../packages/cordis-kernel/src/capability';
import { CordisAtomicHost, type CordisServiceContext } from '../cordis-atomic-host';
import { CordisToolBridge } from './bridge';
import { createBuiltinToolsPlugin } from './builtin-plugin';
import { scopeOfContext } from './registry-helper';
import { createToolCapabilityPort } from './tool-capability';

const hosts: CordisAtomicHost[] = [];
const makeHost = () => {
  const host = new CordisAtomicHost();
  hosts.push(host);
  return host;
};
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

const payload = {
  apiName: 'read',
  arguments: '{}',
  id: 'call',
  identifier: 'probe',
  type: 'builtin' as const,
};

describe('tool invocation context boundary', () => {
  it('protects native ownership and policy while retaining trusted invocation data', async () => {
    const host = makeHost();
    const policy = vi.fn();
    const nativePolicy = vi.fn();
    const runtime = Object.assign(host.context.withScope('trusted'), { policy: nativePolicy });
    host.tools.register(host.context, {
      name: 'probe:read',
      description: 'inspect',
      inputSchema: {},
      execute: (_args, ctx) => {
        const serviceCtx = ctx as CordisServiceContext & { invocation: { jobId: string } };
        expect(serviceCtx.get('cordis.tools')).toBe(host.tools);
        expect(serviceCtx.fiber).toBe(host.context.fiber);
        expect(serviceCtx.root).toBe(host.context);
        expect(serviceCtx.invocation).toEqual({ jobId: 'trusted-job' });
        return scopeOfContext(ctx);
      },
    });
    const port = createToolCapabilityPort(host.tools, { runtimeContext: runtime });
    for (const scopeFields of [{ scope: undefined }, JSON.parse('{"scope":null}')]) {
      const context: CapabilityContext = {
        ...JSON.parse('{"__proto__":{"broken":true},"constructor":"broken","prototype":{}}'),
        ...scopeFields,
        fiber: {},
        root: {},
        native: {},
        host: {},
        isRoot: false,
        get: () => 'wrong registry',
        withScope: () => ({}),
        policy,
        invocation: { jobId: 'trusted-job' },
      };
      await expect(port.execute({ name: 'probe:read' }, context)).resolves.toBe('trusted');
    }
    expect(policy).not.toHaveBeenCalled();
    expect(nativePolicy).toHaveBeenCalledTimes(2);
  });

  it('preserves symbol isolation labels through a generic tool bridge', async () => {
    const host = makeHost();
    const scope = Symbol('workspace');
    const runtime = host.context.withScope(scope);
    host.tools.register(runtime, {
      name: 'probe:read',
      description: 'inspect',
      inputSchema: {},
      execute: (_args, ctx) => ({ content: String(scopeOfContext(ctx) === scope), success: true }),
    });
    const bridge = new CordisToolBridge({ context: runtime, toolRegistry: host.tools });
    expect(bridge.hasTool('probe', 'read')).toBe(true);
    await expect(bridge.execute(payload, { toolManifestMap: {} })).resolves.toMatchObject({
      content: 'true',
      success: true,
    });
  });

  it('retains the host policy on a derived bridge invocation', async () => {
    const host = makeHost();
    const handler = vi.fn(() => 'must not run');
    const policy = vi.fn(() => {
      throw new Error('blocked by host policy');
    });
    const injectedPolicy = vi.fn();
    const runtime = Object.assign(host.context.withScope('trusted'), { policy });
    host.tools.register(runtime, {
      name: 'probe:read',
      description: 'protected',
      inputSchema: {},
      execute: handler,
    });
    const bridge = new CordisToolBridge({ context: runtime, toolRegistry: host.tools });
    const context = { toolManifestMap: {}, policy: injectedPolicy };
    await expect(bridge.execute(payload, context)).resolves.toMatchObject({
      content: 'blocked by host policy',
      success: false,
    });
    expect(policy).toHaveBeenCalledTimes(1);
    expect(injectedPolicy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects symbol labels at the string-only builtin business boundary', async () => {
    const host = makeHost();
    const handler = vi.fn(async () => ({ content: 'must not run', success: true }));
    await host.mount(
      createBuiltinToolsPlugin({ tools: [{ identifier: 'probe', apiName: 'read', handler }] }),
    );
    const bridge = new CordisToolBridge({
      context: host.context.withScope(Symbol('workspace')),
      toolRegistry: host.tools,
    });
    await expect(bridge.execute(payload, { toolManifestMap: {} })).resolves.toMatchObject({
      success: false,
      content: 'Builtin tools require a string conversation scope',
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
