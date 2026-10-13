// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LessonPlan } from '@/types/presentationLesson';

import type { PresentationJobInput } from '../../../../packages/runtime-contracts/src';
import { AtomicRuntime } from '../atomic-runtime';
import { InMemoryPresentationArtifactStore } from '../presentation/artifact-store';
import { createPresentationAtomicRuntime } from '../presentation/atomic-plugin';
import { bindLessonPlan } from '../presentation/lesson';
import type { MultimodalChatPort } from '../presentation/multimodal-chat-provider';
import { createPresentationOutlineCapability } from '../presentation/outline-capability';
import { createProductionPresentationGenerationComposition } from '../presentation/production-factory';
import { createTeachingPlugin } from './atomic-plugin';
import type { CompiledLesson } from './lesson';

const scope = { userId: 'teacher', sessionId: 'lesson-session' };
const lesson = (): LessonPlan => ({
  schemaVersion: 1,
  brief: {
    intention: '先预测再解释',
    audience: '学习导数的学生',
    priorKnowledge: '导数',
    learningGoal: '解释下降方向',
    durationMinutes: 10,
    opening: 'direct',
  },
  beats: [
    {
      id: 'predict',
      title: '预测方向',
      objective: '迁移导数知识',
      teacherCue: '等待两种相反的意见',
      studentAction: '画出自己的预测',
      checkForUnderstanding: '能否解释方向',
      durationMinutes: 4,
      locked: true,
      frames: [
        {
          id: 'question',
          title: '往哪里走？',
          kind: 'question',
          visibleContent: [],
          visualCue: '仅显示等高线和起点',
          withheldContent: ['负梯度方向'],
          boardSpace: 'none',
        },
      ],
    },
  ],
});
const response = () => ({
  id: 'lesson-response',
  model: 'test',
  created: 0,
  choices: [
    {
      index: 0,
      message: { role: 'assistant' as const, content: JSON.stringify(lesson()) },
    },
  ],
});
const chat = (): MultimodalChatPort => ({
  providerId: 'test',
  manifest: {
    providerId: 'test',
    model: 'test',
    displayName: 'Test',
    supportsVision: false,
    supportsIdempotency: true,
  },
  chat: vi.fn(async () => response()),
});
const runtimes: AtomicRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

const presentation = (provider = chat()) => {
  const plan = {
    planId: 'deck',
    title: '下降方向',
    aspectRatio: '16:9',
    sourceVersionIds: [],
    slides: [
      {
        slideId: 'slide-1',
        order: 1,
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="40" y="80">往哪里走？</text></svg>',
      },
    ],
  };
  const planner = { plan: vi.fn(async () => structuredClone(plan)) };
  const runtime = createPresentationAtomicRuntime({
    artifactStore: new InMemoryPresentationArtifactStore(),
    chatPort: provider,
    planner,
    worker: { run: vi.fn() },
  });
  runtimes.push(runtime);
  return { plan, planner, runtime };
};

