import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type AtomicPlugin, AtomicRuntime } from './atomic-runtime';
import { runSkillSteps, type SkillStep } from './skill-composition';
import { createSkillsPlugin } from './skills-plugin';

const scope = { userId: 'alice', sessionId: 'course' };
const crossDomainSteps: SkillStep[] = [
  { id: 'source', operation: 'documents.read', input: { id: 'vectors' } },
  {
    id: 'lesson',
    operation: 'teaching.outline',
    input: { title: { $ref: 'source.title' }, text: { $ref: 'source.text' } },
  },
  {
    id: 'draft',
    operation: 'blog.saveDraft',
    input: { title: { $ref: 'lesson.title' }, sections: { $ref: 'lesson.sections' } },
  },
];

function createContentPlugins() {
  const documents = new Map([
    [JSON.stringify([scope, 'vectors']), { title: 'Vectors', text: 'Addition\nProjection' }],
  ]);
  const drafts = new Map<string, unknown>();
  const calls: string[] = [];
  const plugins: AtomicPlugin[] = [
    {
      id: 'documents',
      version: '1',
      operations: [
        {
          name: 'documents.read',
          agent: { contexts: ['skills'] },
          description: 'Read owned course material',
          input: z.object({ id: z.string() }).strict(),
          execute: ({ id }, ctx) => {
            calls.push('documents.read');
            const value = documents.get(JSON.stringify([ctx.scope, id]));
            if (!value) throw new Error('Document not found in this scope');
            return value;
          },
        },
        {
          name: 'documents.delete',
          description: 'Delete a document outside composition',
          input: z.object({ id: z.string() }).strict(),
          execute: ({ id }, ctx) => documents.delete(JSON.stringify([ctx.scope, id])),
        },
      ],
    },
    {
      id: 'teaching',
      version: '1',
      operations: [
        {
          name: 'teaching.outline',
          agent: { contexts: ['skills', 'lesson.intake'] },
          description: 'Turn course material into a lesson outline',
          input: z.object({ title: z.string(), text: z.string() }).strict(),
          execute: ({ title, text }) => {
            calls.push('teaching.outline');
            return { title, sections: text.split('\n') };
          },
        },
      ],
    },
    {
      id: 'blog',
      version: '1',
      operations: [
        {
          name: 'blog.saveDraft',
          agent: { contexts: ['skills'] },
          description: 'Save a scoped draft without publishing',
          input: z.object({ title: z.string(), sections: z.array(z.string()) }).strict(),
          execute: (input, ctx) => {
            calls.push('blog.saveDraft');
            const ref = JSON.stringify([ctx.scope, input.title]);
            drafts.set(ref, input);
            return { ref, ...input };
          },
        },
      ],
    },
  ];
  return { calls, drafts, plugins };
}

