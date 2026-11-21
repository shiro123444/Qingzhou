import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { CapabilityCapsule } from './capability-memory';
import { applyChartDataPatch } from './chart-data-edit';
import { inspectPresentationContent } from './content-quality';
import { createDeckVisualSystem } from './deck-visual-system';
import { compileLearnedPageLayout } from './learned-page-layout';
import { createGLMPresentationPlanner } from './multimodal-planner-glm';
import { renderSemanticBlocks, type SemanticBlock } from './semantic-blocks';
import { inspectVisualOccupancy } from './visual-ownership';
import { stabilizePresentationVisuals } from './visual-stabilizer';

const system = createDeckVisualSystem({
  title: '光学模拟',
  notebookId: 'test',
  sourceVersionIds: [],
  options: { style: '简洁网格' },
})!;
const style = {
  id: `capsule-${'a'.repeat(40)}`,
  kind: 'style',
  source: { workspaceKind: 'style', sourceDigest: 'a'.repeat(64) },
  designReference: {
    style: { id: 'swiss-minimal', grid: true, flat: true, sparseDecoration: true },
  },
} as CapabilityCapsule;
const layout = (
  kind: 'picture' | 'object',
  count: number,
  left = 0.05,
  captions = false,
): CapabilityCapsule =>
  ({
    id: `capsule-${kind[0].repeat(39)}${count}`,
    kind: 'layout',
    source: {
      sourceDigest: 'b'.repeat(64),
      aspectRatio: '16:9',
      evidencePages: [12],
      templateId: 'owned',
      versionId: 'observed',
    },
    layout: { roles: ['content'] },
    designReference: {
      slots: [
        {
          id: 'title',
          kind: 'title',
          box: { x: left, y: 0.06, width: 0.9, height: 0.14 },
          fontSize: 32,
        },
        ...Array.from({ length: count }, (_, i) => ({
          id: `lane-${i}`,
          kind,
          box: {
            x: left + (i * 0.9) / count,
            y: 0.25,
            width: 0.9 / count - 0.025,
            height: captions ? 0.42 : 0.64,
          },
        })),
        ...(captions
          ? Array.from({ length: count }, (_, i) => ({
              id: `caption-${i}`,
              kind: 'body' as const,
              box: {
                x: left + (i * 0.9) / count,
                y: 0.72,
                width: 0.9 / count - 0.025,
                height: 0.17,
              },
            }))
          : []),
      ],
    },
  }) as CapabilityCapsule;
