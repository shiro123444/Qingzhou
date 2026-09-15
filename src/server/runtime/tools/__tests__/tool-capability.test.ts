import { describe, expect, it } from 'vitest';

import { Context } from '../../../../../packages/cordis-kernel/src/context';
import { ToolRegistry } from '../../../../../packages/cordis-kernel/src/tool';
import { createToolCapabilityPort } from '../tool-capability';

describe('ToolCapabilityPort', () => {
  it('exposes descriptor with capabilities and builtin source', () => {
    const registry = new ToolRegistry();
    const port = createToolCapabilityPort(registry);

    expect(port.id).toBe('tools.execution');
    expect(port.descriptor).toMatchObject({
      capabilities: ['execute', 'list'],
      id: 'tools.execution',
      source: 'builtin',
    });
  });

  it('lists registered tools through execute({ action: "list" }) respecting scope isolation', async () => {
    const rootContext = new Context();
    const scopedContext = rootContext.withScope('tenant-A');
    const registry = new ToolRegistry();

    // Global tool
    registry.register(rootContext, {
      description: 'Calculator',
      execute: (args: unknown) => {
        const record = args as { a: number; b: number };
        return record.a + record.b;
      },
      inputSchema: {},
      name: 'calc:add',
    });

    // Scoped tool
    registry.register(scopedContext, {
      description: 'Secret Admin Tool',
      execute: () => 'classified',
      inputSchema: {},
      name: 'admin:secret',
    });

    const port = createToolCapabilityPort(registry, { runtimeContext: rootContext });

    // 1. Unscoped caller sees global tools only, NOT tenant-A tools
    const unscopedList = (await port.execute({ action: 'list' }, {})) as Array<{ name: string }>;
    expect(unscopedList.map((t) => t.name)).toContain('calc:add');
    expect(unscopedList.map((t) => t.name)).not.toContain('admin:secret');

    // 2. Caller attempting privilege escalation via command.scope CANNOT see tenant-A tools
    const spoofedList = (await port.execute({ action: 'list', scope: 'tenant-A' }, {})) as Array<{
      name: string;
    }>;
    expect(spoofedList.map((t) => t.name)).not.toContain('admin:secret');

    // 3. Caller with trusted context.scope = 'tenant-A' sees both global and scoped tools
    const authorizedList = (await port.execute(
      { action: 'list' },
      { scope: 'tenant-A' },
    )) as Array<{ name: string }>;
    expect(authorizedList.map((t) => t.name)).toContain('calc:add');
    expect(authorizedList.map((t) => t.name)).toContain('admin:secret');
  });

  it('executes tool through execute({ action: "execute", name, args }) with runtimeContext', async () => {
    const context = new Context();
    const registry = new ToolRegistry();
    registry.register(context, {
      description: 'Echo',
      execute: (args: unknown) => ({ echoed: (args as { text: string }).text }),
      inputSchema: {},
      name: 'test:echo',
    });

    const port = createToolCapabilityPort(registry, { runtimeContext: context });
    const result = await port.execute(
      { action: 'execute', args: { text: 'hello' }, name: 'test:echo' },
      {},
    );

    expect(result).toEqual({ echoed: 'hello' });
  });

  it('rejects execution when runtimeContext is missing', async () => {
    const context = new Context();
    const registry = new ToolRegistry();
    registry.register(context, {
      description: 'Echo',
      execute: () => 'ok',
      inputSchema: {},
      name: 'test:run',
    });

    const portWithoutContext = createToolCapabilityPort(registry);
    await expect(
      portWithoutContext.execute({ action: 'execute', name: 'test:run' }, {}),
    ).rejects.toThrow('Tool capability execution requires a runtimeContext');
  });

  it('enforces scope isolation on execution and rejects command.scope bypass', async () => {
    const rootContext = new Context();
    const scopedContext = rootContext.withScope('scope-1');
    const registry = new ToolRegistry();

    registry.register(scopedContext, {
      description: 'Sensitive',
      execute: () => 'sensitive-output',
      inputSchema: {},
      name: 'vault:get',
    });

    const port = createToolCapabilityPort(registry, { runtimeContext: rootContext });

    // Calling with spoofed command.scope fails
    await expect(
      port.execute({ action: 'execute', name: 'vault:get', scope: 'scope-1' }, {}),
    ).rejects.toThrow(/not accessible in the current scope/);

    // Calling with trusted context.scope succeeds
    const allowed = await port.execute(
      { action: 'execute', name: 'vault:get' },
      { scope: 'scope-1' },
    );
    expect(allowed).toBe('sensitive-output');
  });

  it('throws on invalid command or missing tool name', async () => {
    const registry = new ToolRegistry();
    const port = createToolCapabilityPort(registry);

    await expect(port.execute(null, {})).rejects.toThrow(/must be an object/);
    await expect(port.execute({ action: 'execute' }, {})).rejects.toThrow(/non-empty tool name/);
    await expect(port.execute({ action: 'unknown' }, {})).rejects.toThrow(/Unsupported/);
  });
});
