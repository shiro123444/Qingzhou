import { describe, expect, it, vi } from 'vitest';

import { createSystemCapabilityTools } from './systemCapabilities';

const create = (overrides: Record<string, unknown> = {}) => {
  const ports = {
    agents: vi.fn().mockResolvedValue([{ id: 'owned-agent' }]),
    tasks: {
      createTask: vi.fn().mockResolvedValue({ success: true, identifier: 'T-1' }),
      listTasks: vi.fn().mockResolvedValue({ success: true, content: 'T-1' }),
    },
    saveSvg: vi.fn().mockResolvedValue({ fileId: 'owned-file' }),
    ...overrides,
  };
  return {
    ports,
    tools: createSystemCapabilityTools(
      { userId: 'owner', topicId: 'topic', toolManifestMap: {} },
      ports,
    ),
  };
};

describe('system capability bridge', () => {
  it('discovers configured PNG/files/search and registers generated files for the owning reply', async () => {
    const fileId = '4da6ad13-2e08-430f-90f8-42c8c97f65b8';
    const render = vi
      .fn()
      .mockResolvedValue({ artifact: { fileId, mimeType: 'image/png' }, width: 1280, height: 320 });
    const search = vi.fn().mockResolvedValue({
      results: [{ title: 'Cordis', url: 'https://github.com/cordiverse/cordis' }],
    });
    const ports = {
      ...create().ports,
      images: { render },
      web: { search },
      files: {
        inspect: vi.fn(),
        createText: vi.fn().mockResolvedValue({ artifact: { fileId } }),
        list: vi.fn().mockResolvedValue({ files: [] }),
      },
    };
    const tools = createSystemCapabilityTools(
      { userId: 'owner', topicId: 'topic', operationId: 'op-png', toolManifestMap: {} },
      ports,
    );
    const catalog = JSON.parse((await tools.catalog()).content);
    expect(catalog).toMatchObject({ pngReady: true, webReady: true });
    expect(catalog.tools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining(['images.render', 'files.createText', 'files.list', 'web.search']),
    );
    const reply = await tools.invoke({
      operation: 'images.render',
      input: JSON.stringify({
        block: {
          id: 'formula',
          kind: 'formula',
          latex: 'x^2',
          rect: { x: 0, y: 0, width: 640, height: 160 },
        },
      }),
    });
    expect(reply.state.botDelivery).toEqual({ operationId: 'op-png', artifacts: [{ fileId }] });
    expect(JSON.parse(reply.content).events.at(-1).state).toBe('completed');
    await expect(
      tools.invoke({
        operation: 'files.createText',
        input: '{"name":"../secret.txt","content":"x"}',
      }),
    ).rejects.toThrow();
    expect(ports.files.createText).not.toHaveBeenCalled();
    await tools.invoke({
      operation: 'web.search',
      input: '{"query":"Cordis framework","limit":3}',
    });
    expect(search).toHaveBeenCalledWith({ query: 'Cordis framework', limit: 3 });
    search.mockRejectedValue(new Error('SEARCH_INCOMPLETE'));
    await expect(
      tools.invoke({ operation: 'web.search', input: '{"query":"Cordis"}' }),
    ).rejects.toThrow('SEARCH_INCOMPLETE');
  });

  it('does not advertise unconfigured search as a working capability', async () => {
    const { tools } = create();
    const catalog = JSON.parse((await tools.catalog()).content);
    expect(catalog.webReady).toBe(false);
    expect(catalog.tools.some((tool: any) => tool.name === 'web.search')).toBe(false);
    await expect(
      tools.invoke({ operation: 'web.search', input: '{"query":"test"}' }),
    ).rejects.toThrow('Capability unavailable');
  });

  it('executes task creation through Cordis and returns real execution events', async () => {
    const { ports, tools } = create();
    const reply = await tools.invoke({
      operation: 'tasks.create',
      input: JSON.stringify({ name: 'test', instruction: 'verify' }),
    });
    const output = JSON.parse(reply.content);
    expect(ports.tasks.createTask).toHaveBeenCalledWith(
      { name: 'test', instruction: 'verify' },
      expect.anything(),
    );
    expect(output.result.identifier).toBe('T-1');
    expect(output.events.map((event: any) => event.state)).toEqual(['started', 'completed']);
    expect(reply.success).toBe(true);
  });

  it('rejects injected identity and unavailable operations before domain effects', async () => {
    const { ports, tools } = create();
    await expect(
      tools.invoke({
        operation: 'tasks.create',
        input: '{"name":"x","instruction":"y","userId":"other"}',
      }),
    ).rejects.toThrow();
    await expect(tools.invoke({ operation: 'system.exec', input: '{}' })).rejects.toThrow(
      'Capability unavailable',
    );
    expect(ports.tasks.createTask).not.toHaveBeenCalled();
    expect(ports.agents).not.toHaveBeenCalled();
  });

  it('preserves a failed domain result instead of claiming atomic completion is domain success', async () => {
    const { tools } = create({
      tasks: {
        createTask: vi.fn().mockResolvedValue({ success: false, content: 'not found' }),
        listTasks: vi.fn(),
      },
    });
    expect(
      (await tools.invoke({ operation: 'tasks.create', input: '{"name":"x","instruction":"y"}' }))
        .success,
    ).toBe(false);
  });

  it('reports missing PPT provider while exposing working vector tools', async () => {
    const { tools } = create();
    const catalog = JSON.parse((await tools.catalog()).content);
    expect(catalog.presentationReady).toBe(false);
    expect(catalog.tools.some((tool: any) => tool.name === 'presentation.create')).toBe(false);
    const reply = JSON.parse(
      (
        await tools.invoke({
          operation: 'presentation.formula.measure',
          input: '{"latex":"x^2","fontSize":28}',
        })
      ).content,
    );
    expect(reply.events.at(-1).state).toBe('completed');
    expect(reply.result).toBeTruthy();
  });

  it('stores a standalone SVG document instead of a slide fragment', async () => {
    const { ports, tools } = create();
    const reply = await tools.invoke({
      operation: 'presentation.formula.render',
      input: JSON.stringify({
        id: 'formula-test',
        kind: 'formula',
        latex: 'x^2+y^2=z^2',
        rect: { x: 20, y: 30, width: 640, height: 160 },
        fontSize: 40,
      }),
    });
    const svg = ports.saveSvg.mock.calls[0][0];
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain('viewBox="20 30 640 160"');
    expect(svg).toContain('<path');
    expect(svg).toContain('data-formula-latex="x^2+y^2=z^2"');
    expect(svg).toMatch(/<\/svg>$/);
    expect(JSON.parse(reply.content).result.artifact.fileId).toBe('owned-file');
  });

  it('uses only the presentation public catalog and propagates cancellation', async () => {
    const abort = new AbortController();
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const presentation = {
      listOperations: vi.fn().mockResolvedValue({
        tools: [
          {
            name: 'assets.inspect',
            description: 'Inspect owned asset',
            inputSchema: { type: 'object' },
          },
        ],
        runtimeTools: [{ name: 'presentation.internal' }],
      }),
      executeOperation: invoke,
    } as any;
    const tools = createSystemCapabilityTools(
      { userId: 'owner', topicId: 'topic', signal: abort.signal, toolManifestMap: {} },
      {
        agents: vi.fn(),
        tasks: { createTask: vi.fn(), listTasks: vi.fn() },
        saveSvg: vi.fn(),
        presentation,
      },
    );
    await tools.invoke({ operation: 'assets.inspect', input: '{}' });
    expect(invoke).toHaveBeenCalledWith('assets.inspect', {}, abort.signal);
    await expect(tools.invoke({ operation: 'presentation.internal', input: '{}' })).rejects.toThrow(
      'Capability unavailable',
    );
    abort.abort();
    await expect(tools.invoke({ operation: 'assets.inspect', input: '{}' })).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('discovers scoped native tools without nesting execution around runner policy', async () => {
    const tools = createSystemCapabilityTools(
      {
        userId: 'owner',
        topicId: 'topic',
        toolManifestMap: {
          'lobe-task': {
            identifier: 'lobe-task',
            api: [
              {
                name: 'viewTask',
                description: 'View an owned task',
                parameters: { type: 'object' },
              },
            ],
          } as any,
        },
      },
      create().ports,
    );
    const catalog = JSON.parse(
      (await tools.catalog({ operation: 'agent.lobe-task.viewTask' })).content,
    );
    expect(catalog.nativeOperation).toMatchObject({
      identifier: 'lobe-task',
      apiName: 'viewTask',
      execution: 'agent-runner',
    });
    expect(catalog.nativeOperation.inputSchema).toEqual({ type: 'object' });
    await expect(
      tools.invoke({ operation: 'agent.lobe-task.viewTask', input: '{}' }),
    ).rejects.toThrow('Capability unavailable');
    expect(
      JSON.parse((await tools.catalog({ operation: 'agent.unavailable.delete' })).content)
        .nativeOperation,
    ).toBeUndefined();
  });

  it('persists a reply intent bound to the owning operation after checking file ownership', async () => {
    const inspect = vi.fn().mockResolvedValue({
      fileId: '4da6ad13-2e08-430f-90f8-42c8c97f65b8',
      name: 'test.svg',
      mimeType: 'image/svg+xml',
      size: 100,
    });
    const tools = createSystemCapabilityTools(
      { userId: 'owner', topicId: 'topic', operationId: 'owned-operation', toolManifestMap: {} },
      { ...create().ports, files: { inspect } },
    );
    const reply = await tools.invoke({
      operation: 'files.deliver',
      input: '{"fileId":"4da6ad13-2e08-430f-90f8-42c8c97f65b8"}',
    });
    expect(inspect).toHaveBeenCalledWith('4da6ad13-2e08-430f-90f8-42c8c97f65b8');
    expect(reply.state.botDelivery).toEqual({
      operationId: 'owned-operation',
      artifacts: [{ fileId: '4da6ad13-2e08-430f-90f8-42c8c97f65b8' }],
    });
    inspect.mockRejectedValue(new Error('not owned'));
    await expect(
      tools.invoke({
        operation: 'files.deliver',
        input: '{"fileId":"4da6ad13-2e08-430f-90f8-42c8c97f65b8"}',
      }),
    ).rejects.toThrow('not owned');
  });
});