const formula = (
  id: string,
  latex = String.raw`C=\frac{I_{\max}-I_{\min}}{I_{\max}+I_{\min}}`,
): SemanticBlock => ({
  id,
  kind: 'formula',
  latex,
  display: true,
  fontSize: 28,
  color: '#ff0000',
  rect: { x: 40, y: 150, width: 500, height: 100 },
});
const table: SemanticBlock = {
  id: 'table',
  kind: 'scientific-diagram',
  title: '模拟数据',
  provenance: { kind: 'illustrative' },
  rect: { x: 40, y: 150, width: 500, height: 180 },
  spec: {
    type: 'table',
    fontSize: 20,
    columns: ['条件', '比值'],
    rows: [
      ['宽光斑', '8'],
      ['窄光斑', '12'],
    ],
    headerFill: '#ff0000',
  },
};
const image = (href: string) => `<image x="10" y="10" width="800" height="30" href="${href}"/>`;
const svg = (content: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">${content}</svg>`;
const base = {
  title: '归一化与对比度',
  system,
  capsules: [
    style,
    layout('object', 2),
    layout('object', 3),
    layout('picture', 1),
    layout('picture', 2, 0.05, true),
  ],
  pageNumber: 4,
  totalPages: 6,
};

describe('learned heterogeneous layouts', () => {
  it('places one chart in a measured source slot, carries prose into its peer and keeps editable samples in sync', async () => {
    const evidence = {
      ...table,
      id: 'load',
      spec: {
        type: 'plot' as const,
        xRange: [0, 5] as [number, number],
        yRange: [0, 20] as [number, number],
        xLabel: '载荷',
        yLabel: '信号',
        series: [
          {
            label: '传感器',
            points: [
              [1, 8],
              [2, 12],
              [3, 16],
            ] as [number, number][],
          },
        ],
      },
    };
    const title = '采样响应';
    const pairs = '传感器模拟数据：在载荷1、2、3下，对应响应8、12、16';
    const run = {
      ...base,
      title,
      rawBlocks: [evidence],
      capsules: [style, layout('object', 2)],
      approvedContent: [pairs],
      svg: svg(
        '<text x="60" y="70" font-size="32">采样响应</text><g data-content-id="load"/><text x="60" y="450" font-size="24">保留原始结论。</text>',
      ),
    };
    const compiled = await compileLearnedPageLayout(run);
    expect(compiled?.receipt).toMatchObject({
      layoutCapsuleId: run.capsules[1].id,
      slotIds: expect.arrayContaining(['title', 'lane-0', 'lane-1']),
      assignments: [{ id: 'load', kind: 'chart' }],
    });
    expect(compiled!.blocks[0].rect.height).toBeGreaterThan(260);
    const page = {
      order: 1,
      slideId: 'slide-1',
      svg: (await renderSemanticBlocks(compiled!.svg, compiled!.blocks)).svg,
      metadata: { contentBlocks: compiled!.blocks },
    };
    expect(page.svg).toContain('保留原始结论。');
    const { plan } = applyChartDataPatch(
      { title, planId: 'test', aspectRatio: '16:9', sourceVersionIds: [], slides: [page] },
      { notebookId: 'studio', title, sourceVersionIds: [] },
      {
        target: { type: 'slide', slideNumber: 1 },
        chartDataPatch: {
          blockId: 'load',
          expectedVersionId: 'v1',
          series: [
            [
              [1, 8],
              [2, 12],
              [3, 17],
            ],
          ],
        },
      },
    );
    const next = plan.slides[0].svg;
    expect(next).toContain('对应响应8、12、17');
    expect(next).not.toContain('对应响应8、12、16');
    expect(next).toContain('保留原始结论。');
    const skip = vi.fn();
    expect(
      await compileLearnedPageLayout({
        ...run,
        approvedContent: [pairs.replace('16', '18')],
        onSkip: skip,
      }),
    ).toBeUndefined();
    expect(skip).toHaveBeenCalledWith('approved-point-series-mismatch');
  });
  it('uses a source object placeholder for a standalone table if no table layout matches', async () => {
    const source = layout('object', 2);
    const result = await compileLearnedPageLayout({
      ...base,
      capsules: [style, source],
      title: '对照表',
      rawBlocks: [table],
      approvedContent: ['条件对照'],
      svg: svg(
        '<text x="48" y="48" font-size="32">对照表</text><g data-content-id="table"/><text x="50" y="410">记录单位与日期</text>',
      ),
    });
    expect(result?.receipt).toMatchObject({
      layoutCapsuleId: source.id,
      assignments: [{ id: 'table', kind: 'table', slotId: 'lane-0' }],
    });
    const page = (await renderSemanticBlocks(result!.svg, result!.blocks)).svg;
    expect(page).toContain('记录单位与日期');
    expect(page).toContain('窄光斑');
  });

  it('can borrow an observed picture slot without claiming an unsupported decorative style', async () => {
    const decorative = {
      ...style,
      designReference: { style: { id: 'paper-cut' } },
    } as CapabilityCapsule;
    const source = layout('picture', 1);
    const input = {
      ...base,
      approvedContent: ['模拟图像，保留完整边界'],
      rawBlocks: [],
      svg: svg(image('owned-image')),
      imageSizes: new Map([['owned-image', { width: 300, height: 900 }]]),
    };
    const result = await compileLearnedPageLayout({ ...input, capsules: [decorative, source] });
    expect(result?.receipt).toMatchObject({
      layoutOnly: true,
      layoutCapsuleId: source.id,
      slotIds: expect.arrayContaining(['lane-0']),
    });
    expect(result?.receipt).not.toHaveProperty('styleCapsuleId');
    expect(result?.uses.map(({ capsuleId }) => capsuleId)).toEqual([source.id]);
    await expect(
      compileLearnedPageLayout({ ...input, capsules: [decorative, layout('object', 1)] }),
    ).resolves.toBeUndefined();
  });

  it.each([
    { width: 1200, height: 300 },
    { width: 300, height: 900 },
  ])(
    'uses real image dimensions %o and source geometry, never the author viewport',
    async (size) => {
      const input = {
        ...base,
        svg: svg(image('owned-image')),
        rawBlocks: [],
        approvedContent: ['模拟图像，保留完整边界'],
        imageSizes: new Map([['owned-image', size]]),
        capsules: [style, layout('picture', 1)],
      };
      const result = (await compileLearnedPageLayout(input))!;
      expect(result).toBeDefined();
      const node = parseString(result.svg).getElementsByTagName('image')[0];
      expect(Number(node.getAttribute('width')) / Number(node.getAttribute('height'))).toBeCloseTo(
        size.width / size.height,
        6,
      );
      expect(node.getAttribute('href')).toBe('owned-image');
      expect(node.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
      expect(result.svg).toContain('>4 / 6</text>');
      const again = (await compileLearnedPageLayout({ ...input, svg: result.svg }))!;
      expect(again.svg).toBe(result.svg);
      const moved = (await compileLearnedPageLayout({
        ...input,
        capsules: [style, layout('picture', 1, 0.08)],
      }))!;
      expect(moved.svg).not.toBe(result.svg);
    },
  );
  it('centers each actual image and paired caption as one group, without transparent viewport gaps', async () => {
    const result = (await compileLearnedPageLayout({
      ...base,
      svg: svg(image('a') + image('b')),
      rawBlocks: [],
      approvedContent: ['第一张：模拟宽光斑', '第二张：模拟窄光斑'],
      imageSizes: new Map(
        ['a', 'b'].map((ref) => [
          ref,
          ref === 'a' ? { width: 1200, height: 400 } : { width: 480, height: 720 },
        ]),
      ),
      capsules: [style, layout('picture', 2, 0.05, true)],
    }))!;
    const doc = parseString(result.svg),
      pictures = Array.from(doc.getElementsByTagName('image'));
    expect(pictures).toHaveLength(2);
    const starts: number[] = [];
    for (const [i, pic] of pictures.entries()) {
      const bottom = Number(pic.getAttribute('y')) + Number(pic.getAttribute('height'));
      const caption = Array.from(doc.getElementsByTagName('text')).find(
        (t) =>
          (t.textContent ?? '').startsWith(i ? '第二张' : '第一张') &&
          Number(t.getAttribute('font-size')) === 24,
      )!;
      expect(Number(caption.getAttribute('y')) - 24 - bottom).toBeCloseTo(18, 3);
      starts.push(Number(caption.getAttribute('y')));
    }
    expect(starts[0]).toBeCloseTo(starts[1], 6);
  });
  it('measures multiple formulae, preserves exact algebra and font sizes through rendering and repair', async () => {
    const blocks = [
      formula('contrast'),
      formula('normalization', String.raw`I_n=\frac{I-I_{\min}}{I_{\max}-I_{\min}}`),
    ];
    const result = (await compileLearnedPageLayout({
      ...base,
      svg: svg(''),
      rawBlocks: blocks,
      approvedContent: ['对比度：衡量强度差异', '归一化：映射到单位区间，并保留原始边界条件'],
    }))!;
    expect(result.blocks.map((b) => b.kind === 'formula' && b.latex)).toEqual(
      blocks.map((b) => b.kind === 'formula' && b.latex),
    );
    expect(result.blocks[0].rect.y + result.blocks[0].rect.height / 2).toBeCloseTo(
      result.blocks[1].rect.y + result.blocks[1].rect.height / 2,
      6,
    );
    expect(
      result.blocks.every(
        (b) => b.kind === 'formula' && b.fontSize === 28 && b.color === system.colors.text,
      ),
    ).toBe(true);
    const rendered = await renderSemanticBlocks(result.svg, result.blocks);
    const formulaNodes = Array.from(parseString(rendered.svg).getElementsByTagName('g')).filter(
      (g) => g.getAttribute('data-pptx-replace-with') === 'formula',
    );
    expect(formulaNodes).toHaveLength(2);
    for (const [i, node] of formulaNodes.entries()) {
      const meta = JSON.parse(node.getElementsByTagName('metadata')[0].textContent!);
      expect(meta).toMatchObject({
        latex: (blocks[i] as { latex: string }).latex,
        display: 'block',
        font_size: 28,
        color: system.colors.text,
      });
      expect(Number(node.getAttribute('data-pptx-height'))).toBe(result.blocks[i].rect.height);
    }
    expect(
      inspectVisualOccupancy({
        slideId: 'formula',
        order: 4,
        svg: rendered.svg,
        metadata: { contentBlocks: result.blocks },
      }),
    ).toEqual([]);
    const restored = await stabilizePresentationVisuals(
      {
        planId: 'repair',
        title: '模拟试验',
        aspectRatio: '16:9',
        sourceVersionIds: [],
        designSpec: { deckVisualSystem: system },
        slides: [
          {
            slideId: 'formula',
            order: 4,
            svg: rendered.svg.replaceAll(system.colors.text, '#ff0000'),
            metadata: {
              title: base.title,
              outline: ['对比度：衡量强度差异', '归一化：映射到单位区间，并保留原始边界条件'],
              deckVisualSystemId: system.id,
              contentBlocks: result.blocks,
            },
          },
        ],
      },
      undefined,
      base.capsules,
      'post-repair',
    );
    expect(restored.slides[0].metadata?.contentBlocks).toEqual(result.blocks);
    expect(restored.slides[0].svg).not.toContain('#ff0000');
    expect(restored.slides[0].metadata?.designCompilation).toMatchObject([
      { compilerVersion: 15, status: 'applied', stage: 'post-repair' },
    ]);
  });
  it('packs an image, formula and native table without dropping facts, assets or table rows', async () => {
    const bytes = await sharp({
      create: { width: 480, height: 240, channels: 3, background: '#338877' },
    })
      .png()
      .toBuffer();
    const href = 'data:image/png;base64,' + bytes.toString('base64');
    const input = {
      ...base,
      svg: svg(image(href)),
      rawBlocks: [formula('contrast'), table],
      approvedContent: ['图像：全部为模拟数据', '公式：保持原始表达', '清单：宽光斑与窄光斑'],
    };
    const result = (await compileLearnedPageLayout(input))!;
    expect(result).toBeDefined();
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.find((b) => b.id === 'table')).toMatchObject({
      spec: {
        rows: [
          ['宽光斑', '8'],
          ['窄光斑', '12'],
        ],
        headerFill: system.colors.background,
      },
    });
    const rendered = await renderSemanticBlocks(result.svg, result.blocks);
    expect(
      inspectVisualOccupancy({
        slideId: 'mixed',
        order: 4,
        svg: rendered.svg,
        metadata: { contentBlocks: result.blocks },
      }),
    ).toEqual([]);
    expect(parseString(result.svg).getElementsByTagName('image')[0].getAttribute('href')).toBe(
      href,
    );
    for (const phrase of ['全部为模拟数据', '保持原始表达', '宽光斑与窄光斑'])
      expect(rendered.svg.replaceAll(/<[^>]+>/gu, '')).toContain(phrase);
    const again = (await compileLearnedPageLayout({
      ...input,
      svg: rendered.svg,
      rawBlocks: result.blocks,
    }))!;
    expect(again.blocks).toEqual(result.blocks);
    expect(again.svg).toBe(result.svg);
  });
  it('rejects unverified image dimensions and over-capacity content explicitly', async () => {
    const reasons: string[] = [];
    expect(
      await compileLearnedPageLayout({
        ...base,
        svg: svg(image('unknown')),
        rawBlocks: [],
        onSkip: (r) => reasons.push(r),
      }),
    ).toBeUndefined();
    expect(reasons).toEqual(['image-intrinsics-unavailable']);
    expect(
      await compileLearnedPageLayout({
        ...base,
        svg: svg(''),
        rawBlocks: [formula('too-wide', 'W=' + 'abcdefghijk'.repeat(30))],
        onSkip: (r) => reasons.push(r),
      }),
    ).toBeUndefined();
    expect(reasons.at(-1)).toBe('media-content-exceeds-source-capacity');
  });
  it('reserves the full table and formula height before fitting a tall image in their shared lane', async () => {
    const result = await compileLearnedPageLayout({
      ...base,
      svg: svg(image('owned-portrait')),
      imageSizes: new Map([['owned-portrait', { width: 420, height: 680 }]]),
      rawBlocks: [formula('calculation'), table],
      capsules: [style, layout('object', 1)],
    });
    expect(result?.receipt.slotIds).toEqual(['title', 'lane-0']);
    expect(result?.blocks).toHaveLength(2);
    const compiled = await renderSemanticBlocks(result!.svg, result!.blocks);
    const portrait = parseString(compiled.svg).getElementsByTagName('image')[0];
    const width = Number(portrait.getAttribute('width'));
    const height = Number(portrait.getAttribute('height'));
    expect(height).toBeGreaterThanOrEqual(48);
    expect(width / height).toBeCloseTo(420 / 680);
    expect(
      inspectVisualOccupancy({
        slideId: 'slide-4',
        order: 4,
        svg: compiled.svg,
        metadata: { contentBlocks: compiled.blocks },
      }),
    ).toEqual([]);
  });
  it('keeps learned image and caption positions through the real author composition layer', async () => {
    const bytes = await sharp({
      create: { width: 600, height: 300, channels: 3, background: '#338877' },
    })
      .png()
      .toBuffer();
    const title = '先观察主体再解释分布',
      ref = 'owned-original';
    const source = layout('picture', 1);
    const planner = createGLMPresentationPlanner({
      chatPort: {
        providerId: 'test',
        manifest: {
          providerId: 'test',
          model: 'test',
          displayName: 'test',
          supportsIdempotency: true,
          supportsVision: true,
        },
        chat: async () => ({
          id: 'test',
          created: 0,
          model: 'test',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  slides: [
                    {
                      slideId: 'slide-2',
                      svg: svg(`<text x="48" y="70" font-size="32">${title}</text>`),
                      notes: '观察完整原图。',
                    },
                  ],
                }),
              },
            },
          ],
        }),
      },
    });
    const input = {
      title: '模拟观察',
      notebookId: 'n',
      sourceVersionIds: [],
      slideCount: 1,
      options: {
        deckVisualSystem: system,
        learnedCapabilities: { capsules: [style, source] },
        outline: [
          { title: '封面', keyPoints: [] },
          { title, keyPoints: ['完整图像边界保留', '主体强度逐渐降低'] },
        ],
        contentIntents: {
          slides: [
            {
              slideId: 'slide-2',
              claim: title,
              formulas: [],
              visualKind: 'source-figure',
              visualReason: '观察真实原图',
              visuals: [{ id: ref, kind: 'source-figure', brief: '复用原图', required: true }],
            },
          ],
        },
        generatedImageSlots: [
          {
            slideId: 'slide-2',
            slotId: ref,
            state: 'ready',
            assetRefs: [{ ref }],
            visualBinding: { visualId: ref, kind: 'source-figure', origin: 'provided' },
            layout: {
              x: 0.05,
              y: 0.1,
              width: 0.9,
              height: 0.8,
              fit: 'contain',
              layer: 'content',
            },
          },
        ],
      },
    };
    const context = {
      scope: { userId: 'owner', sessionId: 's' },
      pagePass: true,
      pageIndex: 1,
      pageSlideId: 'slide-2',
      trustedImages: [{ ref, mimeType: 'image/png', base64: bytes.toString('base64') }],
    };
    const plan = await planner.plan(input, context);
    const page = plan.slides[0];
    expect(page.metadata?.designCompilation).toMatchObject([
      { stage: 'author', status: 'applied' },
    ]);
    expect(page.metadata?.compiledDesign).toMatchObject({ layoutCapsuleId: source.id });
    expect(page.svg.replaceAll(/<[^>]+>/gu, '')).toContain('完整图像边界保留');
    expect(inspectVisualOccupancy(page)).toEqual([]);
    const picture = parseString(page.svg).getElementsByTagName('image')[0];
    expect(Number(picture.getAttribute('y'))).toBeGreaterThan(54);
    expect(
      Number(picture.getAttribute('width')) / Number(picture.getAttribute('height')),
    ).toBeCloseTo(2, 6);
    const starts: number[] = [];
    const resumedPlan = await planner.plan(
      { ...input, slideCount: 2 },
      {
        ...context,
        pagePass: false,
        onSlideStart: (n: number) => {
          starts.push(n);
        },
        resumeSlides: [
          {
            slideId: 'slide-1',
            order: 1,
            svg: svg('<text x="48" y="70" font-size="32">封面</text>'),
            metadata: { designCompilation: [{ status: 'applied' }] },
          },
          {
            ...page,
            slideId: 'slide-2',
            order: 2,
            metadata: {
              ...page.metadata,
              compiledDesign: undefined,
              designCompilation: [
                { stage: 'author', status: 'skipped', reason: 'semantic-layout-recovery' },
              ],
            },
          },
        ],
      },
    );
    expect(starts).toEqual([2]);
    expect(resumedPlan.slides[1].metadata?.designCompilation).toMatchObject([
      { stage: 'author', status: 'applied' },
    ]);
  });
  it('requires explicit approved sample pairs rather than a fitted replacement, including the repair instruction', async () => {
    const plot: Extract<SemanticBlock, { kind: 'scientific-diagram' }> = {
      id: 'samples',
      kind: 'scientific-diagram',
      title: '给定采样',
      provenance: { kind: 'source', reference: '批准内容' },
      rect: { x: 50, y: 150, width: 500, height: 240 },
      spec: {
        type: 'plot',
        xRange: [-4, 4],
        yRange: [0, 12],
        xLabel: '位置',
        yLabel: '幅值',
        series: [{ label: '采样', polynomial: [99] }],
      },
    };
    const points: [number, number][] = [
      [-3, 10],
      [-1, 6],
      [2, 4],
    ];
    const approvedContent = ['定义：保留原始表达', '采样数据：位置 -3、-1、2，对应幅值 10、6、4'];
    const reasons: string[] = [];
    const input = {
      ...base,
      svg: svg(''),
      rawBlocks: [formula('definition'), plot],
      approvedContent,
      onSkip: (r: string) => reasons.push(r),
    };
    expect(await compileLearnedPageLayout(input)).toBeUndefined();
    expect(reasons).toEqual(['approved-point-series-mismatch']);
    const report = inspectPresentationContent({
      planId: 'data',
      title: '采样',
      aspectRatio: '16:9',
      sourceVersionIds: [],
      slides: [
        {
          slideId: 'data',
          order: 5,
          svg: svg(''),
          metadata: {
            outline: approvedContent,
            designCompilation: [{ status: 'skipped', reason: reasons[0] }],
          },
        },
      ],
    });
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        category: 'scientific-semantics',
        instruction: expect.stringContaining(JSON.stringify(points)),
      }),
    );
    if (plot.spec.type !== 'plot') throw new Error('fixture');
    const fixed = { ...plot, spec: { ...plot.spec, series: [{ label: '采样', points }] } };
    const result = (await compileLearnedPageLayout({
      ...input,
      rawBlocks: [formula('definition'), fixed],
    }))!;
    expect(result.blocks.find((b) => b.id === 'samples')).toMatchObject({
      spec: { series: [{ points }] },
    });
    expect(result.receipt.layoutCapsuleId).toBeDefined();
  });
  it('deduplicates numeric facts beneath adorned headers without masking a wrong value association', async () => {
    if (table.kind !== 'scientific-diagram' || table.spec.type !== 'table')
      throw new Error('fixture');
    const adorned = { ...table, spec: { ...table.spec, columns: ['条件', '比值 R（倍）'] } };
    const input = {
      ...base,
      svg: svg(''),
      rawBlocks: [formula('definition'), adorned],
      approvedContent: ['定义：保持原样', '宽光斑：比值8', '窄光斑：比值12'],
    };
    const result = (await compileLearnedPageLayout(input))!;
    expect(result).toBeDefined();
    expect(result.svg).not.toContain('宽光斑：');
    expect(result.svg).not.toContain('窄光斑：');
    expect(result.blocks.find((b) => b.id === 'table')).toMatchObject({
      spec: {
        columns: ['条件', '比值 R（倍）'],
        rows: [
          ['宽光斑', '8'],
          ['窄光斑', '12'],
        ],
      },
    });
    const mismatch = (await compileLearnedPageLayout({
      ...input,
      approvedContent: [...input.approvedContent, '宽光斑：比值12'],
    }))!;
    expect(mismatch.svg.replaceAll(/<[^>]+>/gu, '')).toContain('宽光斑：比值12');
  });
  it('uses free footer clearance for a measured compound group while preserving type sizes', async () => {
    const compact = layout('object', 2);
    for (const slot of compact.designReference!.slots!)
      if (slot.kind === 'object') slot.box.height = 0.42;
    const equation = formula('definition');
    if (equation.kind !== 'formula') throw new Error('fixture');
    const result = (await compileLearnedPageLayout({
      ...base,
      capsules: [style, compact],
      svg: svg(image('owned-image')),
      rawBlocks: [equation, table],
      imageSizes: new Map([['owned-image', { width: 600, height: 300 }]]),
      approvedContent: ['图片：保留全部信息', `定义：$${equation.latex}$；保持分母为正`],
    }))!;
    expect(result).toBeDefined();
    expect(result.receipt.adaptations).toContain(
      'source lane extended into measured footer clearance',
    );
    expect(result.receipt.metrics.contentBottom).toBeLessThanOrEqual(system.height - 48);
    expect(result.blocks).toMatchObject([
      { kind: 'formula', fontSize: 28 },
      { kind: 'scientific-diagram', spec: { fontSize: 20 } },
    ]);
    expect(result.svg.replaceAll(/<[^>]+>/gu, '')).toContain('保持分母为正');
  });
});
