// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MultimodalChatPort } from '@/server/runtime/presentation/multimodal-chat-provider';
import * as userChat from '@/server/runtime/presentation/user-chat-provider';
import type { Site } from '@/server/runtime/sites/contracts';
import * as siteRuntime from '@/server/runtime/sites/runtime';
import { SiteStore } from '@/server/runtime/sites/store';

import { POST } from './route';

const authenticated = vi.hoisted(() => ({ userId: 'alice' }));
vi.mock('@/app/(backend)/middleware/auth', () => ({
  checkAuth:
    (
      handler: (
        request: Request,
        scope: { userId: string; serverDB: unknown },
      ) => Promise<Response>,
    ) =>
    async (request: Request) =>
      handler(request, { userId: authenticated.userId, serverDB: {} }),
}));

const path = 'src/content/blog/welcome.md';
const article = (text: string) =>
  `---\ntitle: "Article"\ndescription: "Course notes"\npublishDate: 2026-10-10\ntags: []\n---\n\n${text}\n`;
const answer = (value: unknown) => ({
  id: 'test',
  model: 'test',
  created: 0,
  choices: [{ index: 0, message: { role: 'assistant' as const, content: JSON.stringify(value) } }],
});
const post = (
  operation: string,
  input: unknown,
  extra: Record<string, unknown> = {},
  origin = 'https://qingzhou.test',
) =>
  POST(
    new Request('https://qingzhou.test/api/runtime/sites', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ operation, input, ...extra }),
    }),
    { params: Promise.resolve({}) },
  );

