import { describe, expect, it } from 'vitest';

import { inspectPresentationContent } from './content-quality';
import {
  assertDeckBodyFits,
  createDeckVisualSystem,
  renderDeckVisualFrame,
} from './deck-visual-system';
import { measureFormula } from './formula-renderer';
import { prepareLessonDraft } from './lesson';
import { recoverSemanticSlideLayout } from './semantic-layout-recovery';

describe('measured semantic layout recovery', () => {
  it('reserves a full-width table before supplementary outline prose', async () => {
    const result = await recoverSemanticSlideLayout({
      aspectRatio: '16:9',
      title: '两大板块',
      deckBody: { x: 48, y: 136, width: 864, height: 364 },
      intent: {
        slideId: 'slide-2',
        claim: '工作概览',
        formulas: [],
        visualKind: 'chart',
        visualReason: '指标比较',
        visuals: [
          {
            id: 'summary',
            kind: 'chart',
            renderer: 'native',
            fidelity: 'conceptual',
            required: true,
            brief: '两大板块指标表',
          },
        ],
      },
      visibleContent: ['招生与就业工作持续推进，完成招生任务并改进生源质量。'.repeat(20)],
      rawBlocks: [
        {
          id: 'summary',
          kind: 'scientific-diagram',
          title: '工作概览',
          rect: { x: 48, y: 136, width: 864, height: 300 },
          provenance: { kind: 'source', reference: '用户材料' },
          spec: {
            type: 'table',
            columns: ['板块', '进展', '下一步'],
            rows: [
              ['招生就业', '录取68人，第一志愿72人', '优化重点高中宣传'],
              ['产教融合', '三家企业已签约合作', '深化课程与师资共建'],
              ['平台建设', '两项申请等待学校审批', '推动实训条件改善'],
              ['课程建设', '三类核心课程协同建设', '推动企业案例进课堂'],
              ['教师发展', '校企双师团队协同育人', '落实实践教学安排'],
            ],
          },
        },
      ],
    });
    expect(result.svg).toContain('data-report-table');
    expect(result.svg).toContain('录取68人');
    expect(result.svg).toContain('等待学校审批');
    expect('overflowNotes' in result && result.overflowNotes).toBeTruthy();
  });
  it('measures long Chinese paragraphs with the same font as the shared master', async () => {
    const system = createDeckVisualSystem({
      notebookId: 'n',
      title: '学校支持申请',
      sourceVersionIds: [],
      options: { style: '商务' },
    })!;
    const result = await recoverSemanticSlideLayout({
      aspectRatio: '16:9',
      title: '难点堵点与学校支持申请',
      rawBlocks: [],
      deckBody: system.body,
      intent: {
        slideId: 'slide-17',
        claim: '两项支持申请',
        formulas: [],
        visualKind: 'none',
        visualReason: '申请事项',
      },
      visibleContent: [
        '难点一：缺乏高精度机器视觉系统、协作机械臂与端侧算力设备，学生高阶算法工程调试与真机实操存在硬性瓶颈',
        '申请①：立项建设“人工智能与具身智能综合实训实验室”，配置高精度视觉台架、协作机械臂与算力工作站（属申请事项，待学校审批）',
        '申请②：设立校企协同育人与学科培育专项经费，支持重大产学研攻关、科技成果奖培育、产教教材出版及企业专家入校津贴（属申请事项，待学校审批）',
      ],
    });
    const svg = renderDeckVisualFrame(result.svg, system, {
      title: '难点堵点与学校支持申请',
      role: 'content',
      order: 17,
      total: 18,
    });
    await expect(assertDeckBodyFits(svg, system, 'content')).resolves.toBeUndefined();
    expect(svg).toContain('font-size="24"');
    expect(svg).toContain('待学校审批');
  });
  it('reserves the measured plot legend and keeps a generated image on the same page', async () => {
    const intent = {
      slideId: 'slide-11',
      claim: '随机方法权衡',
      visualKind: 'scientific-diagram' as const,
      visualReason: '算法比较',
      formulas: [{ id: 'formula-1', latex: String.raw`g_t=\nabla f_i(x_t)` }],
      visuals: [
        {
          id: 'visual-1',
          kind: 'scientific-illustration' as const,
          renderer: 'image' as const,
          fidelity: 'conceptual' as const,
          brief: '算法路径',
          required: true,
        },
        {
          id: 'visual-2',
          kind: 'scientific-diagram' as const,
          renderer: 'native' as const,
          fidelity: 'conceptual' as const,
          brief: '方法曲线',
          required: true,
        },
      ],
    };
    const result = await recoverSemanticSlideLayout({
      aspectRatio: '16:9',
      intent,
      title: intent.claim,
      imageRefs: ['/api/runtime/presentation/artifacts/owned-figure'],
      visibleContent: ['比较每步计算成本', '观察不同方法的下降轨迹'],
      rawBlocks: [
        {
          id: 'visual-2',
          kind: 'scientific-diagram',
          title: '四种方法',
          rect: { x: 480, y: 240, width: 400, height: 180 },
          provenance: { kind: 'illustrative' },
          spec: {
            type: 'plot',
            xRange: [0, 1],
            yRange: [0, 1],
            xLabel: 'x',
            yLabel: 'value',
            series: ['GD', 'SGD', 'Adam', 'AdamW'].map((label) => ({
              label,
              points: [
                [0, 0],
                [1, 1],
              ],
            })),
          },
        },
      ],
    });
    expect(result.svg).toContain('/api/runtime/presentation/artifacts/owned-figure');
    expect(result.svg).toContain('比较每步计算成本');
    expect(result.svg).toContain('观察不同方法的下降轨迹');
    expect(result.svg).not.toContain('•');
    const plot = result.blocks.find((block) => block.id === 'visual-2');
    expect(plot?.rect.height).toBeGreaterThanOrEqual(224);
  });
  it('reflows the failed momentum page without shrinking formulas or losing the computed plot', async () => {
    const latex = String.raw`v_{k+1} = \beta v_k + \alpha \nabla f(x_k), \quad x_{k+1} = x_k - v_{k+1}`;
    const intent = {
      slideId: 'slide-6',
      claim: '引入动量：从被动跟随到外插预判',
      visualKind: 'scientific-diagram' as const,
      visualReason: '比较轨迹',
      formulas: [
        { id: 'formula-1', latex, measurement: await measureFormula({ latex }), fontSize: 28 },
        { id: 'formula-2', latex: String.raw`y_k=x_k+\beta(x_k-x_{k-1})`, fontSize: 28 },
        { id: 'formula-3', latex: String.raw`x_{k+1}=y_k-\alpha\nabla f(y_k)`, fontSize: 28 },
      ],
      visuals: [
        {
          id: 'visual-1',
          kind: 'scientific-diagram' as const,
          renderer: 'native' as const,
          fidelity: 'computed' as const,
          brief: 'NAG轨迹',
          required: true,
        },
      ],
    };
    const result = await recoverSemanticSlideLayout({
      aspectRatio: '16:9',
      intent,
      title: intent.claim,
      rawBlocks: [
        {
          id: 'visual-1',
          kind: 'scientific-diagram',
          title: '梯度下降与动量',
          rect: { x: 40, y: 150, width: 400, height: 300 },
          provenance: { kind: 'illustrative' },
          spec: {
            type: 'quadratic',
            a: 1,
            b: 20,
            levels: [4, 12, 24],
            start: [-3, 1.2],
            learningRate: 0.08,
            steps: 16,
            methods: ['gradient', 'nesterov'],
          },
        },
      ],
    });
    expect(result.blocks).toHaveLength(4);
    expect(result.blocks[0].kind).toBe('formula');
    expect(result.blocks[0].rect.width).toBe(420);
    expect(result.blocks[0].rect.height).toBeGreaterThan(36);
    expect(result.svg).toContain('data-formula-latex');
    expect(result.svg).toContain('data-scientific-diagram');
    expect(
      inspectPresentationContent({
        planId: 'recovery',
        title: intent.claim,
        aspectRatio: '16:9',
        sourceVersionIds: [],
        slides: [{ slideId: 'slide-6', order: 6, svg: result.svg }],
      }).passed,
    ).toBe(true);
  });
  it('keeps every text and semantic block inside a teacher-reserved boardwork page', async () => {
    const title = '微分判据与极值充要性推导';
    const formulas = [
      String.raw`f(y) \ge f(x) + \nabla f(x)^T (y-x)`,
      String.raw`\nabla^2 f(x) \succeq 0`,
      String.raw`\nabla f(x^*)=0`,
    ];
    const intent = {
      slideId: 'slide-1',
      claim: title,
      visualKind: 'scientific-diagram' as const,
      visualReason: '凸函数几何',
      formulas: formulas.map((latex, i) => ({ id: `formula-${i + 1}`, latex })),
      visuals: [
        {
          id: 'visual-1',
          kind: 'scientific-diagram' as const,
          renderer: 'native' as const,
          fidelity: 'computed' as const,
          brief: '单变量凸函数曲线及参考点处的切线',
          required: true,
        },
      ],
    };
    const recovered = await recoverSemanticSlideLayout({
      aspectRatio: '16:9',
      boardSpace: 'right-third',
      intent,
      title,
      rawBlocks: [
        {
          id: 'visual-1',
          kind: 'scientific-diagram',
          title: '凸函数曲线',
          rect: { x: 48, y: 250, width: 520, height: 220 },
          provenance: { kind: 'illustrative' },
          spec: {
            type: 'plot',
            xRange: [-1, 1],
            yRange: [0, 1],
            xLabel: 'x',
            yLabel: 'f(x)',
            series: [
              {
                label: 'invented',
                points: [
                  [-1, 1],
                  [1, 1],
                ],
              },
            ],
          },
        },
      ],
    });
    const lessonPlan = {
      schemaVersion: 1 as const,
      brief: {
        intention: '讲解凸性',
        audience: '本科生',
        priorKnowledge: '',
        learningGoal: '凸性',
        durationMinutes: 5,
      },
      beats: [
        {
          id: 'beat',
          title,
          objective: title,
          teacherCue: '',
          studentAction: '',
          checkForUnderstanding: '',
          durationMinutes: 5,
          locked: false,
          frames: [
            {
              id: 'frame',
              title,
              kind: 'boardwork' as const,
              visibleContent: [],
              visualCue: '',
              withheldContent: [],
              boardSpace: 'right-third' as const,
            },
          ],
        },
      ],
    };
    const prepared = prepareLessonDraft(
      {
        slideId: 'slide-1',
        order: 1,
        svg: recovered.svg,
        metadata: { contentBlocks: recovered.blocks },
      },
      {
        notebookId: 'n',
        title,
        sourceVersionIds: [],
        options: { lessonPlan },
      },
    );
    expect(prepared.svg).toContain('data-lesson-board="frame"');
    expect(prepared.svg).toContain('data-scientific-diagram');
    const scientific = recovered.blocks.find((block) => block.id === 'visual-1');
    expect(scientific?.kind === 'scientific-diagram' && scientific.spec.type).toBe('taylor');
  });
});
