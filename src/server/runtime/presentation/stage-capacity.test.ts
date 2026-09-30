import { describe, expect, it } from 'vitest';

import { readContentIntents } from './content-intent';
import { readLessonPlan } from './lesson';
import { rebalanceMixedLessonStages, rebasePlanForLessonStages } from './stage-capacity';

const input = (locked = false) => ({
  notebookId: 'notebook',
  title: '最优化',
  sourceVersionIds: [],
  slideCount: 1,
  options: {
    lessonPlan: {
      schemaVersion: 1 as const,
      brief: {
        intention: '讲解随机优化',
        audience: '本科生',
        priorKnowledge: '梯度',
        learningGoal: '比较方法',
        durationMinutes: 20,
      },
      beats: [
        {
          id: 'beat-1',
          title: '随机优化',
          objective: '理解方法权衡',
          teacherCue: '引导比较',
          studentAction: '观察',
          checkForUnderstanding: '解释差异',
          durationMinutes: 5,
          locked,
          frames: [
            {
              id: 'frame-1',
              title: '从确定性到随机',
              kind: 'explanation' as const,
              visibleContent: ['全批量代价', 'SGD 随机梯度', '动量的作用', 'AdamW 的权衡'],
              visualCue: '左侧路径图，右侧科研图',
              withheldContent: [],
              boardSpace: 'none' as const,
            },
          ],
        },
      ],
    },
    contentIntents: {
      inputFingerprint: 'old',
      slides: [
        {
          slideId: 'slide-1',
          claim: '从确定性到随机',
          formulas: [{ id: 'formula-1', latex: 'g_t=\\nabla f_i(x_t)' }],
          visualKind: 'scientific-illustration' as const,
          visualReason: '比较',
          visuals: [
            {
              id: 'visual-1',
              kind: 'scientific-illustration' as const,
              renderer: 'image' as const,
              brief: 'SGD路径',
              required: true,
            },
            {
              id: 'visual-2',
              kind: 'scientific-diagram' as const,
              renderer: 'native' as const,
              brief: '方法权衡科研图',
              required: true,
            },
          ],
        },
      ],
    },
  },
});

