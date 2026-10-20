import { describe, expect, it, vi } from 'vitest';

import { type LessonPlan, lessonPlanSchema } from '@/types/presentationLesson';

import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import { createPresentationContentCompiler } from './content-intent';
import { assertPresentationPublishable } from './content-quality';
import {
  applyTeacherLessonInstruction,
  assertLessonPublicContent,
  assertLessonPublishable,
  assertLessonRevision,
  bindLessonPlan,
  compileLessonInput,
  lessonHandout,
  prepareLessonDraft,
  proposeLesson,
  publicLessonStages,
  readLessonPlan,
} from './lesson';
import type { MultimodalChatPort } from './multimodal-chat-provider';
import { createPresentationOutlineCapability } from './outline-capability';
import { InMemoryPresentationPlanWorker } from './worker';

const lessonFixture = (): LessonPlan => ({
  schemaVersion: 1,
  brief: {
    intention: '先预测方向，后解释，不代替教师板书',
    audience: '知道导数的学生',
    priorKnowledge: '导数',
    learningGoal: '解释下降方向',
    durationMinutes: 12,
  },
  beats: [
    {
      id: 'predict',
      title: '判断方向',
      objective: '由导数迁移到下降方向',
      teacherCue: '教师私有：等待两个相反意见',
      studentAction: '画出你认为的方向',
      checkForUnderstanding: '是否说明方向的依据',
      durationMinutes: 4,
      locked: true,
      frames: [
        {
          id: 'question',
          title: '往哪里走？',
          kind: 'question',
          visibleContent: [],
          visualCue: '等高线和起点，无箭头',
          withheldContent: ['负梯度方向'],
          boardSpace: 'none',
        },
        {
          id: 'reveal',
          title: '负梯度方向',
          kind: 'boardwork',
          visibleContent: ['联系导数解释方向'],
          visualCue: '保留原等高线',
          withheldContent: [],
          boardSpace: 'right-third',
        },
      ],
    },
  ],
});
const input = (lesson = lessonFixture()) => ({
  notebookId: 'n',
  title: '梯度下降',
  sourceVersionIds: [],
  prompt: '这里包含旧答案和私有备注',
  options: { lessonPlan: lesson },
});
const svg = (text: string, x = 30) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="${x}" y="60" font-size="28">${text}</text></svg>`;
const rendered = (): PresentationPlan => ({
  planId: 'p',
  title: '梯度下降',
  aspectRatio: '16:9',
  sourceVersionIds: [],
  slides: [
    { slideId: 'slide-1', order: 1, svg: svg('往哪里走？') },
    { slideId: 'slide-2', order: 2, svg: svg('负梯度方向 联系导数解释方向') },
  ],
});
const chat = (responses: unknown[]): MultimodalChatPort => ({
  providerId: 'test',
  manifest: {
    providerId: 'test',
    model: 'test',
    displayName: 'Test',
    supportsVision: false,
    supportsIdempotency: true,
  },
  chat: vi.fn(async () => ({
    choices: [
      {
        index: 0,
        message: { role: 'assistant' as const, content: JSON.stringify(responses.shift()) },
      },
    ],
    created: 0,
    id: 'r',
    model: 'test',
  })),
});
const scope = { userId: 'u', sessionId: 's' };

describe('teacher-led lesson contracts', () => {
  it('honors the explicit cover opening and forwards conversational revision instructions', async () => {
    const lesson = lessonFixture();
    lesson.brief.opening = 'cover';
    const provider = chat([lesson]);
    const result = await createPresentationOutlineCapability({ chat: provider }).execute(
      {
        brief: { topic: '最优化算法与原理', teacherBrief: lesson.brief },
        operation: 'propose',
        instruction: '先展示课程名，再让学生预测',
      },
      { scope },
    );
    expect(result.lessonPlan?.beats[0].frames[0]).toMatchObject({
      kind: 'cover',
      title: '最优化算法与原理',
      visibleContent: [],
    });
    expect(result.lessonPlan?.beats[1].frames[0].kind).toBe('question');
    expect(JSON.stringify(vi.mocked(provider.chat).mock.calls[0][0].messages)).toContain(
      '先展示课程名，再让学生预测',
    );
  });
  it('routes explicit teaching mode through the existing outline API without exposing notes', async () => {
    const lesson = lessonFixture();
    const result = await createPresentationOutlineCapability({ chat: chat([lesson]) }).execute(
      { brief: { topic: '梯度下降', teacherBrief: lesson.brief }, operation: 'propose' },
      { scope },
    );
    expect(result.lessonPlan?.beats).toHaveLength(1);
    expect(result.slides).toHaveLength(2);
    expect(JSON.stringify(result.slides)).not.toContain('教师私有');
  });
  it('checks literal LaTeX sources before they become image prompts or vector paths', () => {
    const lesson = lessonFixture();
    lesson.beats[0].frames[0].withheldContent = ['x-\\alpha'];
    expect(() =>
      assertLessonPublicContent(lesson, 0, { formulas: [{ latex: 'x-\\alpha' }] }),
    ).toThrow('withheld');
    const plan = bindLessonPlan(rendered(), input(lesson));
    plan.slides[0].metadata!.contentBlocks = [{ kind: 'formula', latex: 'x-\\alpha' }];
    expect(() => assertLessonPublishable(plan)).toThrow('withheld');
  });
  it('rejects an answer-bearing page before publishing a draft preview', () => {
    const slide = { ...rendered().slides[0], svg: svg('往哪里走？负梯度方向') };
    expect(() => prepareLessonDraft(slide, input())).toThrow('withheld');
    expect(prepareLessonDraft(rendered().slides[1], input()).metadata?.lessonFrameId).toBe(
      'reveal',
    );
  });
  it('keeps ordinary jobs unchanged and compiles frames without private notes', () => {
    const ordinary = { notebookId: 'n', title: 'Report', sourceVersionIds: [] };
    expect(compileLessonInput(ordinary)).toBe(ordinary);
    const result = compileLessonInput(input());
    expect(result.slideCount).toBe(2);
    expect(JSON.stringify(result.options?.outline)).not.toContain('教师私有');
    expect(result.prompt).not.toContain('旧答案');
    expect(publicLessonStages(result, ['slide-1'])).toEqual([
      expect.objectContaining({ kind: 'question', visibleContent: [], advance: 'teacher' }),
    ]);
    expect(JSON.stringify(publicLessonStages(result, ['slide-1']))).not.toContain('负梯度方向');
  });
  it('rejects duplicate IDs and a prematurely visible answer', () => {
    const lesson = lessonFixture();
    lesson.beats[0].frames[1].id = 'question';
    expect(lessonPlanSchema.safeParse(lesson).success).toBe(false);
    lesson.beats[0].frames[1].id = 'reveal';
    lesson.beats[0].frames[0].visibleContent = ['负梯度方向'];
    expect(lessonPlanSchema.safeParse(lesson).success).toBe(false);
  });
  it('protects teacher brief and locked content in AI revisions', () => {
    const previous = lessonFixture();
    const next = structuredClone(previous);
    next.beats[0].teacherCue = '替换讲法';
    expect(() => assertLessonRevision(previous, next)).toThrow('Teacher-locked');
    expect(() =>
      assertLessonRevision(previous, {
        ...previous,
        brief: { ...previous.brief, intention: 'AI的想法' },
      }),
    ).toThrow('Teacher brief');
    expect(() => assertLessonRevision(previous, previous)).not.toThrow();
  });
  it('does not let a proposal create a teacher lock', async () => {
    const lesson = lessonFixture();
    const result = await proposeLesson(
      chat([lesson]),
      { brief: lesson.brief, topic: '梯度下降' },
      { scope },
    );
    expect(result.beats[0].locked).toBe(false);
  });
  it('isolates future answers and cues during content and image-brief compilation', async () => {
    const response = {
      slides: [
        {
          slideId: 'slide-1',
          claim: '观察',
          formulas: [],
          visualKind: 'none',
          visualReason: '思考空间',
          visuals: [],
        },
      ],
    };
    const port = chat([response, response]);
    const compiled = await createPresentationContentCompiler(port).compile(
      compileLessonInput(input()),
      { scope },
    );
    expect(compiled.slides.map((slide) => slide.slideId)).toEqual(['slide-1', 'slide-2']);
    const calls = vi.mocked(port.chat).mock.calls;
    expect(JSON.stringify(calls[0][0])).not.toContain('负梯度方向');
    expect(JSON.stringify(calls)).not.toContain('教师私有：');
  });
  it('blocks a compiler that inserts a withheld answer in an image brief', async () => {
    const response = {
      slides: [
        {
          slideId: 'slide-1',
          claim: '观察',
          formulas: [],
          visualKind: 'illustration',
          visualReason: '图',
          visuals: [{ id: 'image', kind: 'illustration', brief: '标出负梯度方向', required: true }],
        },
      ],
    };
    await expect(
      createPresentationContentCompiler(chat([response])).compile(compileLessonInput(input()), {
        scope,
      }),
    ).rejects.toThrow('withheld');
  });
  it('binds notes and reserves boardwork without scaling', () => {
    const plan = bindLessonPlan(rendered(), input());
    expect(plan.slides[1].svg).toContain('data-lesson-board="reveal"');
    expect(plan.slides[1].svg).toContain('<rect x="640" y="86"');
    expect(plan.slides[1].svg).toContain('课堂推导');
    expect(plan.slides[1].svg).toContain('font-size="28"');
    expect(plan.slides[0].notes).toContain('教师私有：');
    expect(() => assertPresentationPublishable(plan)).not.toThrow();
    expect(bindLessonPlan(plan, input()).slides[1].svg).toBe(plan.slides[1].svg);
    expect(lessonHandout(plan)).not.toContain('教师私有：');
    expect(lessonHandout(plan)).not.toContain('暂不展示');
  });
  it('migrates the old full-height board mask without cutting off the shared header', () => {
    const legacy = rendered();
    legacy.slides[1].svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect x="0" y="0" width="960" height="64" fill="#1e56a0"/><text x="48" y="43" font-size="28">负梯度方向 联系导数解释方向</text><rect data-lesson-board="reveal" x="640" y="0" width="320" height="540" fill="#ffffff"/></svg>`;
    const rebound = bindLessonPlan(legacy, input());
    expect(rebound.slides[1].svg).toContain('width="960" height="64" fill="#1e56a0"');
    expect(rebound.slides[1].svg).not.toContain('y="0" width="320" height="540"');
    expect(rebound.slides[1].svg).toContain('<rect x="640" y="86"');
    expect(() => assertLessonPublishable(rebound)).not.toThrow();
  });
  it('lets an explicit teacher message replace a selected boardwork stage with full-width derivation', () => {
    const original = input();
    const revised = applyTeacherLessonInstruction(original, {
      content: '不要现场板书，直接在这一页展示完整推导',
      target: { type: 'slide', slideNumber: 2 },
    });
    const frame = readLessonPlan(revised)!.beats[0].frames[1];
    expect(frame).toMatchObject({ boardSpace: 'none', kind: 'explanation' });
    expect(frame.visualCue).toContain('完整画布');
    expect(publicLessonStages(revised)).toHaveLength(2);
    const cleaned = bindLessonPlan(bindLessonPlan(rendered(), original), revised);
    expect(cleaned.slides[1].svg).not.toContain('data-lesson-board');
  });
  it('blocks leaks, missing locked content, changed metadata, and cropped boardwork', () => {
    const plan = bindLessonPlan(rendered(), input());
    const leak = structuredClone(plan);
    leak.slides[0].svg = svg('往哪里走？负 梯 度 方 向');
    expect(() => assertLessonPublishable(leak)).toThrow('withheld');
    const missing = structuredClone(plan);
    missing.slides[0].svg = svg('AI重写后的题目');
    expect(() => assertLessonPublishable(missing)).toThrow('lost approved');
    const changed = structuredClone(plan);
    changed.slides[0].metadata!.lessonFrameId = 'reveal';
    expect(() => assertLessonPublishable(changed)).toThrow('identity');
    const clipped = rendered();
    clipped.slides[1].svg = svg('负梯度方向 联系导数解释方向', 800).replace('y="60"', 'y="120"');
    expect(() => assertLessonPublishable(bindLessonPlan(clipped, input()))).toThrow('clipped');
  });
  it('exports a separate student handout without private teacher notes', async () => {
    const plan = bindLessonPlan(rendered(), input());
    const write = vi.fn();
    const result = await new InMemoryPresentationPlanWorker().run(plan, {
      jobId: 'lesson-job',
      workspace: { path: '/tmp/lesson-test', write },
      qualityCheck: async () => ({ passed: true }),
      convert: async () => [
        {
          bytes: new Uint8Array([1]),
          name: 'lesson.pptx',
          mimeType: 'application/octet-stream',
          type: 'pptx',
        },
      ],
    });
    const handout = result.artifacts.find(
      (artifact) => artifact.metadata?.artifactRole === 'student-handout',
    );
    expect(handout).toBeDefined();
    expect(new TextDecoder().decode(handout!.bytes)).not.toContain('教师私有');
    expect(
      write.mock.calls.some(
        ([name, content]) =>
          String(name).startsWith('notes/') && String(content).includes('教师私有'),
      ),
    ).toBe(true);
  });
});
