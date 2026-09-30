import { describe, expect, it } from 'vitest';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import { renderScientificDiagram, semanticBlockSchema } from './semantic-blocks';
import type { TemplateApplication } from './templates';
import {
  reconcileEvidenceBasedVisualReview,
  reconcileTypedFormulaReview,
  stampLockedTemplateChrome,
} from './visual-stabilizer';

const template = {
  visual: {
    designProgram: {
      invariants: ['二级标题必须有红色矩形引导块前缀'],
      tokens: { palette: ['#2C6EB5', '#0A2F6E', '#B21818', '#FFFFFF'] },
    },
  },
} as TemplateApplication;

describe('visual stabilizer', () => {
  it('does not recolor panels or diagrams by guessing brand roles from prose', () => {
    const svg =
      '<svg viewBox="0 0 960 540"><rect x="460" y="332" width="465" height="164" fill="#f0fdf4" stroke="#86efac"/><rect x="480" y="346" width="14" height="14" fill="#2C6EB5"/><text x="504" y="359" font-size="24" font-weight="bold" fill="#15803d">结论</text></svg>';
    expect(stampLockedTemplateChrome(svg, template)).toBe(svg);
  });
  it.each(['#008000', '#7B246E'])(
    'uses an explicit %s header contract on the actual canvas',
    (fill) => {
      const chromeTemplate = {
        visual: {
          designProgram: {
            archetypes: [
              {
                id: 'body',
                header: {
                  box: { x: 0, y: 0, width: 1, height: 0.1 },
                  fill,
                  textColor: '#FFFFFF',
                },
              },
            ],
          },
        },
      } as unknown as TemplateApplication;
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 900"><rect width="1200" height="900" fill="#ffffff"/><text x="48" y="66" font-size="32">Title</text></svg>';
      const stamped = stampLockedTemplateChrome(svg, chromeTemplate, 'body');
      const document = parseString(stamped);
      const header = Array.from(document.getElementsByTagName('rect')).find(
        (rect) => rect.getAttribute('data-template-chrome') === 'header',
      )!;
      expect(header.getAttribute('fill')).toBe(fill);
      expect(header.getAttribute('width')).toBe('1200');
      expect(header.getAttribute('height')).toBe('90');
      expect(header.previousSibling?.nodeName).toBe('rect');
      expect(header.nextSibling?.nodeName).toBe('text');
      expect(stamped).not.toContain('#B21818');
      expect(stampLockedTemplateChrome(stamped, chromeTemplate, 'body')).toBe(stamped);
    },
  );
  it('does not infer a brand from prose or apply a different page family', () => {
    const svg = '<svg viewBox="0 0 960 540"><text x="48" y="66" font-size="32">Title</text></svg>';
    const source = {
      visual: {
        designProgram: {
          invariants: ['顶部通栏标题栏常驻'],
          tokens: { palette: ['#008000'] },
          archetypes: [],
        },
      },
    } as unknown as TemplateApplication;
    expect(stampLockedTemplateChrome(svg, source)).toBe(svg);
  });
  it('rejects a critic claim contradicted by the native formula source but retains geometry reports', () => {
    const latex = '\\nabla^2 f(x) \\succeq 0';
    const plan = {
      planId: 'p',
      title: 'math',
      aspectRatio: '16:9',
      sourceVersionIds: [],
      designSpec: {},
      slides: [
        {
          slideId: 'slide-4',
          order: 4,
          svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><g data-content-id="formula-2" data-formula-latex="${latex}"><path d="M 0 0 L 1 1"/></g></svg>`,
          metadata: { contentBlocks: [{ id: 'formula-2', kind: 'formula', latex }] },
        },
      ],
    } as PresentationPlan;
    const review = {
      schemaVersion: 1 as const,
      passed: false,
      summary: 'Check formula',
      issues: [
        {
          category: 'formula' as const,
          severity: 'major' as const,
          slideId: 'slide-4',
          evidence: 'approved latex 明确要求半正定符号，渲染成了标量大于号',
          instruction: `使用 ${latex} 的半正定符号`,
        },
        {
          category: 'formula' as const,
          severity: 'major' as const,
          slideId: 'slide-4',
          evidence: '大括号断裂',
          instruction: '重新布局括号',
        },
      ],
    };
    expect(reconcileTypedFormulaReview(review, plan).issues).toHaveLength(1);
    expect(reconcileTypedFormulaReview(review, plan).passed).toBe(false);
    const short = {
      ...review,
      issues: [
        {
          ...review.issues[0],
          instruction: String.raw`将二阶条件修正为标准矩阵半正定符号 \succeq。`,
        },
      ],
    };
    expect(reconcileTypedFormulaReview(short, plan).issues).toEqual([]);
    expect(
      reconcileTypedFormulaReview(
        { ...short, issues: [{ ...short.issues[0], blockId: 'missing' }] },
        plan,
      ).issues,
    ).toHaveLength(1);
    const wrong = {
      ...plan,
      slides: [
        {
          ...plan.slides[0],
          metadata: {
            contentBlocks: [{ id: 'formula-2', kind: 'formula', latex: String.raw`x \geq 0` }],
          },
        },
      ],
    } as PresentationPlan;
    expect(reconcileTypedFormulaReview(short, wrong).issues).toHaveLength(1);
  });
  it('adjudicates in-bitmap arrow complaints when the server owns those annotations', () => {
    const plan = {
      planId: 'p',
      title: 'annotated',
      aspectRatio: '16:9',
      sourceVersionIds: [],
      designSpec: {},
      slides: [
        {
          slideId: 'slide-9',
          order: 9,
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><image href="/api/runtime/presentation/artifacts/a" x="480" y="135" width="480" height="270"/><g data-asset-annotations="visual-1"><path d="M 500 400 L 800 200"/></g></svg>',
          metadata: {
            visualRequirements: [
              {
                id: 'visual-1',
                kind: 'scientific-diagram',
                brief: '受力几何图',
                required: true,
                renderer: 'image',
                fidelity: 'conceptual',
                annotations: [
                  {
                    type: 'vector',
                    from: { x: 0.1, y: 0.9 },
                    to: { x: 0.8, y: 0.2 },
                    label: '−∇f(x*)',
                  },
                ],
              },
            ],
          },
        },
      ],
    } as unknown as PresentationPlan;
    const review = {
      schemaVersion: 1 as const,
      passed: false,
      summary: 'Check vectors',
      issues: [
        {
          category: 'scientific-semantics' as const,
          severity: 'major' as const,
          slideId: 'slide-9',
          visualId: 'visual-1',
          evidence: '蓝箭头标注为 -∇f(x*) 却与 ∇g(x*) 反向共线，方向画反',
          instruction: '重绘箭头方向',
        },
        {
          category: 'scientific-semantics' as const,
          severity: 'major' as const,
          slideId: 'slide-9',
          visualId: 'visual-1',
          evidence: '图中缺少约束集合的边界',
          instruction: '补充集合边界',
        },
      ],
    };
    const result = reconcileEvidenceBasedVisualReview(review, plan);
    // Arrow direction is server-owned now; the missing object is still actionable.
    expect(result.review.issues).toHaveLength(1);
    expect(result.review.issues[0].evidence).toContain('缺少约束集合');
    expect(result.adjudications).toEqual([
      expect.objectContaining({
        reason: 'server-drawn-annotations',
        slideId: 'slide-9',
        visualId: 'visual-1',
      }),
    ]);
  });
  it('adjudicates only a certified native radar collision, retaining altered geometry', () => {
    const block = semanticBlockSchema.parse({
      id: 'visual-2',
      kind: 'scientific-diagram',
      title: '算法权衡',
      rect: { x: 392, y: 134, width: 536, height: 346 },
      provenance: { kind: 'source', reference: 'Kingma & Ba (2015)' },
      spec: {
        type: 'radar',
        axes: ['额外显存占用', '单步计算开销', '收敛步数需求', '稀疏特征适应性'],
        series: [
          { label: 'GD', values: [0.2, 0.9, 0.85, 0.2] },
          { label: 'AdamW', values: [0.85, 0.35, 0.3, 0.85] },
        ],
      },
    });
    if (block.kind !== 'scientific-diagram') throw new Error('Invalid fixture');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">${renderScientificDiagram(block)}</svg>`;
    const plan = {
      planId: 'p',
      title: 'math',
      aspectRatio: '16:9',
      sourceVersionIds: [],
      designSpec: {},
      slides: [{ slideId: 'slide-12', order: 12, svg, metadata: { contentBlocks: [block] } }],
    } as PresentationPlan;
    const review = {
      schemaVersion: 1 as const,
      passed: false,
      summary: 'Radar issue',
      issues: [
        {
          category: 'legibility' as const,
          severity: 'major' as const,
          slideId: 'slide-12',
          visualId: 'visual-2',
          evidence: '雷达图左侧顶点压盖轴标签“稀疏特征适应性”',
          instruction: '将标签与折线分离',
        },
      ],
    };
    const certified = reconcileEvidenceBasedVisualReview(review, plan);
    expect(certified.review.passed).toBe(true);
    expect(certified.adjudications).toMatchObject([
      {
        reason: 'verified-native-radar-clearance',
        slideId: 'slide-12',
      },
    ]);
    const altered = parseString(svg);
    const label = Array.from(altered.getElementsByTagName('text')).find(
      (node) => node.textContent === '稀疏特征适应性',
    )!;
    label.setAttribute('x', '270');
    const uncertain = reconcileEvidenceBasedVisualReview(review, {
      ...plan,
      slides: [{ ...plan.slides[0], svg: altered.toString() }],
    });
    expect(uncertain.review.passed).toBe(false);
    expect(uncertain.review.issues).toHaveLength(1);
  });
});
