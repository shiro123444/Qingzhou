import { describe, expect, it } from 'vitest';

import { selectAnnotationElements } from './geometry';

describe('annotation selection', () => {
  const boxes = [
    { index: 0, x: 0, y: 0, width: 1, height: 1 },
    { index: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
    { index: 2, x: 0.5, y: 0.2, width: 0.3, height: 0.5 },
  ];
  it('selects a text hit above the full-page background at any preview scale', () => {
    expect(selectAnnotationElements(boxes, { x: 0.2, y: 0.15, width: 0, height: 0 })).toEqual([1]);
  });
  it('selects only fully enclosed elements, preserving a neighboring image', () => {
    expect(selectAnnotationElements(boxes, { x: 0.05, y: 0.05, width: 0.4, height: 0.3 })).toEqual([
      1,
    ]);
  });
  it('keeps blank background out of hits and prefers text under the finger to a nearby thin rule', () => {
    const candidates: typeof boxes = [
      boxes[1],
      { index: 3, x: 0.202, y: 0.132, width: 0.005, height: 0.04 },
    ];
    expect(
      selectAnnotationElements(
        candidates,
        { x: 0.2, y: 0.15, width: 0, height: 0 },
        { x: 0.03, y: 0.03 },
      ),
    ).toEqual([1]);
    expect(
      selectAnnotationElements([{ ...boxes[0], kind: 'background' }], {
        x: 0.08,
        y: 0.02,
        width: 0,
        height: 0,
      }),
    ).toEqual([]);
  });
});
