import type { ArtifactSnapshot } from '../../../../packages/runtime-contracts/src/index';
import type { PresentationSlotState } from '../store/presentationStore';

export const revealSrcsForSlide = (
  slide: ArtifactSnapshot | null | undefined,
  slots: PresentationSlotState[],
  resolveArtifactUri?: (artifactId: string) => string | undefined,
): string[] => {
  if (!slide) return [];
  const slideId =
    (typeof slide.metadata?.slideId === 'string' && slide.metadata.slideId) || slide.artifactId;
  return slots
    .filter(
      (slot) =>
        slot.slideId === slideId &&
        (slot.status === 'ready' || slot.status === 'generating') &&
        slot.artifactIds.length > 0,
    )
    .flatMap((slot) =>
      slot.artifactIds
        .map((artifactId) => resolveArtifactUri?.(artifactId))
        .filter((uri): uri is string => Boolean(uri)),
    )
    .slice(-4);
};
