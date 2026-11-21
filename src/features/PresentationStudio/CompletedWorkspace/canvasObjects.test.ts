import { describe, expect, it } from 'vitest';

import { movePreview, presentationCanvasObjects, readCanvasDocument } from './canvasObjects';

describe('Presentation object canvas', () => {
  const rect = { x: 52, y: 65, width: 430, height: 240 };

  it('adapts formula and diagram rectangles while preserving exact chart points', () => {
    const series = [
      {
        label: 'Response',
        points: [
          [1, 8],
          [2.5, -1],
        ],
      },
    ];
    const chart = {
      id: 'load',
      kind: 'scientific-diagram',
      title: 'Load trial',
      rect,
      spec: { type: 'plot', xLabel: 'Load', yLabel: 'Response', series },
    };
    const { charts, objects } = presentationCanvasObjects([
      chart,
      { ...chart, id: 'vector', spec: { ...chart.spec, equalAspect: true } },
      { id: 'ratio', kind: 'formula', latex: 'R=S/F', rect },
      { id: 'broken', rect: { ...rect, width: 0 } },
    ]);
    expect(objects.map(({ id }) => id)).toEqual(['load', 'vector', 'ratio']);
    expect(charts).toHaveLength(1);
    expect(charts[0].series).toEqual(series);
    expect(charts[0].exportFormat).toBeUndefined();
    expect(
      presentationCanvasObjects([chart], { charts: ['load'], tables: [] }).charts[0].exportFormat,
    ).toBe('chart');
    expect(
      presentationCanvasObjects([chart], { charts: [], tables: ['load'] }).charts[0].exportFormat,
    ).toBe('shapes');
    expect(
      presentationCanvasObjects([chart], { charts: [{}] }).charts[0].exportFormat,
    ).toBeUndefined();
  });

  it('opens only confirmed native tables with complete rows and their original headers', () => {
    const spec = { type: 'table', columns: ['指标', '方式'], rows: [['到馆人次', '入口记录']] };
    const source = { kind: 'scientific-diagram', id: 'visual-1', title: '夜读指标', rect, spec };
    expect(presentationCanvasObjects([source], { tables: ['visual-1'] }).tables).toEqual([
      { id: 'visual-1', title: '夜读指标', columns: spec.columns, rows: spec.rows },
    ]);
    expect(presentationCanvasObjects([source]).tables).toEqual([]);
    expect(presentationCanvasObjects([source], { tables: [] }).tables).toEqual([]);
    expect(
      presentationCanvasObjects([{ ...source, spec: { ...spec, rows: [['缺一格']] } }], {
        tables: ['visual-1'],
      }).tables,
    ).toEqual([]);
  });

  it('drafts a move in SVG units on a nonzero viewBox and leaves the source and sibling untouched', () => {
    const source = readCanvasDocument(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 1280 720"><g data-scientific-diagram="load" transform="translate(52 65)"><path d="M0 0L3 6"/></g><g data-content-id="ratio"/></svg>',
    )!;
    expect({ x: source.x, y: source.y, width: source.width, height: source.height }).toEqual({
      x: 10,
      y: 20,
      width: 1280,
      height: 720,
    });
    const draft = movePreview(source.document, { ...rect, id: 'load' }, 92, 55)!;
    const moved = readCanvasDocument(draft)!;
    expect(
      moved.document.querySelector('[data-scientific-diagram]')?.getAttribute('transform'),
    ).toBe('translate(40 -10) translate(52 65)');
    expect(
      source.document.querySelector('[data-scientific-diagram]')?.getAttribute('transform'),
    ).toBe('translate(52 65)');
    expect(moved.document.querySelector('[data-content-id]')?.outerHTML).toBe(
      source.document.querySelector('[data-content-id]')?.outerHTML,
    );
  });
});
