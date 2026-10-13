// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { LessonPlan } from '@/types/presentationLesson';

import type { MultimodalChatPort } from '../presentation/multimodal-chat-provider';
import type { SkillChatPort } from '../skills-plugin';
import { createTeachingPlugin } from '../teaching/atomic-plugin';
import type { Site, SiteEditReceipt } from './contracts';
import {
  createProductionSitesRuntime,
  createSitesRuntime,
  type SitesRuntimeOptions,
} from './runtime';
import { SiteStore } from './store';

const owner = { userId: 'alice', sessionId: 'sites:alice' };
const path = 'src/content/blog/welcome.md';
const article = (text: string) =>
  `---\ntitle: "Article"\ndescription: "Course notes"\npublishDate: 2026-10-10\ntags: []\n---\n\n${text}\n`;
const answer = (value: unknown) => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function harness(options: Omit<SitesRuntimeOptions, 'store'> = {}) {
  const folder = await mkdtemp(nodePath.join(tmpdir(), 'qingzhou-site-profile-'));
  const store = new SiteStore(folder);
  const { runtime } = createSitesRuntime({ store, ...options });
  cleanups.push(async () => {
    await runtime.dispose();
    await rm(folder, { recursive: true, force: true });
  });
  const site = await store.create(owner.userId, 'Course blog', 'Alice');
  const edit = (chat: SkillChatPort, instruction = 'Revise the article') =>
    runtime.invoke<{
      site: Site;
      summary: string;
    }>(
      'sites.agent.edit',
      {
        id: site.id,
        baseRevision: site.draft.revision,
        instruction,
      },
      { scope: owner, services: { sitesChat: chat } },
    );
  return { runtime, store, site, edit };
}

const lesson: LessonPlan = {
  schemaVersion: 1,
  brief: {
    intention: 'Explain vectors',
    audience: 'Students',
    priorKnowledge: 'Addition',
    learningGoal: 'Understand projection',
    durationMinutes: 10,
    opening: 'direct',
  },
  beats: [
    {
      id: 'predict',
      title: 'Predict a direction',
      objective: 'Connect existing knowledge',
      teacherCue: 'PRIVATE TEACHER NOTE',
      studentAction: 'Draw a prediction',
      checkForUnderstanding: 'Explain the direction',
      durationMinutes: 4,
      locked: false,
      frames: [
        {
          id: 'question',
          title: 'Which direction?',
          kind: 'question',
          visibleContent: ['Observe the axes and predict the next step.'],
          visualCue: '',
          withheldContent: ['WITHHELD ANSWER'],
          boardSpace: 'none',
        },
      ],
    },
  ],
};

