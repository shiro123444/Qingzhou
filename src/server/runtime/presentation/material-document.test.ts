import { describe, expect, it } from 'vitest';

import {
  createMaterialDocument,
  materialContextForSlides,
  mergePresentationMaterials,
} from './material-document';

describe('page and text evidence', () => {
  it('keeps the tail and all characters of long materials without inventing physical page numbers', () => {
    const text = '# 前半部分\n' + '课程资料🙂\n'.repeat(6500) + '\n末尾事实：预算37万元';
    const document = createMaterialDocument({ sourceId: 'a', name: 'report.md', content: text });
    expect(document.segments.map((segment) => segment.text).join('')).toBe(text);
    expect(document.segments.at(-1)?.text).toContain('预算37万元');
    expect(document.segments.every((segment) => segment.text.length <= 1800)).toBe(true);
    expect(document.segments[0].locator).toEqual({ section: 1, chunk: 1 });
    expect(
      createMaterialDocument({ sourceId: 'a', name: 'report.md', content: text }).manifest
        .fingerprint,
    ).toBe(document.manifest.fingerprint);
  });

  it('preserves parser page labels and identifies unreadable/scanned pages', () => {
    const document = createMaterialDocument({
      sourceId: 'a',
      name: 'report.pdf',
      content: '',
      pages: [
        { pageContent: '教学计划', metadata: { pageNumber: 2 } },
        { pageContent: '', metadata: { pageNumber: 3 } },
        { pageContent: '科研预算37万元', metadata: { pageNumber: 4 } },
      ],
    });
    expect(document.manifest.emptyPages).toEqual([3]);
    expect(document.segments.map((segment) => segment.locator.page)).toEqual([2, 4]);
    expect(() =>
      createMaterialDocument({
        sourceId: 'a',
        name: 'bad.pdf',
        content: '',
        pages: [{ pageContent: '', metadata: { error: 'parser failed' } }],
      }),
    ).toThrow('解析失败');
  });

  it('merges exact multi-source evidence, invalidates stale versions and selects the cited segments for generation', () => {
    const a = createMaterialDocument({ sourceId: 'a', name: 'a.txt', content: '计划12门课程' });
    const b = createMaterialDocument({ sourceId: 'b', name: 'b.txt', content: '预算37万元' });
    let materials = mergePresentationMaterials(undefined, {
      document: a.manifest,
      segments: a.segments,
    });
    materials = mergePresentationMaterials(materials, {
      document: b.manifest,
      segments: b.segments,
    });
    expect(materials?.segments).toHaveLength(2);
    expect(materialContextForSlides(materials, [])?.coverage?.map((entry) => entry.complete)).toEqual([true, true]);
    expect(
      materialContextForSlides(materials, [{ sourceRefs: [{ sourceId: 'b', segmentId: b.segments[0].id }] }])
        ?.segments,
    ).toEqual(b.segments);
    const updated = createMaterialDocument({
      sourceId: 'a',
      name: 'a.txt',
      content: '计划14门课程',
    });
    materials = mergePresentationMaterials(materials, {
      document: updated.manifest,
      segments: updated.segments,
    });
    expect(materials?.segments.map((segment) => segment.text)).toEqual([
      '预算37万元',
      '计划14门课程',
    ]);
  });
});
