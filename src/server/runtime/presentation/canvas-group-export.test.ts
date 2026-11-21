import { describe, expect, it } from 'vitest';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import { projectCanvasGroups } from './canvas-group-export';

describe('exporting manually positioned text', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><g id="cover" data-pptx-bounds="84 162 653 325"><g transform="translate(0 -78)"><text data-canvas-object="title" x="84" y="230" font-size="68">夜读计划</text></g></g><g id="footer" data-pptx-bounds="20 480 900 60"/></svg>';

  it('extends only the authored module, preserving the frame transform and paint order', () => {
    expect(projectCanvasGroups(svg)).toBe(svg);
    const projected = projectCanvasGroups(svg, ['title']);
    const doc = parseString(projected);
    const bounds = doc
      .getElementById('cover')!
      .getAttribute('data-pptx-bounds')!
      .split(' ')
      .map(Number);
    expect(bounds[0]).toBe(84);
    expect(bounds[1]).toBeCloseTo(94.2);
    expect(bounds[1] + bounds[3]).toBeCloseTo(487);
    expect(projected).toContain('transform="translate(0 -78)"');
    expect(doc.getElementById('footer')!.getAttribute('data-pptx-bounds')).toBe('20 480 900 60');
    expect(projectCanvasGroups(projected, ['title'])).toBe(projected);
  });

  it('keeps the page limit and template placeholder contracts', () => {
    const outside = svg.replace('0 -78', '0 -300');
    const bounds = parseString(projectCanvasGroups(outside, ['title']))
      .getElementById('cover')!
      .getAttribute('data-pptx-bounds');
    expect(bounds).toBe('84 0 653 487');
    const slot = svg.replace('id="cover"', 'id="cover" data-pptx-placeholder="body"');
    expect(
      parseString(projectCanvasGroups(slot, ['title']))
        .getElementById('cover')!
        .getAttribute('data-pptx-bounds'),
    ).toBe('84 162 653 325');
  });
});
