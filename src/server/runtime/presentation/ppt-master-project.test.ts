import { describe, expect, it } from 'vitest';

import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import { pptMasterProjectLock } from './ppt-master-project';

describe('PPT Master export theme', () => {
  it('keeps frequent diagram captions separate from body text and preserves quoted font families', () => {
    const plan: PresentationPlan = {
      planId: 'diagram-deck',
      title: 'Channel workflow',
      aspectRatio: '16:9',
      sourceVersionIds: [],
      designSpec: {},
      slides: [
        {
          slideId: 'workflow',
          order: 0,
          svg: `<svg viewBox="0 0 960 540"><rect fill="#FFFFFF"/>
          <text font-family="'Microsoft YaHei', Arial" font-size="36" fill="#111111">Title</text>
          <text font-size="24">Body</text>
          <text font-size="16">Receive</text><text font-size="16">Invoke</text>
          <text font-size="16">Export</text><text font-size="16">Deliver</text></svg>`,
        },
      ],
    };
    const lock = pptMasterProjectLock(plan);
    expect(lock).toContain("- font_family: 'Microsoft YaHei', Arial");
    expect(lock).toContain('- title: 36');
    expect(lock).toContain('- body: 24');
    expect(lock).toContain('- caption: 16');
    expect(lock).toContain('- viewBox: 0 0 960 540');
  });
});
