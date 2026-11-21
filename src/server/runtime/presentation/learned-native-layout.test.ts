import { describe, expect, it } from 'vitest';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { CapabilityCapsule } from './capability-memory';
import { inspectPresentationContent } from './content-quality';
import { createDeckVisualSystem } from './deck-visual-system';
import { compileLearnedNativeLayout } from './learned-native-layout';
import { createGLMPresentationPlanner } from './multimodal-planner-glm';
import { renderSemanticBlocks, type SemanticBlock } from './semantic-blocks';
import { inspectVisualOccupancy } from './visual-ownership';
import { stabilizePresentationVisuals } from './visual-stabilizer';

const capsule = (role: 'data' | 'process', x = 0.05): CapabilityCapsule => ({
  id: `capsule-${'1'.repeat(39)}${role === 'data' ? '1' : '2'}`,
  schemaVersion: 1,
  kind: 'layout',
  name: 'Source geometry',
  triggers: [],
  rules: [],
  palette: [],
  createdAt: '2026-11-17',
  source: {
    workspaceKind: 'layout',
    workspaceId: role,
    sourceDigest: 'a'.repeat(64),
    evidencePages: [1],
    aspectRatio: '16:9',
  },
  layout: {
    id: role,
    familyId: 'source',
    name: role,
    roles: [role],
    regions: [],
    readingFlow: 'Top to bottom',
    whitespace: 'Adapt to content',
    compositionRules: ['Measured evidence'],
    assetPolicy: [],
    evidencePages: [1],
  },
  designReference: {
    slots: [
      {
        id: 'source-title',
        kind: 'title',
        box: { x, y: 0.06, width: 0.9 - x, height: 0.12 },
        fontSize: 32,
      },
      {
        id: 'source-evidence',
        kind: role === 'data' ? 'table' : 'object',
        box: { x, y: 0.3, width: 0.9 - x, height: 0.5 },
      },
    ],
  },
});
const system = createDeckVisualSystem({
  title: '演示',
  notebookId: 'test',
  sourceVersionIds: [],
  options: { style: '简洁排版' },
})!;
const svg = (title: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="70" y="60" font-size="32">${title}</text><text x="70" y="100" font-size="24">所有资料保留</text><g data-content-id="evidence"/><text x="70" y="450" font-size="24">逐项复核</text><text x="896" y="522" font-size="16">02</text></svg>`;
const table: SemanticBlock = {
  id: 'evidence',
  kind: 'scientific-diagram',
  title: '证据',
  provenance: { kind: 'illustrative' },
  rect: { x: 70, y: 150, width: 600, height: 280 },
  spec: {
    type: 'table',
    columns: ['事项', '标准'],
    rows: [['任意主题', '保留全部源资料']],
    fontSize: 20,
    headerFill: '#1D3E6B',
  },
};

describe('learned native layout compilation', () => {
  it('fits complete approved responsibilities beneath a relationship graph at the publication body size', async () => {
    const graph: SemanticBlock = {
      ...table,
      spec: {
        type: 'graph',
        nodes: [
          { id: 'dispatch', label: '调度员·现场', x: 0.2, y: 0.2 },
          { id: 'field', label: '工程师·现场', x: 0.8, y: 0.2 },
          { id: 'records', label: '质量负责人·翌日汇总', x: 0.5, y: 0.8 },
        ],
        edges: [
          { from: 'dispatch', to: 'field', label: '共同验收', bidirectional: true },
          { from: 'dispatch', to: 'records', label: '归档记录' },
          { from: 'field', to: 'records', label: '归档记录' },
        ],
      },
    };
    const source = capsule('process');
    const style = {
      ...source,
      id: 'sparse',
      kind: 'style',
      designReference: {
        style: {
          id: 'sparse',
          grid: true,
          flat: true,
          squareCorners: true,
          sparseDecoration: true,
        },
      },
    } as CapabilityCapsule;
    const points = [
      '调度员：登记到达情况并记录处理进展',
      '工程师：复核现场资料并确认准备情况',
      '质量负责人：次日汇总记录与反馈并形成备忘',
      '交接顺序：现场完成验收，次日交由质量部门汇总',
    ];
    const compiled = compileLearnedNativeLayout({
      svg: svg('现场交接'),
      title: '现场交接',
      rawBlocks: [graph],
      system,
      capsules: [style, source],
      approvedContent: points,
      pageNumber: 4,
      totalPages: 7,
    })!;
    expect(compiled).toBeDefined();
    const rendered = await renderSemanticBlocks(compiled.svg, compiled.blocks);
    const slide = {
      slideId: 'rel',
      order: 4,
      svg: rendered.svg,
      notes: '交接',
      metadata: { contentBlocks: compiled.blocks, outline: points, title: '现场交接' },
    };
    expect(
      inspectPresentationContent({
        planId: 'deck',
        title: '现场交接',
        sourceVersionIds: [],
        aspectRatio: '16:9',
        slides: [slide],
      }).issues.filter((i) => i.category === 'legibility'),
    ).toEqual([]);
    for (const text of ['调度员：', '工程师：', '质量负责人：', '交接顺序：'])
      expect(compiled.svg).toMatch(new RegExp('font-size="24"[^>]*>' + text));
  });
  it('allocates a source-aligned return lane for a feedback workflow without dropping its condition', async () => {
    const graph: SemanticBlock = {
      ...table,
      spec: {
        type: 'graph',
        nodes: ['接收材料', '初步复核', '协作处理', '现场验证', '归档记录'].map((label, i) => ({
          id: `n${i}`,
          label,
          x: i / 4,
          y: 0.5,
        })),
        edges: [
          ...Array.from({ length: 4 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
          { from: 'n3', to: 'n0', label: '未通过则重新登记' },
        ],
      },
    };
    const style = {
      ...capsule('data'),
      id: `capsule-${'3'.repeat(40)}`,
      kind: 'style',
      designReference: {
        style: {
          id: 'swiss-minimal',
          flat: true,
          grid: true,
          squareCorners: true,
          sparseDecoration: true,
        },
      },
    } as CapabilityCapsule;
    const result = compileLearnedNativeLayout({
      svg: svg('异常交接'),
      title: '异常交接',
      rawBlocks: [graph],
      system,
      capsules: [style, capsule('process')],
      approvedContent: [
        '逐项记录交接凭据',
        '接收材料',
        '初步复核',
        '协作处理',
        '现场验证',
        '归档记录',
        '通过复核后再归档',
      ],
    })!;
    expect(result).toBeDefined();
    expect(result.blocks[0].rect.height).toBeGreaterThan(96);
    const rendered = await renderSemanticBlocks(result.svg, result.blocks);
    expect(rendered.svg.replaceAll(/<[^>]+>/gu, '')).toContain('未通过则重新登记');
    expect(
      inspectVisualOccupancy({
        slideId: 'feedback',
        order: 2,
        svg: rendered.svg,
        metadata: { contentBlocks: result.blocks },
      }),
    ).toEqual([]);
    expect(result.blocks[0]).toMatchObject({
      spec: { edges: graph.spec.type === 'graph' ? graph.spec.edges : [] },
    });
  });
  it('unifies existing page-footer formats without treating a body fraction as a page number', async () => {
    for (const footer of ['报告 · 02 / 03', '2 / 3', '02', '报告 · 2', '报告 • 02']) {
      const source = svg('资料验收').replace('>02</text>', `>${footer}</text>`);
      const result = compileLearnedNativeLayout({
        svg: source,
        title: '资料验收',
        rawBlocks: [table],
        system,
        capsules: [capsule('data')],
        approvedContent: ['任意主题：保留全部源资料', '比例为 1 / 2'],
        pageNumber: 2,
        totalPages: 3,
      })!;
      const output = await renderSemanticBlocks(result.svg, result.blocks);
      expect(output.svg).toContain('>2 / 3</text>');
      expect(output.svg).toContain('>比例为 1 / 2</text>');
      expect(output.svg).not.toContain('报告 ·');
      expect(output.svg).toContain('y="524"');
      expect(output.svg.match(/>2 \/ 3</gu)).toHaveLength(1);
    }
  });
  it('creates one canonical footer even when the author omits it, retaining approved fractions and source notes', async () => {
    const source = svg('资料验收')
      .replace('>02</text>', '>报告</text>')
      .replace('</svg>', '<text x="48" y="520" font-size="14">来源：实验记录</text></svg>');
    const result = compileLearnedNativeLayout({
      svg: source,
      title: '资料验收',
      rawBlocks: [table],
      system,
      capsules: [capsule('data')],
      approvedContent: ['比例为 1 / 2'],
      pageNumber: 2,
      totalPages: 7,
      deckTitle: '报告',
    })!;
    const output = await renderSemanticBlocks(result.svg, result.blocks);
    expect(output.svg).toContain('>2 / 7</text>');
    expect(output.svg).not.toContain('>报告</text>');
    expect(output.svg).toContain('来源：实验记录');
    expect(output.svg).toContain('比例为 1 / 2');
  });
  it('uses the source evidence center and takeaway band instead of packing a sparse flow against the heading', async () => {
    const layout = capsule('process');
    layout.designReference!.slots!.push({
      id: 'takeaway-band',
      kind: 'body',
      box: { x: 0.05, y: 0.85, width: 0.85, height: 0.08 },
    });
    const graph: SemanticBlock = {
      ...table,
      spec: {
        type: 'graph',
        nodes: [
          { id: 'a', label: '接收', x: 0.2, y: 0.5 },
          { id: 'b', label: '交付', x: 0.8, y: 0.5 },
        ],
        edges: [{ from: 'a', to: 'b' }],
      },
    };
    const result = compileLearnedNativeLayout({
      svg: svg('资料流程'),
      title: '资料流程',
      rawBlocks: [graph],
      system,
      capsules: [layout],
      approvedContent: ['逐项核对所有材料', '接收', '交付', '全部完成后交付'],
    })!;
    expect(result.receipt.slotIds).toContain('takeaway-band');
    expect(result.receipt.metrics.evidenceTop).toBeGreaterThan(180);
    expect(result.receipt.metrics.contentBottom).toBeGreaterThan(system.height * 0.85);
    const rendered = await renderSemanticBlocks(result.svg, result.blocks);
    expect(
      inspectVisualOccupancy({
        slideId: 'bands',
        order: 2,
        svg: rendered.svg,
        metadata: { contentBlocks: result.blocks },
      }),
    ).toEqual([]);
  });
  it('keeps ordered peer steps together at one visual level even with a source takeaway slot', () => {
    const layout = capsule('process');
    layout.designReference!.slots!.push({
      id: 'source-takeaway',
      kind: 'body',
      box: { x: 0.05, y: 0.85, width: 0.85, height: 0.08 },
    });
    const graph: SemanticBlock = {
      ...table,
      spec: {
        type: 'graph',
        nodes: [
          { id: 'a', label: '采集', x: 0.1, y: 0.5 },
          { id: 'b', label: '标定', x: 0.5, y: 0.5 },
          { id: 'c', label: '归档', x: 0.9, y: 0.5 },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
      },
    };
    const approvedContent = ['按测点采集样本', '复核传感器精度', '整理交付记录'];
    const result = compileLearnedNativeLayout({
      title: '野外取样',
      svg: svg('野外取样'),
      rawBlocks: [graph],
      system,
      capsules: [layout],
      approvedContent,
    })!;
    const texts = Array.from(parseString(result.svg).getElementsByTagName('text'));
    const lines = approvedContent.map((point) => texts.find((text) => text.textContent === point)!);
    const baselines = lines.map((text) => Number(text.getAttribute('y')));
    expect(baselines[0]).toBeGreaterThan(result.receipt.metrics.evidenceBottom);
    expect(baselines[1] - baselines[0]).toBeCloseTo(baselines[2] - baselines[1]);
    for (const text of lines) {
      expect(text.getAttribute('font-weight')).toBe('normal');
      expect(text.getAttribute('fill')).toBe(system.colors.text);
    }
    expect(result.receipt.slotIds).not.toContain('source-takeaway');
  });
  it('keeps approved table-side metrics at the same weight and preserves qualified observations', () => {
    const layout = capsule('data');
    layout.designReference!.slots![1].box.width = 0.55;
    layout.designReference!.slots!.push({
      id: 'data-notes',
      kind: 'body',
      box: { x: 0.62, y: 0.3, width: 0.34, height: 0.5 },
    });
    const approvedContent = [
      '测量水温',
      '核对深度',
      '记录色度',
      '任意主题：保留全部源资料（待确认）',
    ];
    const result = compileLearnedNativeLayout({
      title: '取样记录',
      svg: svg('取样记录'),
      rawBlocks: [table],
      system,
      capsules: [layout],
      approvedContent,
    })!;
    const texts = Array.from(parseString(result.svg).getElementsByTagName('text'));
    for (const metric of approvedContent.slice(0, 3)) {
      const line = texts.find((text) => text.textContent === metric)!;
      expect(line.getAttribute('font-weight')).toBe('normal');
      expect(line.getAttribute('fill')).toBe(system.colors.text);
    }
    expect(texts.map((text) => text.textContent).join('')).toContain(approvedContent[3]);
  });
  it('routes approved facts without importing placeholder captions or duplicating evidence', async () => {
    const layout = capsule('data');
    layout.designReference!.slots![1].box.width = 0.62;
    layout.designReference!.slots!.push({
      id: 'summary',
      kind: 'body',
      box: { x: 0.76, y: 0.3, width: 0.19, height: 0.5 },
    });
    const source = svg('资料复核').replace(
      '</svg>',
      '<text x="740" y="360" font-size="24">源示例占位词</text><text x="48" y="100" font-size="24">2 / 3</text></svg>',
    );
    const approvedContent = ['任意主题：保留全部源资料', '满足全部条件后交付'];
    const compiled = compileLearnedNativeLayout({
      svg: source,
      title: '资料复核',
      rawBlocks: [table],
      system,
      capsules: [layout],
      approvedContent,
    })!;
    const rendered = await renderSemanticBlocks(compiled.svg, compiled.blocks);
    expect(rendered.svg).not.toContain('源示例占位词');
    expect(rendered.svg).not.toContain('逐项复核');
    expect(rendered.svg).toContain('保留全部源资料');
    expect(rendered.svg).toContain('>2 / 3</text>');
    expect(rendered.svg).toContain('y="524"');
    const repeated = compileLearnedNativeLayout({
      svg: rendered.svg,
      title: '资料复核',
      rawBlocks: compiled.blocks,
      system,
      capsules: [layout],
      approvedContent,
    })!;
    const output = await renderSemanticBlocks(repeated.svg, repeated.blocks);
    expect(output.svg.match(/>保留全部源资料</gu)).toHaveLength(1);
    expect(repeated.receipt.adaptations).toContain(
      'approved content routed to native evidence and source text slots',
    );
  });
  it('reads translated caption columns and inherited footer typography in page coordinates', async () => {
    const graph: SemanticBlock = {
      ...table,
      spec: {
        type: 'graph',
        nodes: [
          { id: 'a', label: '收集', x: 0.1, y: 0.5 },
          { id: 'b', label: '核对', x: 0.5, y: 0.5 },
          { id: 'c', label: '交付', x: 0.9, y: 0.5 },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
      },
    };
    const source = svg('协作流程')
      .replace(
        '<g data-content-id="evidence"/>',
        '<g data-content-id="evidence"/><g transform="translate(180 380)" font-size="18"><text x="0" y="0">收集全部资料</text></g><g transform="translate(480 380)" font-size="18"><text x="0" y="0">核对所有条目</text></g><g transform="translate(780 380)" font-size="18"><text x="0" y="0">交付完整文件</text></g>',
      )
      .replace(
        '<text x="896" y="522" font-size="16">02</text>',
        '<g transform="translate(896 522)" font-size="16"><text x="0" y="0">02</text></g>',
      );
    const result = compileLearnedNativeLayout({
      svg: source,
      title: '协作流程',
      rawBlocks: [graph],
      system,
      capsules: [capsule('process')],
    })!;
    expect(result.receipt.adaptations).toContain('node-aligned explanation columns');
    expect(result.svg).toContain('x="896" y="522"');
    const rendered = await renderSemanticBlocks(result.svg, result.blocks);
    expect(
      inspectVisualOccupancy({
        slideId: 'transformed',
        order: 2,
        svg: rendered.svg,
        metadata: { contentBlocks: result.blocks },
      }),
    ).toEqual([]);
  });
  it('identifies expanded authored headings from typography without dropping their claim', async () => {
    for (const kind of ['data', 'process'] as const) {
      const title = kind === 'data' ? '项目清单' : '材料流程';
      const assertion = `${title}：完整材料逐项核对后再交付`;
      const block: SemanticBlock =
        kind === 'data'
          ? table
          : {
              ...table,
              spec: {
                type: 'graph',
                nodes: [
                  { id: 'a', label: '接收', x: 0.2, y: 0.5 },
                  { id: 'b', label: '交付', x: 0.8, y: 0.5 },
                ],
                edges: [{ from: 'a', to: 'b' }],
              },
            };
      const result = compileLearnedNativeLayout({
        svg: svg(assertion),
        title,
        rawBlocks: [block],
        system,
        capsules: [capsule(kind)],
      })!;
      expect(result).toBeDefined();
      const rendered = await renderSemanticBlocks(result.svg, result.blocks);
      expect(rendered.svg).toContain(assertion);
      expect(rendered.svg).toContain('所有资料保留');
      expect(
        inspectVisualOccupancy({
          slideId: 'assertion',
          order: 2,
          svg: rendered.svg,
          metadata: { contentBlocks: result.blocks },
        }),
      ).toEqual([]);
    }
  });
  it('uses the observed table and summary columns for multi-paragraph conclusions', async () => {
    const layout = capsule('data');
    layout.designReference!.slots!.push({
      id: 'observed-summary',
      kind: 'body',
      box: { x: 0.76, y: 0.3, width: 0.19, height: 0.5 },
    });
    layout.designReference!.slots![1].box.width = 0.62;
    const source = svg('项目清单')
      .replace('逐项复核', '先复核所有资料，再核对交付文件')
      .replace('</svg>', '<text x="740" y="480" font-size="24">每项均需保留完整凭据</text></svg>');
    const result = compileLearnedNativeLayout({
      svg: source,
      title: '项目清单',
      rawBlocks: [table],
      system,
      capsules: [layout],
    })!;
    expect(result).toBeDefined();
    expect(result.receipt.slotIds).toContain('observed-summary');
    expect(result.blocks[0].rect.width).toBeLessThan(700);
    const rendered = await renderSemanticBlocks(result.svg, result.blocks);
    const restored = compileLearnedNativeLayout({
      svg: rendered.svg,
      title: '项目清单',
      rawBlocks: result.blocks,
      system,
      capsules: [layout],
    })!;
    expect(restored).toBeDefined();
    expect(restored.receipt.slotIds).toContain('observed-summary');
    expect(
      inspectVisualOccupancy({
        slideId: 'columns',
        order: 2,
        svg: rendered.svg,
        metadata: { contentBlocks: result.blocks },
      }),
    ).toEqual([]);
  });
  it('fits long approved notes next to an editable four-week table on the observed grid', async () => {
    const source = capsule('data');
    source.designReference!.slots![1].box = {
      x: 0.06875,
      y: 0.2444,
      width: 0.60625,
      height: 0.5667,
    };
    source.designReference!.slots!.push({
      id: 'narrow-summary',
      kind: 'body',
      box: { x: 0.74375, y: 0.2556, width: 0.18125, height: 0.4778 },
    });
    const approvedContent = [
      '开放日：每周三、周五（拟议）',
      '时段：18:30–20:30，每晚 2 小时（设定值）',
      '开放区域：阅读区与借还台（拟议）',
      '周次与两个开放日分别占一列，便于现场核对与编辑',
    ];
    const exhibit = {
      ...table,
      spec: {
        type: 'table',
        columns: ['周次', '周三 18:30–20:30', '周五 18:30–20:30'],
        rows: ['第一周', '第二周', '第三周', '第四周'].map((week) => [
          week,
          '阅读区与借还台',
          '阅读区与借还台',
        ]),
        fontSize: 20,
        headerFill: '#1D3E6B',
      },
    };
    const result = compileLearnedNativeLayout({
      svg: svg('轮值安排'),
      title: '轮值安排',
      rawBlocks: [exhibit],
      system,
      capsules: [source],
      approvedContent,
      pageNumber: 3,
      totalPages: 7,
    })!;
    expect(result?.receipt.slotIds).toContain('narrow-summary');
    const rendered = await renderSemanticBlocks(result.svg, result.blocks);
    const text = rendered.svg.replaceAll(/<[^>]+>/gu, '');
    approvedContent.forEach((point) => expect(text).toContain(point));
    expect(result.blocks[0]).toMatchObject({ spec: { rows: exhibit.spec.rows } });
    expect(result.receipt.metrics.contentBottom).toBeLessThan(system.height - 24);
    expect(
      inspectVisualOccupancy({
        slideId: 'table',
        order: 3,
        svg: rendered.svg,
        metadata: { contentBlocks: result.blocks },
      }),
    ).toEqual([]);
    const legacy = {
      planId: 'persisted',
      title: '试点安排',
      aspectRatio: '16:9' as const,
      sourceVersionIds: [],
      designSpec: {
        deckVisualSystem: system,
        layoutCompatibility: {
          schemaVersion: 1,
          pages: [
            {
              slideId: 'table',
              requirements: [{ kind: 'chart' }],
              layoutIds: ['generic-chart-lane'],
            },
          ],
        },
      },
      slides: [
        {
          slideId: 'table',
          order: 3,
          svg: rendered.svg,
          metadata: { title: '轮值安排', outline: approvedContent, contentBlocks: result.blocks },
        },
      ],
    };
    const reviewed = await stabilizePresentationVisuals(legacy, undefined, [source]);
    const exported = await stabilizePresentationVisuals(reviewed, undefined, [source], 'export');
    expect(reviewed.slides[0].metadata?.compiledDesign).toMatchObject({
      layoutCapsuleId: source.id,
    });
    expect(exported.slides[0].svg).toBe(reviewed.slides[0].svg);
  });

  it('preserves every line of an expanded heading through native repair recompilation', async () => {
    const title = '多部门交接时分别核对责任人与原始资料，并保留每一次现场复核的完整记录';
    const input = {
      svg: svg(title),
      title,
      rawBlocks: [table],
      system,
      capsules: [capsule('data')],
      approvedContent: ['逐项复核'],
    };
    const first = compileLearnedNativeLayout(input)!;
    const rendered = await renderSemanticBlocks(first.svg, first.blocks);
    const second = compileLearnedNativeLayout({
      ...input,
      svg: rendered.svg,
      rawBlocks: first.blocks,
    })!;
    expect(second.svg.replaceAll(/<[^>]+>/gu, '')).toContain(title);
    expect(second.receipt.metrics.headerBottom).toBe(first.receipt.metrics.headerBottom);
    const shortened = compileLearnedNativeLayout({ ...input, svg: svg('交接清单') })!;
    expect(shortened.svg.replaceAll(/<[^>]+>/gu, '')).toContain(title);
  });
  it('reports an explicit skip when no compatible source layout exists', () => {
    const reasons: string[] = [];
    expect(
      compileLearnedNativeLayout({
        svg: svg('任意材料'),
        title: '任意材料',
        rawBlocks: [table],
        system,
        capsules: [],
        onSkip: (reason) => reasons.push(reason),
      }),
    ).toBeUndefined();
    expect(reasons).toEqual(['no-compatible-source-layout']);
  });
  it('records actual compiled use through the generation planner without relying on the model to claim it', async () => {
    const data = capsule('data');
    const title = '项目验收';
    const planner = createGLMPresentationPlanner({
      chatPort: {
        providerId: 'test',
        manifest: {
          model: 'test',
          providerId: 'test',
          displayName: 'Test',
          supportsVision: false,
          supportsIdempotency: false,
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
                  planId: 'test',
                  title,
                  aspectRatio: '16:9',
                  sourceVersionIds: [],
                  slides: [
                    {
                      slideId: 'slide-1',
                      order: 1,
                      svg: svg(title),
                      contentBlocks: [table],
                      notes: '请逐项复核资料。',
                    },
                  ],
                }),
              },
            },
          ],
        }),
      },
    });
    const result = await planner.plan(
      {
        title,
        notebookId: 'test',
        sourceVersionIds: [],
        slideCount: 1,
        options: {
          outline: [{ title }],
          deckVisualSystem: system,
          learnedCapabilities: { capsules: [data] },
        },
      },
      { scope: { userId: 'alice', sessionId: 'test' } },
    );
    expect(result.slides[0].metadata?.compiledDesign).toMatchObject({
      layoutCapsuleId: data.id,
      slotIds: ['source-title', 'source-evidence'],
    });
    expect(result.slides[0].metadata?.capabilityUses).toHaveLength(1);
    expect(result.slides[0].svg).toContain('保留全部源资料');
    expect(result.slides[0].notes).toBe('请逐项复核资料。');
  });
  it('uses observed cover geometry across topics instead of reintroducing a universal decorative frame', () => {
    const cover = capsule('data');
    cover.layout = { ...cover.layout!, roles: ['cover'] };
    cover.designReference = {
      slots: [
        {
          id: 'title-slot',
          kind: 'title',
          box: { x: 0.12, y: 0.28, width: 0.76, height: 0.2 },
          fontSize: 42,
        },
        {
          id: 'subtitle-slot',
          kind: 'subtitle',
          box: { x: 0.12, y: 0.55, width: 0.76, height: 0.15 },
        },
      ],
    };
    const style: CapabilityCapsule = {
      ...capsule('data'),
      id: `capsule-${'3'.repeat(40)}`,
      kind: 'style',
      layout: undefined,
      designReference: {
        style: {
          id: 'swiss-minimal',
          flat: true,
          sparseDecoration: true,
          squareCorners: true,
          grid: true,
        },
      },
    };
    const preset = createDeckVisualSystem({
      title: '阅读空间夜间试点计划',
      notebookId: 'test',
      sourceVersionIds: [],
      options: { styleWorkspaceId: 'academic-research' },
    })!;
    const title = '阅读空间夜间试点计划';
    const result = compileLearnedNativeLayout({
      title,
      svg: svg(title),
      rawBlocks: [],
      system: preset,
      role: 'cover',
      capsules: [
        { ...style, source: { ...style.source, workspaceId: 'academic-research' } },
        cover,
      ],
      approvedContent: ['与社区读者共同讨论下一季度开放时间'],
    })!;
    const doc = parseString(result.svg);
    const heading = Array.from(doc.getElementsByTagName('text')).find(
      (el) => el.textContent === title,
    )!;
    const slotWidth = Number(
      (heading.parentNode as Element).getAttribute('data-pptx-bounds')!.split(' ')[2],
    );
    // The native checker reserves 1.06 em for each sans-serif CJK glyph even
    // when every glyph fits its SVG ink bound at exactly 1 em.
    const titleSize = Number(heading.getAttribute('font-size'));
    expect(titleSize).toBeGreaterThan(50);
    expect([...title].length * titleSize * 1.06).toBeLessThanOrEqual(slotWidth);
    for (const title of ['服务交付方案', '研究项目复核']) {
      const compiled = compileLearnedNativeLayout({
        title,
        svg: svg(title),
        rawBlocks: [],
        system,
        role: 'cover',
        capsules: [style, cover],
        approvedContent: ['所有资料保留', '逐项复核', '全部图像和数据为人工构造的示意材料'],
      })!;
      expect(compiled.receipt.slotIds).toContain('title-slot');
      expect(compiled.svg).toContain(title);
      expect(compiled.svg).toContain('所有资料保留');
      expect(compiled.svg).toContain('逐项复核');
      expect(compiled.svg).not.toContain('<circle');
      expect(compiled.svg).toContain('全部图像和数据为人工构造的示意材料');
      expect(compiled.svg).not.toContain('font-size="18"');
    }
  });
  it('uses real source anchors, preserves every string, and compacts intrinsic evidence rather than copying empty slots', async () => {
    const input = {
      svg: svg('服务证据'),
      title: '服务证据',
      rawBlocks: [table],
      system,
      capsules: [capsule('data')],
    };
    const compiled = compileLearnedNativeLayout(input)!;
    expect(compiled.receipt.slotIds).toEqual(['source-title', 'source-evidence']);
    expect(compiled.blocks[0].rect.x).toBe(48);
    const bandTop = 0.3 * system.height,
      bandBottom = 0.8 * system.height;
    const actual = compiled.blocks[0].rect;
    expect(actual.y - bandTop).toBeCloseTo(bandBottom - actual.y - actual.height, 6);
    expect(actual.y).toBeGreaterThan(compiled.receipt.metrics.headerBottom + 28);
    expect(compiled.receipt.metrics.contentBottom).toBeLessThan(500);
    const changed = compileLearnedNativeLayout({ ...input, capsules: [capsule('data', 0.1)] })!;
    expect(changed.blocks[0].rect.x).toBe(96);
    const rendered = await renderSemanticBlocks(compiled.svg, compiled.blocks);
    for (const phrase of [
      '服务证据',
      '所有资料保留',
      '任意主题',
      '保留全部源资料',
      '逐项复核',
      '02',
    ])
      expect(rendered.svg).toContain(phrase);
  });
  it.each([2, 3, 5])(
    'compiles %i process nodes without topic matching or changing node/edge evidence',
    async (count) => {
      const graph: SemanticBlock = {
        ...table,
        spec: {
          type: 'graph',
          nodes: Array.from({ length: count }, (_, i) => ({
            id: `n${i}`,
            label: `步骤${i + 1}`,
            x: i / count,
            y: 0.5,
          })),
          edges: Array.from({ length: count - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
        },
      };
      const result = compileLearnedNativeLayout({
        svg: svg('任意流程'),
        title: '任意流程',
        rawBlocks: [graph],
        system,
        capsules: [capsule('process')],
      })!;
      expect(
        result.blocks[0].kind === 'scientific-diagram' &&
          result.blocks[0].spec.type === 'graph' &&
          result.blocks[0].spec.nodes,
      ).toEqual(graph.spec.type === 'graph' && graph.spec.nodes);
      const rendered = await renderSemanticBlocks(result.svg, result.blocks);
      expect(rendered.svg).not.toContain('scale(');
      expect(rendered.svg).toContain('font-size="24"');
      expect(result.svg).toContain('id="learned-background"');
      const restored = compileLearnedNativeLayout({
        svg: rendered.svg,
        title: '任意流程',
        rawBlocks: result.blocks,
        system,
        capsules: [capsule('process')],
      })!;
      expect(restored).toBeDefined();
      const repeated = await renderSemanticBlocks(restored.svg, restored.blocks);
      expect(repeated.svg.match(/>步骤1</gu)).toHaveLength(1);
    },
  );
  it('reapplies observed style after automatic repairs without duplicating native labels', async () => {
    const graph: SemanticBlock = {
      ...table,
      spec: {
        type: 'graph',
        nodes: [
          { id: 'a', label: '接收材料', x: 0.2, y: 0.5 },
          { id: 'b', label: '核对原稿', x: 0.8, y: 0.5 },
        ],
        edges: [{ from: 'a', to: 'b' }],
      },
    };
    const style: CapabilityCapsule = {
      ...capsule('process'),
      id: `capsule-${'3'.repeat(40)}`,
      kind: 'style',
      designReference: {
        style: {
          id: 'sparse',
          flat: true,
          sparseDecoration: true,
          squareCorners: true,
          grid: true,
        },
      },
    };
    const repaired = await renderSemanticBlocks(
      svg('资料流程').replace(
        '</svg>',
        '<text x="70" y="120" font-size="24">接收材料</text></svg>',
      ),
      [graph],
    );
    const result = await stabilizePresentationVisuals(
      {
        planId: 'repair',
        title: '资料流程',
        aspectRatio: '16:9',
        sourceVersionIds: [],
        designSpec: { deckVisualSystem: system },
        slides: [
          {
            slideId: 'slide-2',
            order: 2,
            svg: repaired.svg,
            metadata: {
              title: '资料流程',
              contentBlocks: [graph],
              compiledDesign: { schemaVersion: 1 },
            },
          },
        ],
      },
      undefined,
      [style, capsule('process')],
    );
    const output = result.slides[0];
    expect(output.svg.match(/>接收材料</gu)).toHaveLength(1);
    expect(output.svg).not.toContain('#eff6ff');
    expect(output.metadata?.compiledDesign).toMatchObject({ styleCapsuleId: style.id });
    expect(output.metadata?.contentBlocks).toMatchObject([
      { spec: { style: { nodeFill: 'none', fontSize: 24 } } },
    ]);
  });
  it('preserves parallel node explanations as columns instead of stacking them into an overflowing text rail', async () => {
    const graph: SemanticBlock = {
      ...table,
      spec: {
        type: 'graph',
        nodes: [
          { id: 'a', label: '第一阶段', x: 0.1, y: 0.5 },
          { id: 'b', label: '第二阶段', x: 0.5, y: 0.5 },
          { id: 'c', label: '第三阶段', x: 0.9, y: 0.5 },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
      },
    };
    const source = svg('项目流程').replace(
      '<g data-content-id="evidence"/>',
      '<g data-content-id="evidence"/><text x="180" y="380" font-size="18">确定服务范围与要求</text><text x="480" y="380" font-size="18">逐项复核原始资料</text><text x="780" y="380" font-size="18">确认交付文件完整</text>',
    );
    const style: CapabilityCapsule = {
      ...capsule('data'),
      kind: 'style',
      layout: undefined,
      designReference: {
        style: {
          id: 'swiss-minimal',
          flat: true,
          sparseDecoration: true,
          squareCorners: true,
          grid: true,
        },
      },
    };
    const compiled = compileLearnedNativeLayout({
      svg: source,
      title: '项目流程',
      rawBlocks: [graph],
      system,
      capsules: [style, capsule('process')],
    })!;
    expect(compiled.receipt.adaptations).toContain('node-aligned explanation columns');
    expect(compiled.receipt.metrics.contentBottom).toBeLessThan(500);
    const rendered = await renderSemanticBlocks(compiled.svg, compiled.blocks);
    expect(
      inspectVisualOccupancy(
        {
          slideId: 'flow',
          order: 1,
          svg: rendered.svg,
          metadata: { contentBlocks: rendered.blocks },
        },
        new Map(),
      ),
    ).toEqual([]);
    for (const text of ['确定服务范围与要求', '逐项复核原始资料', '确认交付文件完整'])
      expect(rendered.svg).toContain(text);
  });
  it('leaves complex artwork and pages without a compatible observed layout in their authoring path', () => {
    expect(
      compileLearnedNativeLayout({
        svg: svg('服务证据'),
        title: '服务证据',
        rawBlocks: [table],
        system,
        capsules: [capsule('process')],
      }),
    ).toBeUndefined();
    expect(
      compileLearnedNativeLayout({
        svg: svg('服务证据').replace('</svg>', '<image href="owned.png"/></svg>'),
        title: '服务证据',
        rawBlocks: [table],
        system,
        capsules: [capsule('data')],
      }),
    ).toBeUndefined();
  });
});