describe('capability composition', () => {
  it('discovers and composes documents, teaching and blog plugins with scoped result references', async () => {
    const { plugins, drafts } = createContentPlugins();
    const runtime: AtomicRuntime = new AtomicRuntime([
      ...plugins,
      createSkillsPlugin(() => runtime),
    ]);
    try {
      const catalog = await runtime.invoke<{ recipes: unknown[]; tools: { name: string }[] }>(
        'skills.catalog',
        {},
        { scope },
      );
      expect(catalog.tools.map((tool) => tool.name)).toEqual([
        'documents.read',
        'teaching.outline',
        'blog.saveDraft',
      ]);
      expect(catalog.recipes).toEqual([]);
      const output = await runtime.invoke<{
        last: { ref: string; title: string; sections: string[] };
      }>('skills.run', { steps: crossDomainSteps }, { scope, jobId: 'course-1' });
      expect(drafts.get(output.last.ref)).toEqual({
        title: 'Vectors',
        sections: ['Addition', 'Projection'],
      });
      expect((await runtime.snapshot(scope)).operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'documents.read',
            state: 'completed',
            jobId: 'course-1',
          }),
          expect.objectContaining({
            name: 'blog.saveDraft',
            state: 'completed',
            jobId: 'course-1',
          }),
        ]),
      );
      await expect(
        runtime.invoke(
          'skills.run',
          { steps: crossDomainSteps },
          {
            scope: { ...scope, userId: 'bob' },
          },
        ),
      ).rejects.toThrow('Document not found in this scope');
      expect(drafts.size).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it('applies profile policy to catalog, recipes and the entire workflow before any effects', async () => {
    const { plugins, calls } = createContentPlugins();
    const runtime: AtomicRuntime = new AtomicRuntime([
      ...plugins,
      createSkillsPlugin(() => runtime, undefined, {
        policy: (name, invocation) =>
          invocation.scope.userId === 'alice' && name !== 'blog.saveDraft',
        recipes: [
          { id: 'read', steps: ['documents.read'] },
          { id: 'publish-course', steps: ['documents.read', 'teaching.outline', 'blog.saveDraft'] },
        ],
      }),
    ]);
    try {
      const catalog = await runtime.invoke<{
        recipes: { id: string }[];
        tools: { name: string }[];
      }>('skills.catalog', {}, { scope });
      expect(catalog.tools.map((tool) => tool.name)).toEqual([
        'documents.read',
        'teaching.outline',
      ]);
      expect(catalog.recipes.map((recipe) => recipe.id)).toEqual(['read']);
      await expect(
        runtime.invoke('skills.run', { steps: crossDomainSteps }, { scope }),
      ).rejects.toThrow('Operation cannot be composed: blog.saveDraft');
      expect(calls).toEqual([]);
      expect(
        await runtime.invoke('skills.catalog', {}, { scope: { ...scope, userId: 'bob' } }),
      ).toMatchObject({ tools: [], recipes: [] });
      await runtime.remove('documents');
      expect(await runtime.invoke('skills.catalog', {}, { scope })).toMatchObject({ recipes: [] });
    } finally {
      await runtime.dispose();
    }
  });

  it('cannot grant unmarked tools through a permissive host policy or caller-supplied metadata', async () => {
    const { plugins } = createContentPlugins();
    const runtime: AtomicRuntime = new AtomicRuntime([
      ...plugins,
      createSkillsPlugin(() => runtime, undefined, { policy: () => true }),
    ]);
    try {
      await expect(
        runtime.invoke(
          'skills.run',
          {
            steps: [{ id: 'delete', operation: 'documents.delete', input: { id: 'vectors' } }],
          },
          { scope },
        ),
      ).rejects.toThrow('Operation cannot be composed: documents.delete');
      await expect(
        runtime.invoke(
          'skills.run',
          {
            steps: [
              {
                id: 'delete',
                operation: 'documents.delete',
                input: { id: 'vectors' },
                agent: { contexts: ['skills'] },
              },
            ],
          },
          { scope },
        ),
      ).rejects.toMatchObject({ code: 'PRESENTATION_INVALID' });
      await expect(
        runtime.invoke('documents.read', { id: 'vectors' }, { scope }),
      ).resolves.toMatchObject({ title: 'Vectors' });
    } finally {
      await runtime.dispose();
    }
  });

  it('holds the later plugin version while the first operation is still running', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = (version: string): AtomicPlugin => ({
      id: 'blog',
      version,
      operations: [
        {
          name: 'blog.save',
          agent: { contexts: ['skills'] },
          description: 'Save a draft',
          input: z.object({ title: z.string() }).strict(),
          execute: ({ title }) => ({ title, version }),
        },
      ],
    });
    const runtime = new AtomicRuntime([
      {
        id: 'documents',
        version: '1',
        operations: [
          {
            name: 'documents.read',
            agent: { contexts: ['skills'] },
            description: 'Read material',
            input: z.object({}).strict(),
            execute: async () => {
              entered();
              await gate;
              return { title: 'Lesson' };
            },
          },
        ],
      },
      writer('1'),
    ]);
    const work = runSkillSteps(
      runtime,
      [
        { id: 'read', operation: 'documents.read', input: {} },
        { id: 'save', operation: 'blog.save', input: { title: { $ref: 'read.title' } } },
      ],
      { scope },
    );
    try {
      await started;
      await expect(runtime.replace(writer('2'))).rejects.toMatchObject({ code: 'PLUGIN_BUSY' });
      await expect(runtime.remove('blog')).rejects.toMatchObject({ code: 'PLUGIN_BUSY' });
      release();
      expect((await work).last).toEqual({ title: 'Lesson', version: '1' });
      await runtime.replace(writer('2'));
      expect(await runtime.invoke('blog.save', { title: 'Next' }, { scope })).toEqual({
        title: 'Next',
        version: '2',
      });
    } finally {
      release();
      await work.catch(() => undefined);
      await runtime.dispose();
    }
  });

  it('rechecks opt-in after acquiring the plugin lease', async () => {
    const { plugins, calls } = createContentPlugins();
    const runtime = new AtomicRuntime(plugins);
    const acquire = runtime.acquire.bind(runtime);
    const acquisition = vi.spyOn(runtime, 'acquire').mockImplementationOnce(async (id) => {
      await runtime.replace({
        ...plugins[0],
        version: '2',
        operations: plugins[0].operations.map((operation) => ({ ...operation, agent: undefined })),
      });
      return acquire(id);
    });
    try {
      await expect(runSkillSteps(runtime, [crossDomainSteps[0]], { scope })).rejects.toThrow(
        'Operation cannot be composed: documents.read',
      );
      expect(calls).toEqual([]);
      await runtime.remove('documents');
    } finally {
      acquisition.mockRestore();
      await runtime.dispose();
    }
  });

  it('cancels a running sequence, skips later effects and releases all participants', async () => {
    const { plugins, calls } = createContentPlugins();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    plugins[0].operations[0].execute = (_input, ctx) =>
      new Promise((resolve) => {
        ctx.signal!.addEventListener('abort', () => resolve({ title: 'Ignored', text: '' }), {
          once: true,
        });
        entered();
      });
    const runtime: AtomicRuntime = new AtomicRuntime([
      ...plugins,
      createSkillsPlugin(() => runtime),
    ]);
    const controller = new AbortController();
    const work = runtime.invoke(
      'skills.run',
      { steps: crossDomainSteps },
      {
        scope,
        signal: controller.signal,
      },
    );
    try {
      await started;
      controller.abort();
      await expect(work).rejects.toMatchObject({ code: 'PRESENTATION_WORKER_CANCELLED' });
      expect(calls).toEqual([]);
      for (const plugin of plugins) await runtime.remove(plugin.id);
    } finally {
      controller.abort();
      await work.catch(() => undefined);
      await runtime.dispose();
    }
  });

  it.each(['later.title', 'source.__proto__', 'source.constructor.name'])(
    'rejects unsafe or forward result references: %s',
    async (ref) => {
      const { plugins, drafts } = createContentPlugins();
      const runtime = new AtomicRuntime(plugins);
      try {
        await expect(
          runSkillSteps(
            runtime,
            [
              crossDomainSteps[0],
              {
                id: 'save',
                operation: 'blog.saveDraft',
                input: { title: { $ref: ref }, sections: [] },
              },
            ],
            { scope },
          ),
        ).rejects.toThrow('references must point to previous step results');
        expect(drafts.size).toBe(0);
      } finally {
        await runtime.dispose();
      }
    },
  );
});
