import { describe, expect, it } from 'vitest';

import {
  assertPresentationPublishable,
  inspectPresentationContent,
  promoteReadablePlainText,
} from './content-quality';

describe('presentation content quality', () => {
  it('rejects text that stays on the canvas but runs through its panel border', () => {
    const plan = {
      slides: [
        {
          slideId: 'slide-11',
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect x="474" y="84" width="442" height="424" fill="#fff"/><text x="488" y="116" font-size="24" font-weight="bold">全批量陷阱：海量样本下单步代价不可承受</text></svg>',
        },
      ],
    };
    expect(inspectPresentationContent(plan as never).issues).toEqual([
      expect.objectContaining({ category: 'geometry', slideId: 'slide-11' }),
    ]);
  });
  it('measures each explicitly positioned tspan against its panel', () => {
    const plan = {
      slides: [
        {
          slideId: 'slide-11',
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect x="474" y="84" width="442" height="424" fill="#fff"/><text x="488" y="116" font-size="24"><tspan x="494" dy="0">全批量陷阱：</tspan><tspan x="730" dy="28">海量样本下单步代价不可承受</tspan></text></svg>',
        },
      ],
    };
    expect(inspectPresentationContent(plan as never).issues).toEqual([
      expect.objectContaining({
        category: 'geometry',
        evidence: expect.stringContaining('Text run'),
      }),
    ]);
  });
  it('promotes a long undersized caption only when it still fits its panel', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect x="40" y="80" width="420" height="340"/><text x="60" y="120" font-size="16">GD / SGD / AdamW 权衡对比</text></svg>';
    const promoted = promoteReadablePlainText(svg);
    expect(promoted).toContain('font-size="24"');
    expect(
      inspectPresentationContent({ slides: [{ slideId: 'slide-11', svg: promoted }] } as never)
        .passed,
    ).toBe(true);
    const narrow = svg.replace('width="420"', 'width="110"');
    expect(promoteReadablePlainText(narrow)).toBe(narrow);
  });

  it('accepts a server-drawn annotation label at the label size', () => {
    const plan = {
      slides: [
        {
          slideId: 'slide-11',
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><g data-asset-annotations="hero"><text x="480" y="300" font-size="16" text-anchor="middle">支撑超平面 (Supporting Hyperplane)</text></g></svg>',
        },
      ],
    };
    expect(inspectPresentationContent(plan as never).passed).toBe(true);
  });

  it('still rejects text smaller than a label inside an annotation group', () => {
    const plan = {
      slides: [
        {
          slideId: 'slide-11',
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><g data-asset-annotations="hero"><text x="480" y="300" font-size="10" text-anchor="middle">支撑超平面 (Supporting Hyperplane)</text></g></svg>',
        },
      ],
    };
    expect(inspectPresentationContent(plan as never).issues).toEqual([
      expect.objectContaining({ category: 'legibility', slideId: 'slide-11' }),
    ]);
  });

  it('does not judge an annotation label against the panel it overlays', () => {
    const annotation =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect x="40" y="80" width="110" height="340"/><g data-asset-annotations="hero"><text x="60" y="200" font-size="16">支撑超平面 (Supporting Hyperplane)</text></g></svg>';
    expect(
      inspectPresentationContent({ slides: [{ slideId: 'slide-11', svg: annotation }] } as never)
        .issues,
    ).toEqual([]);
    // The same text outside an annotation group is still measured as author content.
    const authorText = annotation.replace('<g data-asset-annotations="hero">', '<g>');
    expect(
      inspectPresentationContent({ slides: [{ slideId: 'slide-11', svg: authorText }] } as never)
        .issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'geometry',
          evidence: expect.stringContaining('beyond its panel'),
        }),
      ]),
    );
  });
});

it('distinguishes an unavailable reviewer from a substantive failed review', () => {
  const plan = {
    planId: 'p',
    title: 'draft',
    aspectRatio: '16:9',
    slides: [],
    sourceVersionIds: [],
  };
  expect(() =>
    assertPresentationPublishable({
      ...plan,
      designSpec: {
        templateVisualReview: { finalReviewError: 'upstream timed out' },
      },
    }),
  ).toThrow(expect.objectContaining({ code: 'PRESENTATION_REVIEW_UNAVAILABLE' }));
  expect(() =>
    assertPresentationPublishable({
      ...plan,
      designSpec: {
        templateVisualReview: { final: { passed: false, issues: [{ severity: 'major' }] } },
      },
    }),
  ).toThrow(expect.objectContaining({ code: 'PRESENTATION_QUALITY_FAILED' }));
});
