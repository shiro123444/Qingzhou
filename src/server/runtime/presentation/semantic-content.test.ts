import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import { createPresentationContentCompiler } from './content-intent';
import { assertPresentationPublishable, inspectPresentationContent } from './content-quality';
import { measureFormula, renderFormula } from './formula-renderer';
import { initialDesignPlan } from './initial-design';
import type { MultimodalChatPort } from './multimodal-chat-provider';
import { createMultimodalPresentationPlanner } from './multimodal-planner-glm';
import {
  renderScientificDiagram,
  renderSemanticBlocks,
  semanticAuthoringSvg,
  semanticBlockSchema,
} from './semantic-blocks';
import { inspectVisualOccupancy } from './visual-ownership';
import { reconcileEvidenceBasedVisualReview } from './visual-stabilizer';

const scope = { userId: 'scientist', sessionId: 'course' };
const formula = {
  id: 'update',
  kind: 'formula' as const,
  latex: 'x_{k+1}=x_k-\\alpha_k\\nabla f(x_k)',
  display: true,
  fontSize: 28,
  color: '#172554',
  rect: { x: 80, y: 150, width: 760, height: 100 },
};
const intent = {
  slideId: 'slide-1',
  claim: '沿负梯度更新参数',
  formulas: [{ id: formula.id, latex: formula.latex }],
  visualKind: 'none' as const,
  visualReason: '展示参数更新公式',
  visuals: [],
};
const envelope =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="40" y="70" font-size="32">梯度下降</text><g data-content-id="update"/></svg>';
const plan = (svg: string): PresentationPlan => ({
  planId: 'p1',
  title: '最优化',
  aspectRatio: '16:9',
  sourceVersionIds: [],
  designSpec: { contentPolicyVersion: 1 },
  slides: [{ slideId: 'slide-1', order: 1, svg }],
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
    id: 'response',
    model: 'test',
  })),
});

