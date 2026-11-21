import { describe, expect, it } from 'vitest';

import type { CapabilityCapsule } from './capability-memory';
import { inspectPresentationContent } from './content-quality';
import { createDeckVisualSystem } from './deck-visual-system';
import { learnedTextLines } from './learned-layout-primitives';
import { compileLearnedNativeLayout } from './learned-native-layout';
import { inspectVisualOccupancy } from './visual-ownership';

const system = createDeckVisualSystem({
  title: '跨部门协作方案',
  notebookId: 'test',
  sourceVersionIds: [],
  options: { style: '简洁排版' },
})!;
const style = {
  id: `capsule-${'a'.repeat(40)}`,
  kind: 'style',
  designReference: {
    style: {
      id: 'swiss-minimal',
      grid: true,
      sparseDecoration: true,
      squareCorners: true,
      flat: true,
    },
  },
} as CapabilityCapsule;
const layout = (count: number, left = 0.08): CapabilityCapsule =>
  ({
    id: `capsule-${String(count).repeat(40)}`,
    kind: 'layout',
    source: { sourceDigest: 'b'.repeat(64), aspectRatio: '16:9', evidencePages: [5] },
    layout: { roles: [count === 2 ? 'comparison' : count === 1 ? 'cover' : 'content'] },
    designReference: {
      slots: [
        { id: 'heading', kind: 'title', box: { x: left, y: 0.08, width: 0.84, height: 0.15 } },
        ...Array.from({ length: count }, (_, i) => ({
          id: `column-${i}`,
          kind: 'object' as const,
          box: { x: left + i * (0.84 / count), y: 0.3, width: 0.84 / count - 0.035, height: 0.59 },
        })),
      ],
    },
  }) as CapabilityCapsule;

