import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  type AtomicInvocation,
  type AtomicOperation,
  type AtomicPlugin,
  AtomicRuntime,
} from './atomic-runtime';
import type { SkillChatPort } from './skills-agent';
import { createSkillsPlugin } from './skills-plugin';

const scope = { userId: 'alice', sessionId: 'account' };
it('lets an agent inspect then fill native objects and deduplicates the same request', async () => {
  const inspect = vi.fn(async () => ({
    pages: [{ page: 1, shapes: [{ id: '7', runs: ['Title'] }] }],
  }));
  const fill = vi.fn(async (_input: unknown) => ({
    artifactId: 'native-result',
    uri: '/api/runtime/presentation/artifacts/native-result?raw=true',
  }));
  const chat = vi
    .fn()
    .mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              operation: 'presentation.template.inspectNative',
              input: { templateId: 'owned' },
            }),
          },
        },
      ],
    })
    .mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              operation: 'presentation.template.fillNative',
              input: {
                templateId: 'owned',
                patches: [{ page: 1, shapeId: '7', text: 'New title' }],
              },
            }),
          },
        },
      ],
    })
    .mockResolvedValueOnce({
      choices: [
        { message: { content: JSON.stringify({ done: true, summary: '已保留原稿结构完成修改' }) } },
      ],
    });
  const runtime: AtomicRuntime = new AtomicRuntime([
    {
      id: 'presentation',
      version: '1',
      operations: [
        {
          name: 'presentation.template.inspectNative',
          agent: { contexts: ['skills'] },
          description: 'Inspect',
          input: z.object({ templateId: z.string() }).strict(),
          execute: inspect,
        },
        {
          name: 'presentation.template.fillNative',
          agent: { contexts: ['skills'] },
          description: 'Fill',
          input: z
            .object({
              templateId: z.string(),
              patches: z.array(
                z.object({ page: z.number(), shapeId: z.string(), text: z.string() }),
              ),
            })
            .strict(),
          execute: fill,
        },
      ],
    },
    createSkillsPlugin(() => runtime, { chat, manifest: { model: 'test' } }),
  ]);
  try {
    const input = { instruction: '改标题', requestId: 'one', resources: { templateId: 'owned' } };
    const output = await runtime.invoke<any>('skills.autorun', input, { scope });
    expect(output.result.artifactId).toBe('native-result');
    expect(fill.mock.calls[0][0]).toMatchObject({
      patches: [{ page: 1, shapeId: '7', text: 'New title' }],
    });
    await runtime.invoke('skills.autorun', input, { scope });
    expect(chat).toHaveBeenCalledTimes(3);
    await expect(
      runtime.invoke('skills.autorun', { ...input, instruction: 'another' }, { scope }),
    ).rejects.toThrow('reused');
  } finally {
    await runtime.dispose();
  }
});
describe('composed plugin lifecycle', () => {
  it('holds every participating plugin version until the whole sequence finishes', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runtime: AtomicRuntime = new AtomicRuntime([
      {
        id: 'assets',
        version: '1',
        operations: [
          {
            name: 'assets.inspect',
            agent: { contexts: ['skills'] },
            description: 'Wait',
            input: z.object({}).strict(),
            execute: async () => {
              entered();
              await gate;
              return { ref: 'a' };
            },
          },
        ],
      },
      createSkillsPlugin(() => runtime),
    ]);
    const work = runtime.invoke(
      'skills.run',
      { steps: [{ id: 'inspect', operation: 'assets.inspect', input: {} }] },
      { scope },
    );
    await started;
    await expect(runtime.remove('assets')).rejects.toThrow('Finish or cancel');
    finish();
    await work;
    await runtime.remove('assets');
    await runtime.dispose();
  });
});

const decision = (value: unknown) => ({
  choices: [{ message: { content: JSON.stringify(value) } }],
});

const draftPlugin = (execute: AtomicOperation['execute'], maxCalls?: number): AtomicPlugin => ({
  id: 'blog',
  version: '1',
  operations: [
    {
      name: 'blog.draft',
      agent: { contexts: ['skills'], maxCalls },
      description: 'Create a scoped draft',
      input: z.object({ title: z.string(), requestId: z.string().optional() }).strict(),
      execute,
    },
  ],
});

const request = { instruction: '整理课程草稿', requestId: 'draft-one' };