describe('semantic presentation content', () => {
  it('keeps a short graph edge label when a node sits on the right edge', () => {
    const block = semanticBlockSchema.parse({
      id: 'visual-1',
      kind: 'scientific-diagram',
      title: '拟牛顿',
      provenance: { kind: 'illustrative' },
      rect: { x: 48, y: 120, width: 420, height: 280 },
      spec: {
        type: 'graph',
        nodes: [
          { id: 'newton', label: '牛顿法', x: 1, y: 0.15 },
          { id: 'bfgs', label: 'BFGS', x: 1, y: 0.85 },
        ],
        edges: [{ from: 'newton', to: 'bfgs', label: '秩二逼近' }],
      },
    });
    const svg = renderScientificDiagram(
      block as Extract<typeof block, { kind: 'scientific-diagram' }>,
    );
    expect(svg).toContain('秩二逼近');
  });
  it('renders a qualitative four-axis radar instead of substituting a flow chart', () => {
    const block = semanticBlockSchema.parse({
      id: 'visual-2',
      kind: 'scientific-diagram',
      title: '算法权衡',
      provenance: { kind: 'illustrative' },
      rect: { x: 476, y: 280, width: 438, height: 216 },
      spec: {
        type: 'radar',
        axes: ['单步计算', '显存', '曲率适应', '鞍点逃逸'],
        series: [
          { label: '全批量GD', values: [0.3, 0.2, 0.4, 0.2] },
          { label: 'SGD', values: [0.9, 0.7, 0.3, 0.6] },
          { label: 'AdamW', values: [0.7, 0.4, 0.8, 0.9] },
        ],
      },
    });
    const svg = renderScientificDiagram(
      block as Extract<typeof block, { kind: 'scientific-diagram' }>,
    );
    expect(svg).toContain('鞍点逃逸');
    expect(svg).toContain('AdamW');
    expect(svg.match(/<polygon /gu)).toHaveLength(5);
  });
  it('keeps native radar vertices clear of multi-line axis labels and reserves the citation footer', () => {
    const block = semanticBlockSchema.parse({
      id: 'radar',
      kind: 'scientific-diagram',
      title: '算法权衡',
      provenance: {
        kind: 'source',
        reference: 'Kingma & Ba, Adam (ICLR 2015); Loshchilov & Hutter, AdamW (ICLR 2019)',
      },
      rect: { x: 470, y: 138, width: 436, height: 342 },
      spec: {
        type: 'radar',
        axes: ['额外显存占用', '单步计算开销', '收敛步数需求', '稀疏特征适应性'],
        series: [
          { label: 'AdamW', values: [0.85, 0.35, 0.3, 0.85] },
          { label: 'SGD', values: [0.15, 0.15, 0.75, 0.35] },
        ],
      },
    });
    const svg = renderScientificDiagram(
      block as Extract<typeof block, { kind: 'scientific-diagram' }>,
    );
    const document = parseString(`<svg xmlns="http://www.w3.org/2000/svg">${svg}</svg>`);
    const text = Array.from(document.getElementsByTagName('text'));
    const right = text.filter((node) => /单步计算|开销/u.test(node.textContent ?? ''));
    const left = text.filter((node) => /稀疏特征|适应性/u.test(node.textContent ?? ''));
    expect(left.map((node) => node.textContent)).toEqual(['稀疏特征适应性']);
    const polygons = Array.from(document.getElementsByTagName('polygon'));
    const outer = polygons[1]
      .getAttribute('points')!
      .split(' ')
      .map((point) => point.split(',').map(Number));
    expect(right.every((node) => Number(node.getAttribute('x')) >= outer[1][0] + 16)).toBe(true);
    expect(left.every((node) => Number(node.getAttribute('x')) <= outer[3][0] - 16)).toBe(true);
    expect(text.some((node) => (node.textContent ?? '').includes('ICLR 2019'))).toBe(true);
    const bottom = text.find((node) => (node.textContent ?? '') === '收敛步数需求')!;
    const firstSource = text.find((node) => (node.textContent ?? '').startsWith('来源：'))!;
    expect(
      Number(firstSource.getAttribute('y')) - Number(bottom.getAttribute('y')),
    ).toBeGreaterThanOrEqual(32);
  });
  it('renders a continuous native cases brace while preserving its LaTeX source', async () => {
    const latex = '\\begin{cases} x=0 \\\\ y=1 \\\\ z=2 \\\\ w=3 \\end{cases}';
    const svg = await renderFormula({
      ...formula,
      latex,
      rect: { x: 200, y: 180, width: 380, height: 180 },
    });
    const document = parseString(`<svg xmlns="http://www.w3.org/2000/svg">${svg}</svg>`);
    const group = document.getElementsByTagName('g')[0];
    expect(group.getAttribute('data-formula-latex')).toBe(latex);
    expect(
      Array.from(group.getElementsByTagName('path')).filter((path) => path.getAttribute('stroke')),
    ).toHaveLength(1);
    expect(svg).toContain('stroke-linejoin="round"');
  });
  it('renders a compact plot without a legend instead of failing an under-reserved page', () => {
    const block = semanticBlockSchema.parse({
      id: 'visual-compact',
      kind: 'scientific-diagram',
      provenance: { kind: 'illustrative' },
      rect: { height: 186, width: 420, x: 60, y: 120 },
      spec: {
        series: [
          { label: '曲线 f(tx+(1-t)y)', polynomial: [0, 0, 1] },
          { label: '割线 tf(x)+(1-t)f(y)', polynomial: [0, 1] },
          { label: '参考基线', polynomial: [0.2, 0] },
        ],
        type: 'plot',
        xLabel: 't',
        xRange: [0, 1],
        yLabel: 'f',
        yRange: [0, 1],
      },
      title: '凸性与割线',
    });
    const svg = renderScientificDiagram(
      block as Extract<typeof block, { kind: 'scientific-diagram' }>,
    );
    // The legend row would not have fitted, so every series is labelled at its end instead.
    expect(svg).not.toContain('M 48 27 h 18');
    for (const label of ['曲线 f(tx+(1-t)y)', '割线 tf(x)+(1-t)f(y)', '参考基线'])
      expect(svg).toContain(label);
    expect(svg).toContain('<polyline');
  });

  it('rejects a process graph when a native radar chart was requested', async () => {
    const visual = {
      id: 'visual-2',
      kind: 'chart' as const,
      renderer: 'native' as const,
      brief: '四维算法性能雷达图',
      required: true,
      fidelity: 'conceptual' as const,
    };
    await expect(
      renderSemanticBlocks(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><g data-content-id="visual-2"/></svg>',
        [
          {
            id: 'visual-2',
            kind: 'scientific-diagram',
            title: '算法权衡',
            provenance: { kind: 'illustrative' },
            rect: { x: 450, y: 200, width: 440, height: 250 },
            spec: { type: 'graph', nodes: [{ id: 'a', label: 'A', x: 0.5, y: 0.5 }], edges: [] },
          },
        ],
        {
          slideId: 'slide-11',
          claim: '对比算法权衡',
          formulas: [],
          visualKind: 'chart',
          visualReason: '比较算法',
          visuals: [visual],
        },
      ),
    ).rejects.toThrow('requires a radar chart');
  });
  it('keeps a teaching cover typographic when the model asks for a decorative 3D background', async () => {
    const compiler = createPresentationContentCompiler(
      chat([
        {
          slides: [
            {
              slideId: 'slide-1',
              claim: '最优化理论和算法',
              formulas: [],
              visualKind: 'scientific-illustration',
              visualReason: '抽象科技背景',
              visuals: [
                {
                  id: 'visual-1',
                  kind: 'scientific-illustration',
                  renderer: 'image',
                  fidelity: 'conceptual',
                  required: true,
                  brief: '发光三维曲面与光轨',
                },
              ],
            },
          ],
        },
      ]),
    );
    const compiled = await compiler.compile(
      {
        notebookId: 'n',
        title: '最优化理论和算法',
        sourceVersionIds: [],
        slideCount: 1,
        options: { lessonStage: { kind: 'cover', boardSpace: 'none' } },
      },
      { scope },
    );
    expect(compiled.slides[0].visuals).toEqual([]);
    expect(compiled.slides[0].visualKind).toBe('none');
  });
  it('measures long formulas with the exact export engine before layout, including aligned line breaks', async () => {
    const latex = 'f(\\lambda x+(1-\\lambda)y)\\leq\\lambda f(x)+(1-\\lambda)f(y)';
    const measured = await measureFormula({ latex, fontSize: 28 });
    expect(measured.minRectWidth).toBeGreaterThan(400);
    await expect(
      renderFormula({
        ...formula,
        latex,
        rect: { x: 0, y: 0, width: measured.minRectWidth, height: measured.minRectHeight },
      }),
    ).resolves.toContain('<path');
    await expect(
      renderFormula({
        ...formula,
        latex,
        rect: { x: 0, y: 0, width: 400, height: measured.minRectHeight },
      }),
    ).rejects.toThrow('enlarge');
    const multiline = await measureFormula({
      latex:
        '\\begin{aligned}x_{k+1}&=x_k-\\alpha_k\\nabla f(x_k)\\\\d_k&=-\\nabla f(x_k)\\end{aligned}',
      fontSize: 28,
    });
    expect(multiline.height).toBeGreaterThan(measured.height);
  });

  it('demotes pages beyond the deck image budget to structured vectors instead of failing', async () => {
    const rasterPage = (page: number) => ({
      ...intent,
      slideId: `slide-${page}`,
      claim: `第 ${page} 页机制`,
      formulas: [],
      visualKind: 'scientific-diagram' as const,
      visualReason: '展示算法机制的框架图',
      visuals: [
        {
          brief: '二维算法机制框架图',
          fidelity: 'conceptual' as const,
          id: 'visual-1',
          kind: 'scientific-diagram' as const,
          renderer: 'image' as const,
          required: true,
        },
      ],
    });
    const provider = chat([{ slides: [rasterPage(1), rasterPage(2), rasterPage(3)] }]);
    const compiled = await createPresentationContentCompiler(provider, 3, {
      maxRasterVisuals: 1,
    }).compile(
      {
        notebookId: 'n',
        options: { outline: [1, 2, 3].map((page) => ({ title: `第 ${page} 页` })) },
        slideCount: 3,
        sourceVersionIds: [],
        title: '预算',
      },
      { scope },
    );
    expect(compiled.slides[0].visuals?.[0].renderer).toBe('image');
    expect(compiled.slides[1].visuals?.[0]).toMatchObject({ renderer: 'native' });
    expect(compiled.slides[2].visuals?.[0]).toMatchObject({ renderer: 'native' });
    const request = vi.mocked(provider.chat).mock.calls[0][0];
    expect(JSON.stringify(request.messages.at(-1))).toContain('最多 1 页使用 renderer:image');
  });

  it('persists server-measured bounds, ignores invented dimensions, and retains notes-only formulas without squeezing them on slide', async () => {
    const compiled = await createPresentationContentCompiler(
      chat([
        {
          slides: [
            {
              ...intent,
              formulas: [
                {
                  ...intent.formulas[0],
                  placement: 'notes',
                  measurement: {
                    fontSize: 24,
                    width: 1,
                    height: 1,
                    minRectWidth: 1,
                    minRectHeight: 1,
                  },
                },
              ],
            },
          ],
        },
      ]),
    ).compile({ notebookId: 'n', title: 'Notes', sourceVersionIds: [], slideCount: 1 }, { scope });
    expect(compiled.slides[0].formulas[0].measurement?.minRectWidth).toBeGreaterThan(100);
    const result = await createMultimodalPresentationPlanner({
      chatPort: chat([
        { slides: [{ svg: envelope.replace('<g data-content-id="update"/>', '') }] },
      ]),
    }).plan(
      {
        notebookId: 'n',
        title: 'Notes',
        sourceVersionIds: [],
        slideCount: 1,
        options: { contentIntents: compiled },
      },
      { scope },
    );
    expect(result.slides[0].notes).toContain(formula.latex);
    expect(result.slides[0].svg).not.toContain('data-formula-latex');
  });

  it('moves a formula MathJax cannot vectorize into the notes instead of failing the deck', async () => {
    const latex =
      'p^* = d^* \\quad \\Longleftarrow \\quad f, g_i \\text{ 为凸, } h_j \\text{ 为仿射, 且 } \\exists x \\in \\mathbf{relint}(\\mathcal{D}): g_i(x) \\lt 0';
    const compiled = await createPresentationContentCompiler(
      chat([
        {
          slides: [
            {
              ...intent,
              formulas: [
                {
                  explanation: '凸目标与仿射约束下的强对偶充分条件',
                  fontSize: 28,
                  id: 'dual',
                  latex,
                  placement: 'slide',
                },
              ],
            },
          ],
        },
      ]),
    ).compile(
      { notebookId: 'n', title: 'Duality', sourceVersionIds: [], slideCount: 1 },
      { scope },
    );
    const [demoted] = compiled.slides[0].formulas;
    expect(demoted.placement).toBe('notes');
    expect(demoted.latex).toBe(latex);
    expect(demoted.measurement).toBeUndefined();
    expect(demoted.explanation).toBe('凸目标与仿射约束下的强对偶充分条件');
  });

  it('keeps an unmeasurable notes formula as text instead of failing compilation', async () => {
    const latex = 'q(x) \\text{ 为凸 } \\Longrightarrow x < 0';
    const compiled = await createPresentationContentCompiler(
      chat([
        {
          slides: [
            {
              ...intent,
              formulas: [{ id: 'convex', latex, fontSize: 28, placement: 'notes' }],
            },
          ],
        },
      ]),
    ).compile({ notebookId: 'n', title: 'Notes', sourceVersionIds: [], slideCount: 1 }, { scope });
    const [notesFormula] = compiled.slides[0].formulas;
    expect(notesFormula.placement).toBe('notes');
    expect(notesFormula.latex).toBe(latex);
    expect(notesFormula.measurement).toBeUndefined();
  });

  it.each(['scientific-illustration', 'scientific-diagram'] as const)(
    'embeds an image-rendered %s and measured formula, and blocks missing assets',
    async (kind) => {
      const ref = '/api/runtime/presentation/artifacts/landscape';
      const mixed = {
        ...intent,
        visualKind: kind,
        visuals: [
          {
            id: 'landscape',
            kind,
            renderer: 'image',
            fidelity: 'conceptual',
            brief: 'A smooth terrain, not measured data',
            required: true,
          },
        ],
      };
      const slide = {
        svg: envelope,
        contentBlocks: [{ ...formula, rect: { x: 40, y: 120, width: 800, height: 60 } }],
      };
      const base = {
        notebookId: 'n',
        title: 'Mixed',
        sourceVersionIds: [],
        slideCount: 1,
        options: { contentIntents: { slides: [mixed] } },
      };
      expect(initialDesignPlan(base)?.slides[0]).toMatchObject({
        slideId: 'slide-1',
        metadata: { designOnly: true, title: intent.claim },
      });
      const result = await createMultimodalPresentationPlanner({
        chatPort: chat([{ slides: [slide] }]),
      }).plan(
        {
          ...base,
          options: {
            ...base.options,
            generatedImageSlots: [
              {
                slideId: 'slide-1',
                slotId: 'initial-assets:landscape',
                state: 'ready',
                assetRefs: [{ ref }],
                layout: { x: 0.3, y: 0.4, width: 0.4, height: 0.5, fit: 'contain' },
                visualBinding: {
                  visualId: 'landscape',
                  kind,
                  origin: 'generated',
                },
              },
            ],
          },
        },
        { scope },
      );
      expect(result.slides[0].svg).toContain('data-formula-latex');
      expect(result.slides[0].svg).toContain(ref);
      expect(result.slides[0].metadata?.visualAssets).toEqual([
        { visualId: 'landscape', kind, origin: 'generated', ref },
      ]);
      expect(result.slides[0].notes).toContain('非实验观测');
      await expect(
        createMultimodalPresentationPlanner({
          chatPort: chat([{ slides: [slide] }, { slides: [slide] }]),
        }).plan(base, { scope }),
      ).rejects.toThrow('no embedded');
    },
  );
  it('draws declared relations over the generated artwork and excludes them from blocking review', async () => {
    const ref = '/api/runtime/presentation/artifacts/landscape';
    const annotated = {
      ...intent,
      visualKind: 'scientific-diagram' as const,
      visuals: [
        {
          annotations: [
            {
              from: { x: 0.2, y: 0.8 },
              label: '−∇f(x*)',
              to: { x: 0.7, y: 0.3 },
              type: 'vector' as const,
            },
            { at: { x: 0.5, y: 0.12 }, text: '支撑超平面', type: 'label' as const },
          ],
          brief: 'Convex feasible set with a supporting hyperplane',
          fidelity: 'conceptual' as const,
          id: 'landscape',
          kind: 'scientific-diagram' as const,
          renderer: 'image' as const,
          required: true,
        },
      ],
    };
    const base = {
      notebookId: 'n',
      options: { contentIntents: { slides: [annotated] } },
      slideCount: 1,
      sourceVersionIds: [],
      title: 'Annotated',
    };
    const result = await createMultimodalPresentationPlanner({
      chatPort: chat([
        {
          slides: [
            {
              contentBlocks: [{ ...formula, rect: { x: 40, y: 120, width: 800, height: 60 } }],
              svg: envelope,
            },
          ],
        },
      ]),
    }).plan(
      {
        ...base,
        options: {
          ...base.options,
          generatedImageSlots: [
            {
              assetRefs: [{ ref }],
              layout: { fit: 'contain', height: 0.8, width: 0.45, x: 0.5, y: 0.1 },
              slideId: 'slide-1',
              slotId: 'initial-assets:landscape',
              state: 'ready',
              visualBinding: {
                kind: 'scientific-diagram',
                origin: 'generated',
                visualId: 'landscape',
              },
            },
          ],
        },
      },
      { scope },
    );
    const svg = result.slides[0].svg;
    expect(svg).toContain(ref);
    expect(svg).toContain('data-asset-annotations="landscape"');
    expect(svg).toContain('−∇f(x*)');
    expect(svg).toContain('支撑超平面');
    // Keep the authored caption and original square viewport; anchors follow the final box.
    expect(svg).toContain('梯度下降');
    const doc = parseString(svg);
    const image = doc.getElementsByTagName('image')[0];
    const x = Number(image.getAttribute('x')),
      y = Number(image.getAttribute('y'));
    const width = Number(image.getAttribute('width')),
      height = Number(image.getAttribute('height'));
    expect(width / height).toBeCloseTo(1);
    const annotation = Array.from(doc.getElementsByTagName('g')).find(
      (group) => group.getAttribute('data-asset-annotations') === 'landscape',
    )!;
    const vector = annotation
      .getElementsByTagName('path')[0]
      .getAttribute('d')!
      .match(/[-\d.]+/gu)!
      .map(Number);
    expect(vector[0]).toBeCloseTo(x + width * 0.2);
    expect(vector[1]).toBeCloseTo(y + height * 0.8);
    expect(inspectVisualOccupancy(result.slides[0])).toEqual([]);

    const reconciled = reconcileEvidenceBasedVisualReview(
      {
        issues: [
          {
            category: 'scientific-semantics' as const,
            evidence: '图中箭头方向与公式相反，指向可行域内部',
            instruction: '重绘箭头方向',
            severity: 'major' as const,
            slideId: 'slide-1',
            visualId: 'landscape',
          },
          {
            category: 'scientific-semantics' as const,
            evidence: '图中缺少可行域边界',
            instruction: '补充边界',
            severity: 'major' as const,
            slideId: 'slide-1',
            visualId: 'landscape',
          },
        ],
        passed: false,
        schemaVersion: 1 as const,
        summary: 'Check annotated artwork',
      },
      result,
    );
    // The relation is server-drawn now, so the direction claim cannot block the deck.
    expect(reconciled.review.issues.map((issue) => issue.evidence)).toEqual(['图中缺少可行域边界']);
    expect(reconciled.adjudications).toEqual([
      expect.objectContaining({
        reason: 'server-drawn-annotations',
        slideId: 'slide-1',
        visualId: 'landscape',
      }),
    ]);
  });

  it('renders actual math vectors with retained LaTeX and rasterizes without fonts or remote resources', async () => {
    const result = await renderSemanticBlocks(envelope, [formula], intent);
    expect(result.svg).toContain('<path');
    expect(result.svg).toContain('data-formula-latex');
    expect(result.svg).not.toMatch(/<use|<image|<style|foreignObject/);
    expect(result.svg).not.toContain('transform=');
    const png = await sharp(Buffer.from(result.svg)).png().toBuffer();
    expect((await sharp(png).metadata()).width).toBe(960);
    expect(inspectPresentationContent(plan(result.svg)).passed).toBe(true);
  });

  it('flattens nested fraction, radical and subscript geometry for native PPTX export', async () => {
    const svg = await renderFormula({
      ...formula,
      latex: '\\frac{1}{2}\\sum_{i=1}^{n}\\sqrt{x_i^2+1}',
      rect: { x: 80, y: 100, width: 760, height: 200 },
    });
    expect(svg).toContain('<path');
    expect(svg).not.toContain('transform=');
    expect(svg).not.toContain('<rect');
    await expect(
      sharp(
        Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">${svg}</svg>`),
      )
        .png()
        .toBuffer(),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it('rejects invalid math, unsafe commands, missing anchors and unreadable formula fitting', async () => {
    await expect(renderFormula({ ...formula, latex: '\\unknowncommand{x}' })).rejects.toThrow();
    await expect(
      renderFormula({ ...formula, latex: '\\href{https://example.com}{x}' }),
    ).rejects.toThrow('unsupported');
    await expect(
      renderFormula({ ...formula, rect: { ...formula.rect, width: 20 } }),
    ).rejects.toThrow('enlarge');
    await expect(renderSemanticBlocks(envelope, [], intent)).rejects.toThrow('required formula');
    await expect(
      renderSemanticBlocks(
        envelope.replace('<g data-content-id="update"/>', ''),
        [formula],
        intent,
      ),
    ).rejects.toThrow('exactly one');
  });

  it('routes declared numeric curves deterministically and labels illustrative rather than measured results', async () => {
    const block = {
      id: 'curve',
      kind: 'scientific-diagram',
      title: 'Convex quadratic',
      rect: { x: 40, y: 120, width: 800, height: 350 },
      provenance: { kind: 'illustrative' },
      spec: {
        type: 'plot',
        xRange: [-2, 2],
        yRange: [0, 4],
        xLabel: 'x',
        yLabel: 'f(x)',
        series: [{ label: 'quadratic', polynomial: [0, 0, 1] }],
      },
    };
    const svg = envelope.replace('update', 'curve');
    const invalid = semanticBlockSchema.safeParse({
      ...block,
      rect: { ...block.rect, height: 160 },
      unexpected: true,
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success)
      expect(invalid.error.issues.map((i) => i.code)).toEqual(
        expect.arrayContaining(['too_small', 'unrecognized_keys']),
      );
    const rendered = await renderSemanticBlocks(svg, [block]);
    expect(rendered.svg).not.toContain('非运行结果');
    expect(rendered.svg).toContain('<polyline');
    const editable = semanticAuthoringSvg(rendered.svg, rendered.blocks);
    expect(editable).not.toContain('<polyline');
    expect(editable).toContain('data-content-id="curve"');
    expect((await renderSemanticBlocks(editable, rendered.blocks)).svg).toContain('<polyline');
    expect(rendered.svg).toContain('410,282');
    const document = parseString(rendered.svg);
    const legend = Array.from(document.getElementsByTagName('text')).find(
      (node) => node.textContent === 'quadratic',
    )!;
    const points = document
      .getElementsByTagName('polyline')[0]
      .getAttribute('points')!
      .split(' ')
      .map((pair) => Number(pair.split(',')[1]));
    expect(Number(legend.getAttribute('y'))).toBeLessThan(Math.min(...points));
    const arrow = await renderSemanticBlocks(svg, [
      {
        ...block,
        spec: {
          ...block.spec,
          series: [
            {
              label: 'gradient',
              arrowEnd: true,
              points: [
                [0, 0],
                [1, 2],
              ],
            },
          ],
        },
      },
    ]);
    expect(parseString(arrow.svg).getElementsByTagName('path').length).toBe(3);
    await expect(
      renderSemanticBlocks(svg, [
        {
          ...block,
          spec: {
            ...block.spec,
            series: [
              {
                label: 'zero',
                arrowEnd: true,
                points: [
                  [0, 0],
                  [0, 0],
                ],
              },
            ],
          },
        },
      ]),
    ).rejects.toThrow('nonzero');
    await expect(
      renderSemanticBlocks(svg, [{ ...block, provenance: { kind: 'source' } }]),
    ).rejects.toThrow('source reference');
    await expect(
      renderSemanticBlocks(svg, [{ ...block, spec: { ...block.spec, yRange: [0, 1] } }]),
    ).rejects.toThrow('expand axes');
    expect(
      semanticBlockSchema.safeParse({
        ...block,
        spec: {
          type: 'graph',
          nodes: [{ id: 'a', label: 'A', x: 0, y: 0 }],
          edges: [{ from: 'a', to: 'missing' }],
        },
      }).success,
    ).toBe(false);
  });

  it('keeps the two labels entering a merge node on separate branches', async () => {
    const rendered = await renderSemanticBlocks(envelope.replace('update', 'flow'), [
      {
        id: 'flow',
        kind: 'scientific-diagram',
        title: 'Merge',
        provenance: { kind: 'illustrative' },
        rect: { x: 40, y: 110, width: 880, height: 190 },
        spec: {
          type: 'graph',
          nodes: [
            { id: 'a', label: 'SGD', x: 0, y: 0.5 },
            { id: 'b', label: 'Momentum', x: 0.5, y: 0.2 },
            { id: 'c', label: 'RMSprop', x: 0.5, y: 0.8 },
            { id: 'd', label: 'Adam', x: 1, y: 0.5 },
          ],
          edges: [
            { from: 'a', to: 'b' },
            { from: 'a', to: 'c' },
            { from: 'b', to: 'd', label: 'First moment' },
            { from: 'c', to: 'd', label: 'Second moment' },
          ],
        },
      },
    ]);
    const labels = Array.from(parseString(rendered.svg).getElementsByTagName('text')).filter(
      (node) => node.textContent?.includes('moment'),
    );
    expect(labels).toHaveLength(2);
    expect(
      Math.abs(Number(labels[0].getAttribute('y')) - Number(labels[1].getAttribute('y'))),
    ).toBeGreaterThan(40);
  });

  it('keeps vertical chain labels beside the arrows and outside node rectangles', async () => {
    const rendered = await renderSemanticBlocks(envelope.replace('update', 'chain'), [
      {
        id: 'chain',
        kind: 'scientific-diagram',
        title: 'Roadmap',
        provenance: { kind: 'illustrative' },
        rect: { x: 40, y: 100, width: 312, height: 345 },
        spec: {
          type: 'graph',
          nodes: Array.from({ length: 4 }, (_, i) => ({
            id: `n${i}`,
            label: '课程节点',
            x: 0.5,
            y: i / 3,
          })),
          edges: Array.from({ length: 3 }, (_, i) => ({
            from: `n${i}`,
            to: `n${i + 1}`,
            label: '一阶二阶基石',
          })),
        },
      },
    ]);
    const document = parseString(rendered.svg);
    const nodes = Array.from(document.getElementsByTagName('rect'));
    const labels = Array.from(document.getElementsByTagName('text')).filter(
      (node) => node.textContent === '一阶二阶基石',
    );
    expect(labels).toHaveLength(3);
    labels.forEach((label, i) => {
      const baseline = Number(label.getAttribute('y'));
      expect(baseline - 16).toBeGreaterThan(
        Number(nodes[i].getAttribute('y')) + Number(nodes[i].getAttribute('height')),
      );
      expect(baseline).toBeLessThan(Number(nodes[i + 1].getAttribute('y')));
      expect(Number(label.getAttribute('x'))).toBeGreaterThan(312 / 2);
    });
  });

  it('blocks the observed dense pseudo-formula output and inherited transform-based font shrinking', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><g font-size="24" transform="scale(0.5)"><text x="20" y="40">${'过密内容'.repeat(150)} θ_(t+1)</text></g></svg>`;
    const report = inspectPresentationContent(plan(svg));
    expect(report.issues.map((issue) => issue.category)).toEqual(
      expect.arrayContaining(['density', 'formula', 'legibility']),
    );
    expect(() => assertPresentationPublishable(plan(svg))).toThrow('内容质量');
    expect(() =>
      assertPresentationPublishable({
        ...plan(envelope),
        designSpec: {
          templateVisualReview: { final: { passed: true, issues: [{ severity: 'major' }] } },
        },
      }),
    ).toThrow('视觉复核');
  });

  it('rejects a full-size CJK sentence clipped beyond the page instead of accepting readable font size alone', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="506" y="367" font-size="24"><tspan font-weight="bold">病态瓶颈：</tspan>大条件数峡谷导致正交往复震荡</text></svg>';
    expect(inspectPresentationContent(plan(svg)).issues).toEqual([
      expect.objectContaining({ category: 'geometry', severity: 'major' }),
    ]);
    const multiline =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="506" y="300" font-size="24"><tspan x="506" y="300">病态瓶颈：大条件数峡谷</tspan><tspan x="506" y="332">导致正交往复震荡</tspan></text></svg>';
    expect(inspectPresentationContent(plan(multiline)).passed).toBe(true);
  });

  it('compiles content and repairs a planner omission before returning a rendered formula', async () => {
    const provider = chat([
      { slides: [intent] },
      {
        slides: [
          {
            svg: envelope.replace(
              '<g data-content-id="update"/>',
              '<text x="80" y="150" font-size="10">θ_(t+1)</text>',
            ),
          },
        ],
      },
      { slides: [{ svg: envelope, contentBlocks: [formula], notes: '解释学习率与梯度' }] },
    ]);
    const input = {
      title: '最优化',
      notebookId: 'course',
      sourceVersionIds: [],
      slideCount: 1,
      options: { outline: [{ title: '梯度下降', keyPoints: ['沿负梯度更新参数'] }] },
    };
    const compiled = await createPresentationContentCompiler(provider).compile(input, { scope });
    const result = await createMultimodalPresentationPlanner({ chatPort: provider }).plan(
      { ...input, options: { ...input.options, contentIntents: compiled } },
      { scope },
    );
    expect(provider.chat).toHaveBeenCalledTimes(3);
    const requests = vi.mocked(provider.chat).mock.calls.map(([request]) => request);
    expect(requests[1].messages[0].content).toContain('MANDATORY CONTENT CONTRACT');
    expect(JSON.stringify(requests[2].messages.at(-1))).toContain('required formula');
    expect(JSON.stringify(requests[2].messages.at(-1))).toContain('legibility');
    expect(result.slides[0].svg).toContain('data-formula-latex');
    expect(result.slides[0].metadata?.contentBlocks).toHaveLength(1);
    expect(result.designSpec?.contentPolicyVersion).toBe(1);
  });
});
