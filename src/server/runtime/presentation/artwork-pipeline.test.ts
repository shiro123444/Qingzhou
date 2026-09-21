import { describe, expect, it } from 'vitest';

import {
  lockArtworkPrompt,
  mapPool,
  presentationArtworkStyle,
  shouldAutoCutout,
} from './artwork-pipeline';
import type { TemplateVisualProfile } from './templates/visual-types';

const visual = {
  families: [
    {
      artwork: 'soft watercolor wash',
      composition: 'title left, artwork lower-right',
      id: 'wash',
      name: 'Wash',
      pages: [1],
      palette: ['#88AACC'],
      preserve: [],
      typography: 'serif',
    },
  ],
  pages: [{ height: 788, nativeTextCount: 0, page: 1, ref: 'template-page-1', width: 1400 }],
} as unknown as TemplateVisualProfile;

describe('presentation artwork pipeline', () => {
  it('locks generate calls to owned evidence pages and a new-subject prompt', () => {
    const style = presentationArtworkStyle(
      visual,
      {
        slides: [
          {
            assetBrief: 'a watercolor robot with a notebook',
            familyId: 'wash',
            slideId: 'cover',
          },
        ],
      },
      'cover',
    );
    expect(style.referenceAssetRefs).toEqual(['template-page-1']);
    expect(style.background).toBe('opaque');
    expect(style.promptPrefix).toContain('STYLE REFERENCE ONLY');
    expect(style.promptPrefix).toContain('#88AACC');
    expect(style.promptPrefix).toContain('watercolor robot');
    expect(lockArtworkPrompt(style.promptPrefix, 'draw the robot')).toContain('draw the robot');
  });

  it('cuts out only during art direction when processing is available', () => {
    expect(
      shouldAutoCutout({
        artDirection: true,
        hasProcessing: false,
        processAssetsAvailable: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoCutout({
        artDirection: false,
        hasProcessing: false,
        processAssetsAvailable: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoCutout({
        artDirection: true,
        hasProcessing: true,
        processAssetsAvailable: true,
      }),
    ).toBe(false);
  });

  it('overlaps independent slot work up to the concurrency limit', async () => {
    let live = 0;
    let peak = 0;
    const order: number[] = [];
    await mapPool([1, 2, 3, 4], 2, async (item) => {
      live += 1;
      peak = Math.max(peak, live);
      order.push(item);
      await Promise.resolve();
      live -= 1;
      return item;
    });
    expect(peak).toBe(2);
    expect(order).toHaveLength(4);
  });
});
