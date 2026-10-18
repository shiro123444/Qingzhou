import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryPresentationArtifactStore } from './artifact-store';
import type { PresentationCollaborationInput } from './collaboration-plugin';
import {
  createPresentationDecision,
  decidePresentationCollaboration,
} from './collaboration-plugin';
import type { PresentationPresenceTab } from './file-storage';
import { PresentationGenerationPort } from './generation-port';

const scope = { request: new Request('https://example.test'), userId: 'u1', sessionId: 's1' };
const input = {
  notebookId: 'n1',
  title: 'Existing report',
  sourceVersionIds: ['source-1'],
  slideCount: 1,
};
const plan = {
  planId: 'p',
  title: input.title,
  sourceVersionIds: input.sourceVersionIds,
  aspectRatio: '16:9',
  slides: [
    {
      slideId: 'slide-1',
      order: 1,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="48" y="120" font-size="24">Approved source content</text></svg>',
    },
  ],
};
const ports: PresentationGenerationPort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.dispose();
  vi.useRealTimers();
});

function fixture(
  options: { code?: string; now?: () => string; passive?: boolean; saved?: any } = {},
) {
  let saved = options.saved;
  const presence: PresentationPresenceTab[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = vi.fn(async () => {
    await gate;
    throw Object.assign(new Error('private provider payload'), {
      code: options.code ?? 'CHAT_EMPTY_RESPONSE',
    });
  });
  const hook = vi.fn(async (value: PresentationCollaborationInput) =>
    decidePresentationCollaboration(value),
  );
  const config = {
    artifactStore: new InMemoryPresentationArtifactStore(),
    capability: { execute, plan: vi.fn() } as never,
    idFactory: () => 'collaboration-job',
    now: options.now,
    collaborationHook: hook,
    repository: {
      ...(options.passive ? { acquireLease: vi.fn(async () => null) } : {}),
      getJob: vi.fn(async () => (saved ? structuredClone(saved) : null)),
      readPresence: vi.fn(async () => structuredClone(presence)),
      saveJob: vi.fn(async (_scope: unknown, snapshot: unknown) => {
        saved = structuredClone(snapshot);
      }),
      savePresence: vi.fn(
        async (_scope: unknown, _jobId: string, tabs: PresentationPresenceTab[]) => {
          presence.splice(0, presence.length, ...structuredClone(tabs));
        },
      ),
    },
    contextFactory: () => ({
      plannerContext: {},
      workerContext: {
        jobId: 'unused',
        convert: vi.fn(),
        qualityCheck: vi.fn(),
        workspace: { path: '/tmp', write: vi.fn() },
      },
    }),
  };
  const port = new PresentationGenerationPort(config, scope);
  ports.push(port);
  return { port, config, execute, hook, presence, release, snapshot: () => saved };
}

describe('presentation collaboration hook', () => {
  it.each([
    ['adaptive', true, 0, 'CHAT_EMPTY_RESPONSE', 'ask'],
    ['adaptive', false, 0, 'CHAT_EMPTY_RESPONSE', 'retry'],
    ['adaptive', false, 2, 'CHAT_EMPTY_RESPONSE', 'ask'],
    ['adaptive', false, 0, 'IMAGE_PLAN_INVALID', 'retry'],
    ['adaptive', false, 2, 'IMAGE_PLAN_INVALID', 'ask'],
    ['ask', false, 0, 'VISUAL_QUALITY_FAILED', 'ask'],
    ['auto', true, 0, 'VISUAL_QUALITY_FAILED', 'retry'],
    ['auto', false, 0, 'PRESENTATION_CONFLICT', 'ask'],
    ['auto', false, 0, 'INPUT_REQUIRED', 'ask'],
    ['auto', false, 0, 'FILESYSTEM_DENIED', 'fail'],
  ] as const)(
    '%s foreground=%s attempt=%s code=%s => %s',
    (mode, foreground, automaticAttempts, code, action) => {
      expect(
        decidePresentationCollaboration({ mode, foreground, automaticAttempts, code }).action,
      ).toBe(action);
    },
  );

  it('persists a foreground question, defers without running and resumes the same work idempotently', async () => {
    const f = fixture();
    await f.port.createJob(input);
    await f.port.updatePresence('collaboration-job', {
      tabId: 'tab-1',
      visible: true,
      focused: true,
    });
    f.release();
    await vi.waitFor(async () =>
      expect((await f.port.getJob('collaboration-job'))?.state).toBe('waiting_input'),
    );
    const question = f.snapshot().job.collaboration.decisions[0];
    expect(JSON.stringify(question)).not.toContain('private provider');
    expect(f.snapshot().input.sourceVersionIds).toEqual(['source-1']);
    await f.port.answerDecision('collaboration-job', {
      decisionId: question.id,
      requestId: 'later',
      action: 'defer',
    });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.snapshot().job.collaboration.decisions[0].status).toBe('deferred');
    f.execute.mockImplementation(async () => ({ artifacts: [], plan }) as never);
    const answer = { decisionId: question.id, requestId: 'answer-1', action: 'retry' as const };
    await Promise.all([
      f.port.answerDecision('collaboration-job', answer),
      f.port.answerDecision('collaboration-job', answer),
    ]);
    await vi.waitFor(async () =>
      expect((await f.port.getJob('collaboration-job'))?.state).toBe('completed'),
    );
    expect(f.execute).toHaveBeenCalledTimes(2);
    await expect(
      f.port.answerDecision('collaboration-job', {
        ...answer,
        action: 'revise',
        content: 'different',
      }),
    ).rejects.toMatchObject({ code: 'PRESENTATION_CONFLICT' });
    await expect(
      f.port.answerDecision('collaboration-job', { ...answer, requestId: 'stale' }),
    ).rejects.toMatchObject({ code: 'PRESENTATION_CONFLICT' });
  });

  it('expires stale foreground tabs and stops background recovery after two attempts', async () => {
    vi.useFakeTimers();
    let time = Date.now();
    const f = fixture({ now: () => new Date(time).toISOString() });
    await f.port.createJob(input);
    await f.port.updatePresence('collaboration-job', {
      tabId: 'tab-1',
      visible: true,
      focused: true,
    });
    time += 46_000;
    f.release();
    await vi.waitFor(async () => expect(f.hook).toHaveBeenCalledTimes(1));
    expect(f.hook.mock.calls[0][0].foreground).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.execute).toHaveBeenCalledTimes(3);
    expect((await f.port.getJob('collaboration-job'))?.state).toBe('waiting_input');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.execute).toHaveBeenCalledTimes(3);
  });

  it('keeps another focused tab active when one tab leaves', async () => {
    const f = fixture();
    await f.port.createJob(input);
    for (const tabId of ['one', 'two'])
      await f.port.updatePresence('collaboration-job', { tabId, visible: true, focused: true });
    await f.port.updatePresence('collaboration-job', {
      tabId: 'two',
      visible: false,
      focused: false,
    });
    f.release();
    await vi.waitFor(() => expect(f.hook).toHaveBeenCalled());
    expect(f.hook.mock.calls[0][0].foreground).toBe(true);
  });

  it('forwards presence to the shared store while a peer executor owns the job', async () => {
    const f = fixture({ passive: true });
    await f.port.createJob(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.port.updatePresence('collaboration-job', {
      tabId: 'peer-tab',
      visible: true,
      focused: true,
    });
    expect(f.presence).toEqual([expect.objectContaining({ active: true, tabId: 'peer-tab' })]);
  });

  it('honours the foreground tab a peer executor reported through the shared store', async () => {
    const f = fixture();
    // Another port instance already reported this tab; this executor owns the lease but
    // has no local presence of its own.
    f.presence.push({ active: true, seenAt: Date.now(), tabId: 'peer-tab' });
    await f.port.createJob(input);
    f.release();
    await vi.waitFor(() => expect(f.hook).toHaveBeenCalled());
    expect(f.hook.mock.calls[0][0].foreground).toBe(true);
  });

  it('restores a saved question without re-running, and applies a free-form answer', async () => {
    const decision = createPresentationDecision(
      'quality',
      'saved-question',
      '2026-10-15T00:00:00Z',
    );
    const f = fixture({
      saved: {
        input,
        job: {
          jobId: 'collaboration-job',
          state: 'waiting_input',
          createdAt: decision.createdAt,
          updatedAt: decision.createdAt,
          collaboration: { mode: 'adaptive', automaticAttempts: 2, decisions: [decision] },
        },
      },
    });
    expect((await f.port.getJob('collaboration-job'))?.state).toBe('waiting_input');
    expect(f.execute).not.toHaveBeenCalled();
    await expect(
      f.port.answerDecision('collaboration-job', {
        decisionId: decision.id,
        requestId: 'blank',
        action: 'revise',
        content: ' ',
      }),
    ).rejects.toMatchObject({ code: 'PRESENTATION_INVALID' });
    f.execute.mockImplementation(async () => ({ artifacts: [], plan }) as never);
    await f.port.answerDecision('collaboration-job', {
      decisionId: decision.id,
      requestId: 'direction',
      action: 'revise',
      content: '保留原图，表格统一蓝色',
    });
    await vi.waitFor(async () =>
      expect((await f.port.getJob('collaboration-job'))?.state).toBe('completed'),
    );
    expect(f.snapshot().job.messages[0].content).toBe('保留原图，表格统一蓝色');
  });

  it('cancellation during a background delay prevents another model call', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.port.createJob(input);
    f.release();
    await vi.waitFor(() => expect(f.hook).toHaveBeenCalled());
    await f.port.cancelJob('collaboration-job');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect((await f.port.getJob('collaboration-job'))?.state).toBe('cancelled');
  });
});
