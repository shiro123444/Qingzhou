import { describe, expect, it } from 'vitest';

import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import { moveCanvasObject } from '../../../../packages/runtime-contracts/src/canvas';
import { applyObjectPositionPatch, canvasMoveForSlide } from './object-position-edit';
import { renderSemanticBlocks } from './semantic-blocks';

describe('presentation object positioning', () => {
  const rect = { x: 40, y: 100, width: 400, height: 180 };
  const input = {
    blockId: 'readings',
    expectedVersionId: 'v1',
    x: 140,
    y: 120,
  };
  const target = { type: 'slide' as const, slideNumber: 1 };
  async function fixture() {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><g id="native" data-pptx-bounds="40 100 400 180"><g data-content-id="readings"/></g></svg>';
    const { svg, blocks } = await renderSemanticBlocks(source, [
      {
        id: 'readings',
        kind: 'scientific-diagram',
        title: 'Load',
        rect,
        provenance: { kind: 'source', reference: 'Meter' },
        spec: {
          type: 'plot',
          xRange: [0, 5],
          yRange: [0, 6],
          xLabel: 's',
          yLabel: 'A',
          series: [
            {
              label: 'A',
              points: [
                [1, 2],
                [2, 3],
              ],
            },
          ],
        },
      },
    ]);
    return {
      planId: 'plan',
      title: 'test',
      aspectRatio: '16:9',
      sourceVersionIds: [],
      slides: [
        { slideId: 's1', order: 1, svg, metadata: { contentBlocks: blocks } },
        { slideId: 's2', order: 2, svg: '<svg/>' },
      ],
    } satisfies PresentationPlan;
  }
  it('preserves data and peers while moving the original shape and its native envelope', async () => {
    const plan = await fixture();
    const result = await applyObjectPositionPatch(plan, {
      target,
      objectPositionPatch: input,
      requestId: 'r',
      content: 'Move',
    });
    expect(result.plan.slides[1]).toBe(plan.slides[1]);
    expect(result.plan.slides[0].svg).toContain('data-pptx-bounds="140 120 400 180"');
    expect(result.plan.slides[0].metadata).toMatchObject({
      canvasPosition: { id: 'readings', x: 140, y: 120 },
      contentBlocks: [
        {
          rect: { ...rect, x: 140, y: 120 },
          spec: {
            series: [
              {
                points: [
                  [1, 2],
                  [2, 3],
                ],
              },
            ],
          },
        },
      ],
    });
  });
  it('rejects missing targets, collisions and off-page movement in document units', async () => {
    const { move } = canvasMoveForSlide(await fixture(), target, input);
    expect(() => moveCanvasObject({ ...move, id: 'unknown' })).toThrow();
    expect(() => moveCanvasObject({ ...move, x: 700 })).toThrow();
    expect(() =>
      moveCanvasObject({ ...move, objects: [...move.objects, { ...rect, id: 'peer' }] }),
    ).toThrow();
  });
});