describe('independent teaching plugin', () => {
  it('uses the teaching host in the production outline UI and fails after unloading it', async () => {
    const provider = chat();
    const { composition } = createProductionPresentationGenerationComposition({
      multimodalChatPort: provider,
    });
    const command = {
      brief: { topic: '下降方向', teacherBrief: lesson().brief },
      operation: 'propose' as const,
    };
    try {
      const result = await composition.outlineCapability!.execute(command, { scope });
      expect(result.slides[0]).toMatchObject({ id: 'question', title: '往哪里走？' });
      expect((await composition.atomicRuntime!.snapshot(scope)).operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'teaching.lesson.plan', state: 'completed' }),
        ]),
      );
      await composition.atomicRuntime!.remove('teaching');
      await expect(
        composition.outlineCapability!.execute(command, { scope }),
      ).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
      });
      await expect(
        createPresentationOutlineCapability({ atomicRuntime: null, chat: provider }).execute(
          command,
          { scope },
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect(provider.chat).toHaveBeenCalledTimes(1);
    } finally {
      await composition.dispose();
    }
  });

  it('plans, validates and compiles public stages without mounting presentation or a renderer', async () => {
    const runtime = new AtomicRuntime([createTeachingPlugin({ chat: chat() })]);
    runtimes.push(runtime);
    const proposed = await runtime.invoke<LessonPlan>(
      'teaching.lesson.plan',
      { brief: lesson().brief, topic: '下降方向' },
      { scope },
    );
    expect(proposed.beats[0].locked).toBe(false);
    const compiled = await runtime.invoke<CompiledLesson>(
      'teaching.lesson.compile',
      { plan: proposed },
      { scope },
    );
    expect(compiled.stages).toEqual([
      expect.objectContaining({
        advance: 'teacher',
        beatId: 'predict',
        frameId: 'question',
        title: '往哪里走？',
      }),
    ]);
    expect(JSON.stringify(compiled)).not.toContain('等待两种相反的意见');
    expect(JSON.stringify(compiled)).not.toContain('负梯度方向');
    await expect(
      runtime.invoke('teaching.lesson.validate', { plan: proposed }, { scope }),
    ).resolves.toEqual({ passed: true });
    const changed = lesson();
    changed.beats[0].teacherCue = '改掉教师锁定的内容';
    await expect(
      runtime.invoke('teaching.lesson.revise', { previous: lesson(), next: changed }, { scope }),
    ).rejects.toThrow('Teacher-locked');
    expect((await runtime.snapshot(scope)).plugins.map(({ id }) => id)).toEqual(['teaching']);
    await runtime.remove('teaching');
    expect(await runtime.catalog()).toEqual([]);
    await expect(
      runtime.invoke('teaching.lesson.compile', { plan: proposed }, { scope }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('routes legacy PPT lesson operations through teaching and preserves the PPT conversion contract', async () => {
    const { runtime, planner, plan } = presentation();
    const input: PresentationJobInput = {
      notebookId: 'course',
      title: plan.title,
      sourceVersionIds: [],
      options: { lessonPlan: lesson() },
    };
    const compiled = await runtime.invoke<PresentationJobInput>(
      'presentation.lesson.compile',
      { input },
      { scope },
    );
    expect(compiled).toMatchObject({
      slideCount: 1,
      options: { lessonPlan: lesson(), outline: [{ id: 'question', title: '往哪里走？' }] },
    });
    expect(JSON.stringify(compiled.options?.outline)).not.toContain('等待两种相反的意见');
    await expect(
      runtime.invoke(
        'presentation.lesson.revise',
        { previous: lesson(), next: lesson() },
        { scope },
      ),
    ).resolves.toEqual(lesson());
    await expect(
      runtime.invoke(
        'presentation.lesson.validate',
        { plan: bindLessonPlan(plan, input) },
        { scope },
      ),
    ).resolves.toEqual({ passed: true });
    await runtime.invoke('presentation.plan', { input }, { scope });
    expect(planner.plan).toHaveBeenCalledWith(compiled, expect.objectContaining({ scope }));
    const completed = (await runtime.snapshot(scope)).operations
      .filter(({ state }) => state === 'completed')
      .map(({ name }) => name);
    expect(completed).toEqual(
      expect.arrayContaining([
        'teaching.lesson.compile',
        'teaching.lesson.revise',
        'teaching.lesson.validate',
      ]),
    );

    await runtime.remove('teaching');
    await expect(
      runtime.invoke('presentation.lesson.compile', { input }, { scope }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const ordinary = { notebookId: 'n', title: 'Ordinary', sourceVersionIds: [] };
    await expect(
      runtime.invoke('presentation.lesson.compile', { input: ordinary }, { scope }),
    ).resolves.toEqual(ordinary);
    await expect(
      runtime.invoke('presentation.slide.read', { plan, slideId: 'slide-1' }, { scope }),
    ).resolves.toEqual(plan.slides[0]);
  });

  it('holds both plugin leases while a legacy lesson proposal is running', async () => {
    const provider = chat();
    let finish!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(provider.chat).mockImplementation(async () => {
      entered();
      await gate;
      return response();
    });
    const { runtime } = presentation(provider);
    const pending = runtime.invoke(
      'presentation.lesson.plan',
      { brief: lesson().brief, topic: '下降方向' },
      { scope },
    );
    try {
      await started;
      await expect(runtime.remove('teaching')).rejects.toMatchObject({ code: 'PLUGIN_BUSY' });
      await expect(runtime.remove('presentation')).rejects.toMatchObject({ code: 'PLUGIN_BUSY' });
      finish();
      await pending;
      await runtime.remove('teaching');
      await expect(
        runtime.invoke(
          'presentation.lesson.plan',
          { brief: lesson().brief, topic: '下降方向' },
          { scope },
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect(provider.chat).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      await pending.catch(() => undefined);
    }
  });
});