let folder: string;
let host: ReturnType<typeof siteRuntime.createSitesRuntime>;
let site: Site;
let model: MultimodalChatPort;
let chat: ReturnType<typeof vi.fn<MultimodalChatPort['chat']>>;
const otherHosts: ReturnType<typeof siteRuntime.createSitesRuntime>[] = [];
beforeEach(async () => {
  authenticated.userId = 'alice';
  folder = await mkdtemp(nodePath.join(tmpdir(), 'qingzhou-sites-route-'));
  host = siteRuntime.createSitesRuntime({ store: new SiteStore(folder) });
  site = await host.store.create('alice', 'Course blog', 'Alice');
  chat = vi.fn<MultimodalChatPort['chat']>();
  model = {
    providerId: 'test',
    manifest: {
      providerId: 'test',
      model: 'test',
      displayName: 'Test',
      supportsVision: false,
      supportsIdempotency: true,
    },
    chat,
  };
  vi.spyOn(siteRuntime, 'getSitesRuntime').mockResolvedValue(host);
  vi.spyOn(userChat, 'createUserChatProvider').mockReturnValue(model);
});
afterEach(async () => {
  await host.runtime.dispose();
  await Promise.all(otherHosts.splice(0).map((value) => value.runtime.dispose()));
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

describe('site runtime HTTP boundary', () => {
  it('runs the production education profile with the authenticated model and writes only public stages', async () => {
    const education = await siteRuntime.createProductionSitesRuntime(
      { store: host.store },
      'education',
    );
    otherHosts.push(education);
    vi.spyOn(siteRuntime, 'getSitesRuntime').mockResolvedValue(education);
    const plan = {
      schemaVersion: 1,
      brief: {
        intention: 'Explain vectors',
        audience: 'Students',
        priorKnowledge: 'Addition',
        learningGoal: 'Understand direction',
        durationMinutes: 10,
        opening: 'direct',
      },
      beats: [
        {
          id: 'predict',
          title: 'Predict',
          objective: 'Understand direction',
          teacherCue: 'PRIVATE TEACHER NOTE',
          studentAction: 'Draw',
          checkForUnderstanding: 'Explain',
          durationMinutes: 5,
          locked: false,
          frames: [
            {
              id: 'question',
              title: 'Which direction?',
              kind: 'question',
              visibleContent: ['Observe the axes'],
              visualCue: '',
              withheldContent: ['WITHHELD ANSWER'],
              boardSpace: 'none',
            },
          ],
        },
      ],
    };
    chat.mockResolvedValueOnce(answer(plan));
    const response = await post('skills.run', {
      steps: [
        {
          id: 'plan',
          operation: 'teaching.lesson.plan',
          input: { brief: plan.brief, topic: 'Vectors' },
        },
        { id: 'compile', operation: 'teaching.lesson.compile', input: { plan: { $ref: 'plan' } } },
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
    });
    expect(response.status).toBe(200);
    expect(chat.mock.calls[0][1].scope.userId).toBe('alice');
    const saved = await host.store.read('alice', site.id);
    expect(saved.draft.files[path]).toContain('Observe the axes');
    expect(saved.draft.files[path]).toContain('draft: true');
    expect(saved.draft.files[path]).not.toContain('PRIVATE TEACHER NOTE');
    expect(saved.draft.files[path]).not.toContain('WITHHELD ANSWER');
    expect(saved.published).toBeUndefined();
  });

  it('exposes the trusted composition catalog without resolving or invoking a model', async () => {
    const response = await post('skills.catalog', {});
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'sites.sources',
      'sites.source.read',
      'sites.read',
      'sites.edit',
    ]);
    expect(userChat.createUserChatProvider).not.toHaveBeenCalled();
  });

  it('executes a native read/edit recipe and rejects publishing through the same endpoint', async () => {
    const response = await post('skills.run', {
      steps: [
        { id: 'read', operation: 'sites.read', input: { id: site.id } },
        {
          id: 'edit',
          operation: 'sites.edit',
          input: {
            id: { $ref: 'read.id' },
            baseRevision: { $ref: 'read.draft.revision' },
            changes: { [path]: article('HTTP recipe') },
          },
        },
      ],
    });
    expect(response.status).toBe(200);
    expect((await host.store.read('alice', site.id)).draft.files[path]).toBe(
      article('HTTP recipe'),
    );
    const forbidden = await post('skills.run', {
      steps: [
        {
          id: 'publish',
          operation: 'sites.publish',
          input: { id: site.id, baseRevision: site.draft.revision },
        },
      ],
    });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe('SITE_FORBIDDEN');
    expect((await host.store.read('alice', site.id)).published).toBeUndefined();
  });

  it('retains the existing manual deletion protocol without exposing it to model composition', async () => {
    const response = await post('sites.change', {
      id: site.id,
      baseRevision: site.draft.revision,
      changes: { [path]: null },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).result.draft.files).toEqual({});
  });

  it('keeps the old agent edit request and response while invoking the shared skills loop', async () => {
    chat
      .mockResolvedValueOnce(
        answer({
          operation: 'sites.edit',
          input: {
            id: site.id,
            baseRevision: site.draft.revision,
            changes: { [path]: article('UI edit') },
          },
        }),
      )
      .mockResolvedValueOnce(answer({ done: true, summary: 'Edited draft' }));
    const response = await post('sites.agent.edit', {
      id: site.id,
      baseRevision: site.draft.revision,
      instruction: 'Edit',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      result: { summary: 'Edited draft', site: { id: site.id, ownerId: 'alice', history: [] } },
    });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[0][1].scope).toEqual({ userId: 'alice', sessionId: 'sites:alice' });
  });

  it('injects the authenticated account model for generic autorun and checks ownership first', async () => {
    const input = {
      instruction: 'Edit',
      requestId: 'native-edit',
      resources: { siteId: site.id, baseRevision: site.draft.revision },
    };
    authenticated.userId = 'bob';
    const rejected = await post('skills.autorun', input);
    expect(rejected.status).toBe(404);
    expect(chat).not.toHaveBeenCalled();
    authenticated.userId = 'alice';
    chat
      .mockResolvedValueOnce(
        answer({
          operation: 'sites.edit',
          input: {
            id: site.id,
            baseRevision: site.draft.revision,
            changes: { [path]: article('Generic autorun') },
          },
        }),
      )
      .mockResolvedValueOnce(answer({ done: true, summary: 'Saved' }));
    const response = await post('skills.autorun', input);
    expect(response.status).toBe(200);
    expect((await response.json()).result.result).toMatchObject({
      id: site.id,
      changedPaths: [path],
    });
    expect(chat.mock.calls[0][1].scope.userId).toBe('alice');
  });

  it('refuses caller-supplied policy and execution scope as well as cross-origin requests', async () => {
    const injected = await post(
      'skills.catalog',
      {},
      { policy: { allow: ['sites.publish'] }, services: { sitesChat: {} } },
    );
    expect(injected.status).toBe(400);
    const forgedScope = await post('sites.edit', {
      id: site.id,
      baseRevision: site.draft.revision,
      changes: { [path]: article('No') },
      scope: { userId: 'alice' },
    });
    expect(forgedScope.status).toBe(400);
    const foreign = await post('skills.catalog', {}, {}, 'https://foreign.test');
    expect(foreign.status).toBe(403);
    expect(chat).not.toHaveBeenCalled();
  });

  it('reports a capability disabled by the server profile without falling back to a global model', async () => {
    const disabled = siteRuntime.createSitesRuntime({
      store: host.store,
      profile: {
        bundles: ['sites'],
        patches: [{ op: 'remove', id: 'skills' }],
      },
    });
    otherHosts.push(disabled);
    vi.mocked(siteRuntime.getSitesRuntime).mockResolvedValue(disabled);
    const response = await post('sites.agent.edit', {
      id: site.id,
      baseRevision: site.draft.revision,
      instruction: 'Edit',
    });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('SITE_CAPABILITY_UNAVAILABLE');
    expect(chat).not.toHaveBeenCalled();
  });
});