describe('learned text layouts across new content', () => {
  it('balances a source sidebar conclusion without splitting words or leaving an orphan tail', () => {
    const text = '资料和签字齐全后，才确认交接完成';
    const lines = learnedTextLines(text, 174, 24, system.fontFamily, true);
    expect(lines.join('')).toBe(text);
    expect([...lines.at(-1)!].length).toBeGreaterThanOrEqual(3);
    expect(lines.some((line) => line.endsWith('签') || line.endsWith('交'))).toBe(false);
    expect(() => learnedTextLines('UNBREAKABLE_IDENTIFIER', 30, 24, system.fontFamily)).toThrow(
      /exceeds/,
    );
  });
  it('keeps paired punctuation and clock times intact at narrow widths', () => {
    const text = '开放安排——报名时间18:30，详情请见附表……';
    for (const width of [90, 120, 155, 190]) {
      const lines = learnedTextLines(text, width, 20, system.fontFamily);
      expect(lines.join('')).toBe(text);
      expect(lines.some((line) => /(?<!—)—$|(?<!…)…$|18:$|18:3$/u.test(line))).toBe(false);
    }
  });
  it('applies source aspect ratios numerically on a different canvas', () => {
    const source = layout(2);
    source.source.aspectRatio = '4:3';
    const result = compileLearnedNativeLayout({
      svg: '<svg/>',
      title: '跨团队复核',
      rawBlocks: [],
      approvedContent: ['资料：保留来源', '交接：核对签字'],
      system: { ...system, height: 720 },
      capsules: [style, source],
    });
    expect(result).toBeDefined();
    expect(result!.svg).toContain('viewBox="0 0 960 720"');
  });
  it.each([2, 3])(
    'uses %i source columns, preserving long grouped facts through repeated compilation',
    (count) => {
      const points = [
        '资料追溯：每次修订都关联原始来源；责任人逐项核对后保存记录',
        '协作边界：业务人员确认范围；交付人员负责版本和讲稿',
        '发布条件：负责人核对文件；异常项留在待办记录',
      ].slice(0, count);
      const input = {
        svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        rawBlocks: [],
        title: '资料交接在多团队协作中的责任边界与复核方法',
        approvedContent: points,
        system,
        capsules: [style, layout(count)],
        pageNumber: 4,
        totalPages: 8,
      };
      const first = compileLearnedNativeLayout(input)!;
      expect(first).toBeDefined();
      expect(first.receipt.slotIds).toHaveLength(count + 1);
      expect(first.svg).toContain('>4 / 8</text>');
      const visible = first.svg.replaceAll(/<[^>]+>/gu, '');
      for (const phrase of ['责任人逐项核对后保存记录', '交付人员负责版本和讲稿'])
        expect(visible).toContain(phrase);
      expect(inspectVisualOccupancy({ slideId: 'columns', order: 4, svg: first.svg })).toEqual([]);
      expect(
        inspectPresentationContent({
          planId: 'parallel',
          title: input.title,
          aspectRatio: '16:9',
          sourceVersionIds: [],
          slides: [{ slideId: 'columns', order: 4, svg: first.svg }],
        }).passed,
      ).toBe(true);
      const second = compileLearnedNativeLayout({ ...input, svg: first.svg })!;
      expect(second.svg).toBe(first.svg);
      const moved = compileLearnedNativeLayout({
        ...input,
        capsules: [style, layout(count, 0.1)],
      })!;
      expect(moved.svg).not.toBe(first.svg);
      expect(first.svg).not.toContain('rx=');
    },
  );
  it('reports a capacity failure for dense parallel facts rather than dropping text or shrinking the font', () => {
    const reasons: string[] = [];
    const result = compileLearnedNativeLayout({
      svg: '<svg/>',
      title: '高密度材料',
      rawBlocks: [],
      approvedContent: [
        '核对：' + '保留原始资料和全部异常记录。'.repeat(60),
        '交接：每次复核完整文件',
      ],
      system,
      capsules: [style, layout(2)],
      onSkip: (reason) => reasons.push(reason),
    });
    expect(result).toBeUndefined();
    expect(reasons).toEqual(['content-exceeds-source-capacity']);
  });
  it('puts a shared conclusion below parallel labelled facts and preserves it on repeat compilation', () => {
    const points = [
      '需求一：下班后借阅',
      '需求二：安静自习',
      '需求三：亲子共读',
      '各方共用同一开放时段',
    ];
    const input = {
      svg: '<svg/>',
      rawBlocks: [],
      title: '夜间需求',
      approvedContent: points,
      system,
      capsules: [style, layout(3)],
    };
    const first = compileLearnedNativeLayout(input)!;
    expect(first?.receipt.layoutCapsuleId).toBe(layout(3).id);
    expect(first.svg).toContain('>各方共用同一开放时段</text>');
    expect(compileLearnedNativeLayout({ ...input, svg: first.svg })!.svg).toBe(first.svg);
  });
  it('anchors sparse groups to measured source slots with consistent separation', () => {
    const source = layout(3);
    const input = {
      svg: '<svg/>',
      rawBlocks: [],
      title: '发布前的核查项',
      approvedContent: ['核对来源记录', '确认实际版本', '核对签字时间'],
      system,
      capsules: [style, source],
    };
    const result = compileLearnedNativeLayout(input)!;
    expect(result.receipt.metrics.evidenceTop).toBe(162);
    expect(result.svg.match(/<line /gu)).toHaveLength(3);
    expect(compileLearnedNativeLayout({ ...input, svg: result.svg })!.svg).toBe(result.svg);
  });
  it('recreates the observed cover anchor with measured long title height and no invented accent', () => {
    const cover = layout(1);
    cover.designReference!.slots = [
      {
        id: 'cover-title',
        kind: 'title',
        box: { x: 0.12, y: 0.23, width: 0.76, height: 0.22 },
        fontSize: 42,
      },
      {
        id: 'cover-subtitle',
        kind: 'subtitle',
        box: { x: 0.12, y: 0.55, width: 0.76, height: 0.18 },
      },
    ];
    cover.designReference!.accents = [
      {
        id: 'source-cover-rule',
        box: { x: 0.07, y: 0.23, width: 0.005, height: 0.33 },
        fill: '#CBD5E1',
      },
    ];
    const title = '跨部门设备维护与异常交接的实施方案和职责边界';
    const input = {
      svg: `<svg><text x="70" y="180" font-size="42">${title}</text></svg>`,
      title,
      rawBlocks: [],
      system,
      role: 'cover' as const,
      approvedContent: ['模拟材料，不代表实际运营数据', '供实施团队讨论'],
      capsules: [style, cover],
    };
    const result = compileLearnedNativeLayout(input)!;
    expect(result.svg).toContain('id="learned-source-cover-rule"');
    expect(result.svg).toContain('x="67.2"');
    expect(result.svg).not.toContain('learned-page-number');
    expect(inspectVisualOccupancy({ slideId: 'cover', order: 1, svg: result.svg })).toEqual([]);
    expect(compileLearnedNativeLayout({ ...input, svg: result.svg })!.svg).toBe(result.svg);
    const shortened = compileLearnedNativeLayout({
      ...input,
      svg: '<svg><text x="70" y="180" font-size="42">设备维护与交接</text></svg>',
    })!;
    expect(shortened.svg.replaceAll(/<[^>]+>/gu, '')).toContain(title);
    cover.designReference!.accents = [];
    expect(compileLearnedNativeLayout(input)!.svg).not.toContain('learned-source-cover-rule');
  });
});