describe('native site capability profiles', () => {
  it('mounts the production education recipe and saves only public stages without publishing', async () => {
    const { store, site } = await harness();
    const { runtime } = await createProductionSitesRuntime({ store }, 'education');
    cleanups.push(() => runtime.dispose());
    const result = await runtime.invoke<{ last: SiteEditReceipt }>(
      'skills.run',
      {
        steps: [
          { id: 'compile', operation: 'teaching.lesson.compile', input: { plan: lesson } },
          {
            id: 'format',
            operation: 'content.lesson.markdown',
            input: {
              lesson: { $ref: 'compile' },
              title: 'Vectors',
              description: 'Course notes',
              publishDate: '2026-10-11',
            },
          },
          {
            id: 'save',
            operation: 'sites.edit',
            input: {
              id: site.id,
              baseRevision: site.draft.revision,
              changes: { [path]: { $ref: 'format.content' } },
            },
          },
        ],
      },
      { scope: owner },
    );
    const saved = await store.read(owner.userId, result.last.id);
    expect(saved.draft.files[path]).toContain('Observe the axes');
    expect(saved.draft.files[path]).toContain('draft: true');
    expect(saved.draft.files[path]).not.toContain('PRIVATE TEACHER NOTE');
    expect(saved.draft.files[path]).not.toContain('WITHHELD ANSWER');
    expect(saved.published).toBeUndefined();
    const catalog = await runtime.invoke<{ recipes: { id: string }[] }>(
      'skills.catalog',
      {},
      { scope: owner },
    );
    expect(catalog.recipes.some(({ id }) => id === 'lesson-to-article')).toBe(true);
    await runtime.remove('teaching');
    expect(
      (
        await runtime.invoke<{ recipes: { id: string }[] }>('skills.catalog', {}, { scope: owner })
      ).recipes.some(({ id }) => id === 'lesson-to-article'),
    ).toBe(false);
  });

  it('resolves education models from each account invocation without retaining the first account provider', async () => {
    const { store } = await harness();
    const { runtime } = await createProductionSitesRuntime({ store }, 'education');
    cleanups.push(() => runtime.dispose());
    const first = vi.fn<MultimodalChatPort['chat']>(async () => ({
      id: 'model-response',
      model: 'test',
      created: 0,
      choices: [
        { index: 0, message: { role: 'assistant' as const, content: JSON.stringify(lesson) } },
      ],
    }));
    const second = vi.fn(first.getMockImplementation()!);
    const provider = (chat: typeof first) => ({
      providerId: 'account',
      manifest: { model: 'test' },
      chat,
    });
    for (const [userId, chat] of [
      ['alice', first],
      ['bob', second],
    ] as const)
      await runtime.invoke(
        'teaching.lesson.plan',
        { brief: lesson.brief, topic: 'Vectors' },
        {
          scope: { userId, sessionId: `sites:${userId}` },
          services: { sitesChat: provider(chat) },
        },
      );
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0][1].scope.userId).toBe('alice');
    expect(second.mock.calls[0][1].scope.userId).toBe('bob');
    await expect(
      runtime.invoke(
        'teaching.lesson.plan',
        { brief: lesson.brief, topic: 'Vectors' },
        { scope: owner },
      ),
    ).rejects.toMatchObject({ code: 'SITE_AGENT_UNAVAILABLE' });
  });

  it('keeps the base production profile small and rejects unregistered scene names', async () => {
    const { store } = await harness();
    const { runtime } = await createProductionSitesRuntime({ store }, 'sites');
    cleanups.push(() => runtime.dispose());
    expect((await runtime.snapshot(owner)).plugins.map(({ id }) => id)).toEqual([
      'sites',
      'skills',
    ]);
    await expect(createProductionSitesRuntime({ store }, 'external-code')).rejects.toMatchObject({
      code: 'SITE_PROFILE_INVALID',
    });
  });

  it('composes a real owned draft read and non-deleting edit using result references', async () => {
    const { runtime, store, site } = await harness();
    const catalog = await runtime.invoke<{ tools: { name: string }[] }>(
      'skills.catalog',
      {},
      { scope: owner },
    );
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      'sites.sources',
      'sites.source.read',
      'sites.read',
      'sites.edit',
    ]);
    const output = await runtime.invoke<{ last: SiteEditReceipt }>(
      'skills.run',
      {
        steps: [
          { id: 'read', operation: 'sites.read', input: { id: site.id } },
          {
            id: 'edit',
            operation: 'sites.edit',
            input: {
              id: { $ref: 'read.id' },
              baseRevision: { $ref: 'read.draft.revision' },
              changes: { [path]: article('Composed native draft') },
            },
          },
        ],
      },
      { scope: owner },
    );
    expect(output.last.id).toBe(site.id);
    expect(output.last.draft.revision).not.toBe(site.draft.revision);
    expect((await store.read(owner.userId, site.id)).draft.files[path]).toBe(
      article('Composed native draft'),
    );
    expect((await store.read(owner.userId, site.id)).published).toBeUndefined();
    expect((await runtime.snapshot(owner)).plugins.map((plugin) => plugin.id)).toEqual([
      'sites',
      'skills',
    ]);
    await expect(
      runtime.invoke(
        'skills.run',
        {
          steps: [{ id: 'read', operation: 'sites.read', input: { id: site.id } }],
        },
        { scope: { ...owner, userId: 'bob' } },
      ),
    ).rejects.toMatchObject({ code: 'SITE_NOT_FOUND' });
  });

  it('keeps deletion and publication out of composition while preserving explicit manual changes', async () => {
    const { runtime, store, site } = await harness();
    for (const operation of [
      'sites.change',
      'sites.publish',
      'sites.rollback',
      'sites.agent.edit',
    ]) {
      await expect(
        runtime.invoke(
          'skills.run',
          {
            steps: [
              {
                id: 'forbidden',
                operation,
                input: { id: site.id, baseRevision: site.draft.revision },
              },
            ],
          },
          { scope: owner },
        ),
      ).rejects.toThrow('cannot be composed');
    }
    await expect(
      runtime.invoke(
        'skills.run',
        {
          steps: [
            {
              id: 'delete',
              operation: 'sites.edit',
              input: { id: site.id, baseRevision: site.draft.revision, changes: { [path]: null } },
            },
          ],
        },
        { scope: owner },
      ),
    ).rejects.toMatchObject({ code: 'PRESENTATION_INVALID' });
    await runtime.invoke(
      'sites.change',
      {
        id: site.id,
        baseRevision: site.draft.revision,
        changes: { [path]: null },
      },
      { scope: owner },
    );
    expect((await store.read(owner.userId, site.id)).draft.files).toEqual({});
  });

  it('mounts teaching in an education profile and sends only compiled public content into a draft', async () => {
    const { runtime, store, site } = await harness({
      plugins: {
        teaching: createTeachingPlugin(),
        markdown: {
          id: 'markdown',
          version: '1',
          operations: [
            {
              name: 'markdown.article',
              agent: { contexts: ['skills'] },
              description: 'Format a public lesson as Markdown',
              input: z.object({ title: z.string(), points: z.array(z.string()) }).strict(),
              execute: ({ title, points }) => ({
                content: article([title, ...points].join('\n\n')),
              }),
            },
          ],
        },
      },
      profile: {
        bundles: ['sites'],
        patches: [
          { op: 'add', entry: { id: 'teaching', use: 'teaching' } },
          { op: 'add', entry: { id: 'markdown', use: 'markdown' } },
        ],
      },
    });
    await runtime.invoke(
      'skills.run',
      {
        steps: [
          { id: 'read', operation: 'sites.read', input: { id: site.id } },
          { id: 'compile', operation: 'teaching.lesson.compile', input: { plan: lesson } },
          {
            id: 'format',
            operation: 'markdown.article',
            input: {
              title: { $ref: 'compile.stages.0.title' },
              points: { $ref: 'compile.stages.0.visibleContent' },
            },
          },
          {
            id: 'save',
            operation: 'sites.edit',
            input: {
              id: { $ref: 'read.id' },
              baseRevision: { $ref: 'read.draft.revision' },
              changes: { [path]: { $ref: 'format.content' } },
            },
          },
        ],
      },
      { scope: owner },
    );
    const saved = (await store.read(owner.userId, site.id)).draft.files[path];
    expect(saved).toContain('Which direction?');
    expect(saved).toContain('Observe the axes');
    expect(saved).not.toContain('PRIVATE TEACHER NOTE');
    expect(saved).not.toContain('WITHHELD ANSWER');
    expect((await runtime.snapshot(owner)).plugins.map((plugin) => plugin.id)).toEqual([
      'sites',
      'skills',
      'teaching',
      'markdown',
    ]);
  });

  it('uses profile selection and policy to disable capabilities before executing a recipe', async () => {
    const { runtime, site } = await harness({
      plugins: { teaching: createTeachingPlugin() },
      skills: { policy: (name) => name !== 'sites.edit' },
    });
    expect((await runtime.catalog()).some((tool) => tool.name.startsWith('teaching.'))).toBe(false);
    expect(await runtime.invoke('skills.catalog', {}, { scope: owner })).toMatchObject({
      recipes: [],
    });
    await expect(
      runtime.invoke(
        'skills.run',
        {
          steps: [
            {
              id: 'save',
              operation: 'sites.edit',
              input: {
                id: site.id,
                baseRevision: site.draft.revision,
                changes: { [path]: article('No') },
              },
            },
          ],
        },
        { scope: owner },
      ),
    ).rejects.toThrow('cannot be composed');
    const disabled = await harness({
      profile: { bundles: ['sites'], patches: [{ op: 'remove', id: 'skills' }] },
    });
    expect((await disabled.runtime.snapshot(owner)).plugins.map((plugin) => plugin.id)).toEqual([
      'sites',
    ]);
    const chat = { manifest: { model: 'test' }, chat: vi.fn<SkillChatPort['chat']>() };
    await expect(disabled.edit(chat)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(chat.chat).not.toHaveBeenCalled();
  });
});