describe('generic skill agent', () => {
  it('bounds cached requests while retaining in-flight idempotency and freeing completed entries', async () => {
    let entered!: () => void;
    let release!: () => void;
    let active = 0;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = vi.fn<AtomicOperation['execute']>(() => ({ ref: 'draft' }));
    const chat = vi.fn<SkillChatPort['chat']>(async (_request, ctx) => {
      if (ctx.idempotencyKey.endsWith(':plan:0')) {
        if (++active === 64) entered();
        await gate;
        return decision({ operation: 'blog.draft', input: { title: 'Draft' } });
      }
      return decision({ done: true });
    });
    const runtime: AtomicRuntime = new AtomicRuntime([
      draftPlugin(save),
      createSkillsPlugin(() => runtime, { chat, manifest: { model: 'test' } }),
    ]);
    const work = Array.from({ length: 64 }, (_, index) =>
      runtime.invoke('skills.autorun', { ...request, requestId: `active-${index}` }, { scope }),
    );
    try {
      await started;
      await expect(runtime.invoke('skills.autorun', request, { scope })).rejects.toThrow(
        'Too many active skill requests',
      );
      const duplicate = runtime.invoke(
        'skills.autorun',
        {
          ...request,
          requestId: 'active-0',
        },
        { scope },
      );
      release();
      await Promise.all([...work, duplicate]);
      expect(save).toHaveBeenCalledTimes(64);
      expect(chat).toHaveBeenCalledTimes(128);
      await runtime.invoke('skills.autorun', request, { scope });
      expect(save).toHaveBeenCalledTimes(65);
    } finally {
      release();
      await Promise.allSettled(work);
      await runtime.dispose();
    }
  });

  it('resolves the model from each trusted invocation without retaining another account provider', async () => {
    const provider = (title: string): SkillChatPort => ({
      manifest: { model: `model-${title}` },
      chat: vi
        .fn<SkillChatPort['chat']>()
        .mockResolvedValueOnce(decision({ operation: 'blog.draft', input: { title } }))
        .mockResolvedValueOnce(decision({ done: true })),
    });
    const aliceChat = provider('alice');
    const bobChat = provider('bob');
    const resolve = vi.fn(
      (invocation: AtomicInvocation) => invocation.services!.chat as SkillChatPort,
    );
    const runtime: AtomicRuntime = new AtomicRuntime([
      draftPlugin((input, ctx) => ({ ...input, owner: ctx.scope.userId })),
      createSkillsPlugin(() => runtime, resolve),
    ]);
    try {
      await expect(
        runtime.invoke('skills.autorun', request, {
          scope,
          services: { chat: aliceChat, privateKey: 'never-in-model-context' },
        }),
      ).resolves.toMatchObject({ result: { title: 'alice', owner: 'alice' } });
      await expect(
        runtime.invoke('skills.autorun', request, {
          scope: { ...scope, userId: 'bob' },
          services: { chat: bobChat },
        }),
      ).resolves.toMatchObject({ result: { title: 'bob', owner: 'bob' } });
      await runtime.invoke('skills.autorun', request, { scope, services: { chat: aliceChat } });
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(aliceChat.chat).toHaveBeenCalledTimes(2);
      expect(bobChat.chat).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(vi.mocked(aliceChat.chat).mock.calls[0][0])).not.toContain(
        'never-in-model-context',
      );
    } finally {
      await runtime.dispose();
    }
  });

  it('uses non-presentation capabilities, generic prompts and trusted domain input preparation', async () => {
    const save = vi.fn<AtomicOperation['execute']>((input, ctx) => ({
      ...input,
      owner: ctx.scope.userId,
    }));
    const chat = vi
      .fn<SkillChatPort['chat']>()
      .mockResolvedValueOnce(
        decision({
          operation: 'blog.draft',
          input: { title: 'Course notes', requestId: 'model-supplied' },
        }),
      )
      .mockResolvedValueOnce(decision({ done: true, summary: '草稿已完成' }));
    const runtime: AtomicRuntime = new AtomicRuntime([
      draftPlugin(save),
      createSkillsPlugin(
        () => runtime,
        { chat, manifest: { model: 'external-model' } },
        {
          agent: {
            instructions: 'Keep course material in draft form until reviewed.',
            prepareInput: (input, context) => ({
              ...input,
              requestId: `${context.requestId}:${context.operation}:${context.call}`,
            }),
          },
        },
      ),
    ]);
    try {
      const output = await runtime.invoke('skills.autorun', request, { scope });
      expect(output).toMatchObject({
        summary: '草稿已完成',
        result: { title: 'Course notes', owner: 'alice', requestId: 'draft-one:blog.draft:1' },
      });
      const [payload, context] = chat.mock.calls[0];
      expect(payload.model).toBe('external-model');
      expect(payload.messages[0].content).toContain('Keep course material in draft form');
      expect(payload.messages[0].content).not.toMatch(/PPTX|assets\.generate|template/);
      expect(
        JSON.parse(payload.messages[1].content).tools.map((tool: { name: string }) => tool.name),
      ).toEqual(['blog.draft']);
      expect(context).toMatchObject({ scope, idempotencyKey: 'draft-one:plan:0' });
      expect(save.mock.calls[0][1].scope).toEqual(scope);
    } finally {
      await runtime.dispose();
    }
  });

  it('enforces each operation budget from trusted metadata', async () => {
    const save = vi.fn<AtomicOperation['execute']>(() => ({ ref: 'draft' }));
    const chat = vi.fn<SkillChatPort['chat']>().mockResolvedValue(
      decision({
        operation: 'blog.draft',
        input: { title: 'Draft' },
      }),
    );
    const runtime: AtomicRuntime = new AtomicRuntime([
      draftPlugin(save, 2),
      createSkillsPlugin(() => runtime, { chat, manifest: { model: 'test' } }),
    ]);
    try {
      await expect(runtime.invoke('skills.autorun', request, { scope })).rejects.toThrow(
        'operation budget exceeded: blog.draft',
      );
      expect(save).toHaveBeenCalledTimes(2);
      expect(chat).toHaveBeenCalledTimes(3);
    } finally {
      await runtime.dispose();
    }
  });

  it('enforces profile decision limits without increasing the default cost ceiling', async () => {
    const save = vi.fn<AtomicOperation['execute']>(() => ({ ref: 'draft' }));
    const chat = vi.fn<SkillChatPort['chat']>().mockResolvedValue(
      decision({
        operation: 'blog.draft',
        input: { title: 'Draft' },
      }),
    );
    const runtime: AtomicRuntime = new AtomicRuntime([
      draftPlugin(save),
      createSkillsPlugin(
        () => runtime,
        { chat, manifest: { model: 'test' } },
        {
          agent: { maxDecisions: 2 },
        },
      ),
    ]);
    try {
      await expect(runtime.invoke('skills.autorun', request, { scope })).rejects.toThrow(
        'step budget exceeded',
      );
      expect(save).toHaveBeenCalledTimes(2);
      expect(chat).toHaveBeenCalledTimes(2);
      expect(() =>
        createSkillsPlugin(
          () => runtime,
          { chat, manifest: { model: 'test' } },
          {
            agent: { maxDecisions: 11 },
          },
        ),
      ).toThrow();
    } finally {
      await runtime.dispose();
    }
  });

  it('stops after two tool failures and does not replay an unsuccessful request from cache', async () => {
    const save = vi
      .fn<AtomicOperation['execute']>()
      .mockRejectedValue(new Error('Draft storage failed'));
    const chat = vi.fn<SkillChatPort['chat']>().mockResolvedValue(
      decision({
        operation: 'blog.draft',
        input: { title: 'Draft' },
      }),
    );
    const runtime: AtomicRuntime = new AtomicRuntime([
      draftPlugin(save),
      createSkillsPlugin(() => runtime, { chat, manifest: { model: 'test' } }),
    ]);
    try {
      await expect(runtime.invoke('skills.autorun', request, { scope })).rejects.toThrow(
        'Draft storage failed',
      );
      expect(save).toHaveBeenCalledTimes(2);
      expect(chat).toHaveBeenCalledTimes(2);
      save.mockResolvedValue({ ref: 'recovered' });
      chat
        .mockReset()
        .mockResolvedValueOnce(decision({ operation: 'blog.draft', input: { title: 'Draft' } }))
        .mockResolvedValueOnce(decision({ done: true }));
      await expect(runtime.invoke('skills.autorun', request, { scope })).resolves.toMatchObject({
        result: { ref: 'recovered' },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('prevents model selection of an operation denied by the host profile', async () => {
    const save = vi.fn<AtomicOperation['execute']>(() => ({ ref: 'draft' }));
    const chat = vi.fn<SkillChatPort['chat']>().mockResolvedValue(
      decision({
        operation: 'blog.draft',
        input: { title: 'Draft' },
      }),
    );
    const plugin = draftPlugin(save);
    plugin.operations.push({
      name: 'blog.read',
      agent: { contexts: ['skills'] },
      description: 'Read a draft',
      input: z.object({}).strict(),
      execute: () => ({ title: 'Owned' }),
    });
    const runtime: AtomicRuntime = new AtomicRuntime([
      plugin,
      createSkillsPlugin(
        () => runtime,
        { chat, manifest: { model: 'test' } },
        {
          policy: (name) => name === 'blog.read',
        },
      ),
    ]);
    try {
      await expect(runtime.invoke('skills.autorun', request, { scope })).rejects.toThrow(
        'unavailable operation',
      );
      expect(save).not.toHaveBeenCalled();
      expect(
        JSON.parse(chat.mock.calls[0][0].messages[1].content).tools.map(
          (tool: { name: string }) => tool.name,
        ),
      ).toEqual(['blog.read']);
    } finally {
      await runtime.dispose();
    }
  });

  it('cancels during a provider call that ignores the signal, keeps versions pinned, then releases leases', async () => {
    let finish!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const save = vi.fn<AtomicOperation['execute']>(() => ({ ref: 'draft' }));
    const chat = vi.fn<SkillChatPort['chat']>(async () => {
      entered();
      await gate;
      return decision({ operation: 'blog.draft', input: { title: 'Draft' } });
    });
    const runtime: AtomicRuntime = new AtomicRuntime([
      draftPlugin(save),
      createSkillsPlugin(() => runtime, { chat, manifest: { model: 'test' } }),
    ]);
    const controller = new AbortController();
    const work = runtime.invoke('skills.autorun', request, { scope, signal: controller.signal });
    try {
      await started;
      await expect(runtime.replace({ ...draftPlugin(save), version: '2' })).rejects.toMatchObject({
        code: 'PLUGIN_BUSY',
      });
      controller.abort();
      finish();
      await expect(work).rejects.toMatchObject({ code: 'PRESENTATION_WORKER_CANCELLED' });
      expect(save).not.toHaveBeenCalled();
      expect(chat).toHaveBeenCalledTimes(1);
      await runtime.remove('blog');
    } finally {
      controller.abort();
      finish();
      await work.catch(() => undefined);
      await runtime.dispose();
    }
  });

  it('does not discover or execute plugins installed during an active model decision', async () => {
    const late = vi.fn<AtomicOperation['execute']>(() => ({ ref: 'late' }));
    const chat = vi.fn<SkillChatPort['chat']>(async () => {
      await runtime.add({
        id: 'late',
        version: '1',
        operations: [
          {
            name: 'late.create',
            agent: { contexts: ['skills'] },
            description: 'A newly mounted tool',
            input: z.object({}).strict(),
            execute: late,
          },
        ],
      });
      return decision({ operation: 'late.create', input: {} });
    });
    const runtime: AtomicRuntime = new AtomicRuntime([
      draftPlugin(() => ({ ref: 'draft' })),
      createSkillsPlugin(() => runtime, { chat, manifest: { model: 'test' } }),
    ]);
    try {
      await expect(runtime.invoke('skills.autorun', request, { scope })).rejects.toThrow(
        'unavailable operation',
      );
      expect(late).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it('bounds text context and removes embedded image data from model requests', async () => {
    const chat = vi
      .fn<SkillChatPort['chat']>()
      .mockResolvedValueOnce(decision({ operation: 'blog.draft', input: { title: 'Draft' } }))
      .mockResolvedValueOnce(decision({ done: true }));
    const runtime: AtomicRuntime = new AtomicRuntime([
      draftPlugin(() => ({ ref: 'draft' })),
      createSkillsPlugin(() => runtime, { chat, manifest: { model: 'test' } }),
    ]);
    try {
      await runtime.invoke(
        'skills.autorun',
        {
          ...request,
          resources: { picture: 'data:image/png;base64,AAAA' },
        },
        { scope },
      );
      expect(chat.mock.calls[0][0].messages[1].content).not.toContain('data:image');
      expect(chat.mock.calls[0][0].messages[1].content).toContain('embedded image data omitted');
      await expect(
        runtime.invoke(
          'skills.autorun',
          {
            ...request,
            requestId: 'oversized',
            resources: { content: 'x'.repeat(180_001) },
          },
          { scope },
        ),
      ).rejects.toThrow('text context is too large');
      expect(chat).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.dispose();
    }
  });
});
