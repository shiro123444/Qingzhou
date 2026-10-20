import { describe, expect, it } from 'vitest';

import type { ArtifactSnapshot } from '../../../packages/runtime-contracts/src/index';
import { currentSlideArtifacts } from './slideArtifacts';

const slide = (artifactId: string, slideNumber: number, updatedAt: string): ArtifactSnapshot => ({
  artifactId,
  createdAt: updatedAt,
  metadata: { slideId: `slide-${slideNumber}`, slideNumber },
  name: `${artifactId}.svg`,
  status: 'ready',
  type: 'svg',
  updatedAt,
});

describe('currentSlideArtifacts', () => {
  it('does not mix an old master with the first drafts of a new deck style', () => {
    const latest = slide('new-style-1', 1, '2026-10-15T08:30:00.000Z');
    latest.metadata = { ...latest.metadata, deckVisualSystemId: 'uniform-style' };
    expect(
      currentSlideArtifacts([
        slide('old-1', 1, '2026-10-15T08:00:00.000Z'),
        slide('old-2', 2, '2026-10-15T08:00:00.000Z'),
        latest,
      ]).map((a) => a.artifactId),
    ).toEqual(['new-style-1']);
  });
  it('replaces an old page with its latest streamed draft without duplicating navigation', () => {
    const result = currentSlideArtifacts([
      slide('old-1', 1, '2026-09-16T10:00:00.000Z'),
      slide('old-2', 2, '2026-09-16T10:00:00.000Z'),
      slide('draft-2', 2, '2026-09-16T10:01:00.000Z'),
      slide('old-3', 3, '2026-09-16T10:00:00.000Z'),
    ]);

    expect(result.map(({ artifactId }) => artifactId)).toEqual(['old-1', 'draft-2', 'old-3']);
  });
});