describe('site agent compatibility and authority', () => {
  it('cannot pre-read drafts through skills after the sites plugin is disabled', async () => {
    const { runtime, store, site } = await harness({
      plugins: { teaching: createTeachingPlugin() },
      profile: {
        bundles: ['sites'],
        patches: [
          { op: 'remove', id: 'sites' },
          { op: 'add', entry: { id: 'teaching', use: 'teaching' } },
        ],
      },
    });
    const read = vi.spyOn(store, 'read');
    const chat = vi.fn<SkillChatPort['chat']>();
    await expect(
      runtime.invoke(
        'skills.autorun',
        {
          instruction: 'Read the draft',
          requestId: 'disabled-sites',
          resources: { siteId: site.id, baseRevision: site.draft.revision },
        },
        { scope: owner, services: { sitesChat: { manifest: { model: 'test' }, chat } } },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(read).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it('applies host read policy to draft preflight and legacy editing before the model', async () => {
    const { runtime, store, site, edit } = await harness({
      skills: { policy: (name) => name !== 'sites.read' },
    });
    const read = vi.spyOn(store, 'read');
    const chat = vi.fn<SkillChatPort['chat']>();
    const provider = { manifest: { model: 'test' }, chat };
    await expect(
      runtime.invoke(
        'skills.autorun',
        {
          instruction: 'Read the draft',
          requestId: 'denied-read',
          resources: { siteId: site.id, baseRevision: site.draft.revision },
        },
        { scope: owner, services: { sitesChat: provider } },
      ),
    ).rejects.toMatchObject({ code: 'SITE_CAPABILITY_UNAVAILABLE' });
    expect(read).not.toHaveBeenCalled();
    await expect(edit(provider)).rejects.toMatchObject({ code: 'SITE_CAPABILITY_UNAVAILABLE' });
    expect(chat).not.toHaveBeenCalled();
  });

  it('omits publication history from model context and returns a small edit receipt', async () => {
    const { runtime, store, site } = await harness();
    let current = site;
    for (let index = 0; index < 3; index++) {
      current = await store.change(owner.userId, site.id, current.draft.revision, {
        [path]: article(`ARCHIVED-CONTENT-${index}`.repeat(4000)),
      });
      current = await store.publish(owner.userId, site.id, current.draft.revision);
    }
    current = await store.change(owner.userId, site.id, current.draft.revision, {
      [path]: article('Current draft'),
    });
    expect(JSON.stringify(current).length).toBeGreaterThan(180_000);
    const chat = vi
      .fn<SkillChatPort['chat']>()
      .mockResolvedValueOnce(answer({ operation: 'sites.read', input: { id: site.id } }))
      .mockResolvedValueOnce(
        answer({
          operation: 'sites.edit',
          input: {
            id: site.id,
            baseRevision: current.draft.revision,
            changes: { [path]: article('Edited') },
          },
        }),
      )
      .mockResolvedValueOnce(answer({ done: true, summary: 'Saved' }));
    const result = await runtime.invoke<{ site: Site }>(
      'sites.agent.edit',
      {
        id: site.id,
        baseRevision: current.draft.revision,
        instruction: 'Edit current draft',
      },
      { scope: owner, services: { sitesChat: { manifest: { model: 'test' }, chat } } },
    );
    expect(result.site.history.length).toBeGreaterThan(0);
    for (const [request] of chat.mock.calls) {
      expect(request.messages[1].content.length).toBeLessThan(20_000);
      expect(request.messages[1].content).not.toContain('ARCHIVED-CONTENT');
    }
    const lastContext = JSON.parse(chat.mock.calls[2][0].messages[1].content);
    expect(lastContext.results[1].result).toMatchObject({ id: site.id, changedPaths: [path] });
    expect(lastContext.results[1].result.draft.files).toBeUndefined();
  });

  it('does not grant site editing from unbound or forged resource objects', async () => {
    const { runtime, site } = await harness();
    const chat = vi
      .fn<SkillChatPort['chat']>()
      .mockResolvedValue(answer({ operation: 'sites.read', input: { id: site.id } }));
    await expect(
      runtime.invoke(
        'skills.autorun',
        {
          instruction: 'Read',
          requestId: 'unbound',
          resources: { site },
        },
        { scope: owner, services: { sitesChat: { manifest: { model: 'test' }, chat } } },
      ),
    ).rejects.toThrow('unavailable operation');
    expect(
      JSON.parse(chat.mock.calls[0][0].messages[1].content).tools.map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual(['sites.sources', 'sites.source.read']);
  });

  it('returns the existing UI response through native skills and excludes other capabilities from legacy editing', async () => {
    const { runtime, site, edit } = await harness({
      plugins: { teaching: createTeachingPlugin() },
      profile: {
        bundles: ['sites'],
        patches: [{ op: 'add', entry: { id: 'teaching', use: 'teaching' } }],
      },
    });
    const chat = vi
      .fn<SkillChatPort['chat']>()
      .mockResolvedValueOnce(answer({ operation: 'sites.read', input: { id: site.id } }))
      .mockResolvedValueOnce(
        answer({
          operation: 'sites.edit',
          input: {
            id: site.id,
            baseRevision: site.draft.revision,
            changes: { [path]: article('Native agent edit') },
          },
        }),
      )
      .mockResolvedValueOnce(answer({ done: true, summary: 'Edited draft' }));
    const result = await edit({ manifest: { model: 'test' }, chat });
    expect(result).toMatchObject({
      site: { id: site.id, ownerId: owner.userId, history: [] },
      summary: 'Edited draft',
    });
    const context = JSON.parse(chat.mock.calls[0][0].messages[1].content);
    expect(context.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'sites.read',
      'sites.edit',
    ]);
    const events = (await runtime.snapshot(owner)).operations.filter(
      (event) => event.state === 'completed',
    );
    expect(events.map((event) => event.name)).toEqual([
      'sites.read',
      'sites.edit',
      'skills.autorun',
      'sites.agent.edit',
    ]);
  });

  it('checks target ownership and stale revisions before any model call', async () => {
    const { runtime, store, site } = await harness();
    const chat = { manifest: { model: 'test' }, chat: vi.fn<SkillChatPort['chat']>() };
    const input = { id: site.id, baseRevision: site.draft.revision, instruction: 'Edit' };
    await expect(
      runtime.invoke('sites.agent.edit', input, {
        scope: { ...owner, userId: 'bob' },
        services: { sitesChat: chat },
      }),
    ).rejects.toMatchObject({ code: 'SITE_NOT_FOUND' });
    await expect(
      runtime.invoke(
        'skills.autorun',
        {
          instruction: 'Edit',
          requestId: 'wrong-owner',
          resources: { siteId: site.id, baseRevision: site.draft.revision },
        },
        { scope: { ...owner, userId: 'bob' }, services: { sitesChat: chat } },
      ),
    ).rejects.toMatchObject({ code: 'SITE_NOT_FOUND' });
    await store.change(owner.userId, site.id, site.draft.revision, {
      [path]: article('New revision'),
    });
    await expect(
      runtime.invoke('sites.agent.edit', input, { scope: owner, services: { sitesChat: chat } }),
    ).rejects.toMatchObject({ code: 'SITE_CONFLICT' });
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('refuses another owned site selected by the model, even when supplied in resources', async () => {
    const { runtime, store, site } = await harness();
    const other = await store.create(owner.userId, 'Other blog', 'Alice');
    const chat = vi.fn<SkillChatPort['chat']>().mockResolvedValue(
      answer({
        operation: 'sites.edit',
        input: {
          id: other.id,
          baseRevision: other.draft.revision,
          changes: { [path]: article('Unauthorized target') },
        },
      }),
    );
    await expect(
      runtime.invoke(
        'skills.autorun',
        {
          instruction: 'Edit selected blog',
          requestId: 'one-site',
          resources: {
            siteId: site.id,
            baseRevision: site.draft.revision,
            otherSiteId: other.id,
            site: other,
          },
        },
        { scope: owner, services: { sitesChat: { manifest: { model: 'test' }, chat } } },
      ),
    ).rejects.toThrow();
    expect((await store.read(owner.userId, other.id)).draft.revision).toBe(other.draft.revision);
    expect((await store.read(owner.userId, site.id)).draft.revision).toBe(site.draft.revision);
    expect(JSON.parse(chat.mock.calls[0][0].messages[1].content).resources.site.id).toBe(site.id);
  });

  it.each(['sites.change', 'sites.publish', 'sites.rollback', 'sites.agent.edit'])(
    'refuses model-selected privileged operation %s',
    async (operation) => {
      const { site, edit, store } = await harness();
      const chat = {
        manifest: { model: 'test' },
        chat: vi.fn<SkillChatPort['chat']>().mockResolvedValue(
          answer({
            operation,
            input: { id: site.id, baseRevision: site.draft.revision, changes: { [path]: null } },
          }),
        ),
      };
      await expect(edit(chat)).rejects.toThrow('unavailable operation');
      expect((await store.read(owner.userId, site.id)).draft.revision).toBe(site.draft.revision);
      expect((await store.read(owner.userId, site.id)).published).toBeUndefined();
    },
  );

  it('does not let the model rebase onto an unapproved concurrent draft revision', async () => {
    const { site, edit, store } = await harness();
    let updated: Site | undefined;
    const chat = vi.fn<SkillChatPort['chat']>(async () => {
      updated ??= await store.change(owner.userId, site.id, site.draft.revision, {
        [path]: article('Concurrent manual edit'),
      });
      return answer({
        operation: 'sites.edit',
        input: {
          id: site.id,
          baseRevision: updated.draft.revision,
          changes: { [path]: article('Overwrite') },
        },
      });
    });
    await expect(edit({ manifest: { model: 'test' }, chat })).rejects.toThrow();
    expect((await store.read(owner.userId, site.id)).draft.files[path]).toBe(
      article('Concurrent manual edit'),
    );
  });

  it('cancels a model decision before edits and releases the site plugin lease', async () => {
    const { runtime, store, site } = await harness();
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const chat: SkillChatPort = {
      manifest: { model: 'test' },
      chat: async () => {
        entered();
        await gate;
        return answer({
          operation: 'sites.edit',
          input: {
            id: site.id,
            baseRevision: site.draft.revision,
            changes: { [path]: article('Cancelled') },
          },
        });
      },
    };
    const controller = new AbortController();
    const work = runtime.invoke(
      'sites.agent.edit',
      { id: site.id, baseRevision: site.draft.revision, instruction: 'Edit' },
      {
        scope: owner,
        signal: controller.signal,
        services: { sitesChat: chat },
      },
    );
    try {
      await started;
      await expect(runtime.remove('sites')).rejects.toMatchObject({ code: 'PLUGIN_BUSY' });
      controller.abort();
      finish();
      await expect(work).rejects.toMatchObject({ code: 'PRESENTATION_WORKER_CANCELLED' });
      expect((await store.read(owner.userId, site.id)).draft.revision).toBe(site.draft.revision);
      await runtime.remove('sites');
    } finally {
      controller.abort();
      finish();
      await work.catch(() => undefined);
    }
  });
});
