import { describe, expect, it } from 'vitest';

import type { PresentationJobInput } from '../../../../packages/runtime-contracts/src';
import type { SlideContentIntent, VisualRequirement } from './content-intent';
import {
  applyRasterBudget,
  createRasterAllowance,
  isNativeVisual,
  isRasterVisual,
  rasterBudgetInstruction,
} from './raster-budget';

const visual = (
  id: string,
  kind: VisualRequirement['kind'],
  renderer?: VisualRequirement['renderer'],
): VisualRequirement => ({
  brief: `${kind} brief`,
  id,
  kind,
  required: true,
  ...(renderer ? { renderer } : {}),
});

const slide = (slideId: string, visuals: VisualRequirement[]): SlideContentIntent => ({
  claim: `claim ${slideId}`,
  formulas: [],
  slideId,
  visualKind: visuals[0]?.kind ?? 'none',
  visualReason: `reason ${slideId}`,
  visuals,
});

const input = (options: Record<string, unknown> = {}): PresentationJobInput =>
  ({
    notebookId: 'n',
    options,
    slideCount: 4,
    sourceVersionIds: [],
    title: 'Budget',
  }) as PresentationJobInput;

describe('raster visual classification', () => {
  it('treats image-rendered and always-raster kinds as budgeted, source figures as reuse', () => {
    expect(isRasterVisual(visual('v', 'scientific-diagram', 'image'))).toBe(true);
    expect(isRasterVisual(visual('v', 'illustration'))).toBe(true);
    expect(isRasterVisual(visual('v', 'scientific-diagram', 'native'))).toBe(false);
    expect(isRasterVisual(visual('v', 'chart'))).toBe(false);
    expect(isRasterVisual(visual('v', 'source-figure'))).toBe(false);
    expect(isRasterVisual(visual('v', 'sticker'))).toBe(true);
    expect(isNativeVisual(visual('v', 'chart', 'native'))).toBe(true);
    expect(isNativeVisual(visual('v', 'illustration', 'image'))).toBe(false);
  });
});

describe('deck image budget', () => {
  it('turns raster pages beyond the budget into structured vectors', () => {
    const allowance = createRasterAllowance(1);
    const { demotions, slides } = applyRasterBudget(
      [
        slide('slide-1', [visual('visual-1', 'scientific-diagram', 'image')]),
        slide('slide-2', [visual('visual-1', 'chart', 'image')]),
      ],
      allowance,
      input(),
    );
    expect(slides[0].visuals?.[0]).toMatchObject({ renderer: 'image' });
    expect(slides[1].visuals?.[0]).toMatchObject({ kind: 'chart', renderer: 'native' });
    expect(demotions).toEqual([
      { reason: 'native-fallback', slideId: 'slide-2', visualId: 'visual-1' },
    ]);
    expect(allowance.used).toBe(1);
  });

  it('drops a photographic page to typography when no vector form exists', () => {
    const { demotions, slides } = applyRasterBudget(
      [
        slide('slide-1', [visual('visual-1', 'photograph', 'image')]),
        slide('slide-2', [visual('visual-1', 'photograph', 'image')]),
      ],
      createRasterAllowance(1),
      input(),
    );
    expect(slides[0].visuals).toHaveLength(1);
    expect(slides[1].visuals).toEqual([]);
    expect(slides[1].visualKind).toBe('none');
    expect(slides[1].visualReason).toBe(
      'reason slide-2（生图额度已优先留给更需要真实素材的页面，本页改为纯文字排版）',
    );
    expect(demotions).toEqual([
      { reason: 'typographic-fallback', slideId: 'slide-2', visualId: 'visual-1' },
    ]);
  });

  it('never demotes an explicitly requested slot, even past the budget', () => {
    const { slides } = applyRasterBudget(
      [
        slide('slide-1', [visual('visual-1', 'photograph', 'image')]),
        slide('slide-2', [visual('slot-9', 'photograph', 'image')]),
      ],
      createRasterAllowance(1),
      input({ imageSlots: [{ slideId: 'slide-2', slotId: 'slot-9', prompt: 'real photo' }] }),
    );
    expect(slides[1].visuals?.[0]).toMatchObject({ id: 'slot-9', renderer: 'image' });
    expect(slides[0].visuals).toEqual([]);
  });

  it('shares one allowance across separately compiled lesson stages', () => {
    const allowance = createRasterAllowance(2);
    const stage = (slideId: string) =>
      applyRasterBudget(
        [slide(slideId, [visual('visual-1', 'scientific-diagram', 'image')])],
        allowance,
        input(),
      ).slides[0];
    expect(stage('slide-1').visuals?.[0]).toMatchObject({ renderer: 'image' });
    expect(stage('slide-2').visuals?.[0]).toMatchObject({ renderer: 'image' });
    expect(stage('slide-3').visuals?.[0]).toMatchObject({ renderer: 'native' });
    expect(allowance.used).toBe(2);
  });

  it('tells the model the remaining allowance before it plans', () => {
    expect(rasterBudgetInstruction(createRasterAllowance(8))).toContain('剩余额度 8');
    const spent = createRasterAllowance(1);
    spent.used += 1;
    expect(rasterBudgetInstruction(spent)).toContain('不得使用 renderer:image');
  });
});