describe('teaching stage capacity', () => {
  it('splits an overfull mixed-media stage before artwork and layout planning', () => {
    const balanced = rebalanceMixedLessonStages(input());
    const frames = readLessonPlan(balanced)!.beats[0].frames;
    const intents = readContentIntents(balanced);
    expect(balanced.slideCount).toBe(2);
    expect(frames.map((frame) => frame.visibleContent)).toEqual([
      ['全批量代价', 'SGD 随机梯度'],
      ['动量的作用', 'AdamW 的权衡'],
    ]);
    expect(intents.map((intent) => intent.visuals?.map((visual) => visual.id))).toEqual([
      ['visual-1'],
      ['visual-2'],
    ]);
    expect(intents[0].formulas).toHaveLength(1);
    expect(intents[1].formulas).toHaveLength(0);
    expect(balanced.options?.layoutAutoSplits).toEqual(['frame-1']);
  });
  it('splits a measured derivation off its figure when both cannot stay readable', () => {
    const source = input();
    const intent = source.options.contentIntents.slides[0];
    intent.visuals = [intent.visuals[0]];
    intent.formulas = [
      {
        id: 'formula-1',
        latex: 'L',
        measurement: { fontSize: 28, width: 500, height: 80, minRectWidth: 545, minRectHeight: 91 },
      },
      {
        id: 'formula-2',
        latex: 'g',
        measurement: { fontSize: 28, width: 700, height: 80, minRectWidth: 785, minRectHeight: 91 },
      },
      {
        id: 'formula-3',
        latex: 'h',
        measurement: { fontSize: 28, width: 600, height: 30, minRectWidth: 614, minRectHeight: 38 },
      },
      {
        id: 'formula-4',
        latex: 'd',
        measurement: { fontSize: 28, width: 200, height: 28, minRectWidth: 264, minRectHeight: 36 },
      },
    ].slice() as unknown as NonNullable<typeof intent.formulas>;
    const balanced = rebalanceMixedLessonStages(source);
    const intents = readContentIntents(balanced);
    expect(balanced.slideCount).toBe(2);
    expect(intents[0].formulas).toHaveLength(4);
    expect(intents[0].visualKind).toBe('none');
    expect(intents[1].formulas).toHaveLength(0);
    expect(intents[1].visuals?.map((visual) => visual.id)).toEqual(['visual-1']);
    expect(readLessonPlan(balanced)!.beats[0].frames[1].title).toContain('图解');
  });
  it('carries the source figure onto the split diagram page', () => {
    const previous = input();
    const intent = previous.options.contentIntents.slides[0];
    intent.visuals = [intent.visuals[0]];
    intent.formulas = [
      {
        id: 'formula-1',
        latex: 'L',
        measurement: { fontSize: 28, width: 500, height: 80, minRectWidth: 545, minRectHeight: 91 },
      },
      {
        id: 'formula-2',
        latex: 'g',
        measurement: { fontSize: 28, width: 700, height: 80, minRectWidth: 785, minRectHeight: 91 },
      },
      {
        id: 'formula-3',
        latex: 'h',
        measurement: { fontSize: 28, width: 600, height: 30, minRectWidth: 614, minRectHeight: 38 },
      },
      {
        id: 'formula-4',
        latex: 'd',
        measurement: { fontSize: 28, width: 200, height: 28, minRectWidth: 264, minRectHeight: 36 },
      },
    ].slice() as unknown as NonNullable<typeof intent.formulas>;
    const next = rebalanceMixedLessonStages(previous);
    const rebased = rebasePlanForLessonStages(
      {
        planId: 'draft',
        title: '最优化',
        aspectRatio: '16:9',
        sourceVersionIds: [],
        slides: [
          {
            slideId: 'slide-1',
            order: 1,
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><image href="/api/runtime/presentation/artifacts/owned-image" x="48" y="120" width="864" height="300"/></svg>',
            metadata: { contentBlocks: [] },
          },
        ],
      },
      previous,
      next,
    );
    expect(rebased.slides).toHaveLength(2);
    expect(rebased.slides[1].svg).toContain('owned-image');
  });
  it('does not alter a teacher-locked stage', () => {
    expect(rebalanceMixedLessonStages(input(true))).toEqual(input(true));
  });
  it('rebases an existing draft and moves the native source to its continuation page', () => {
    const previous = input();
    const next = rebalanceMixedLessonStages(previous);
    const plan = {
      planId: 'draft',
      title: '最优化',
      aspectRatio: '16:9',
      sourceVersionIds: [],
      slides: [
        {
          slideId: 'slide-1',
          order: 1,
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><image href="/api/runtime/presentation/artifacts/owned-image" x="50" y="100" width="400" height="300"/><g data-scientific-diagram="visual-2"><text x="480" y="200">plot</text></g></svg>',
          metadata: {
            contentBlocks: [
              { id: 'formula-1', kind: 'formula', latex: 'x' },
              { id: 'visual-2', kind: 'scientific-diagram', spec: { type: 'plot' } },
            ],
          },
        },
      ],
    };
    const rebased = rebasePlanForLessonStages(plan, previous, next);
    expect(rebased.slides).toHaveLength(2);
    expect(rebased.slides[0].svg).toContain('owned-image');
    expect(rebased.slides[0].svg).not.toContain('data-scientific-diagram');
    expect(rebased.slides[0].svg).not.toContain('>plot</text>');
    expect(rebased.slides[1].svg).not.toContain('owned-image');
    expect(rebased.slides[1].metadata?.contentBlocks).toEqual([
      expect.objectContaining({ id: 'visual-2' }),
    ]);
  });
});
