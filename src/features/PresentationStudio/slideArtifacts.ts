import type { ArtifactSnapshot } from '../../../packages/runtime-contracts/src/index';

const slideKey = (artifact: ArtifactSnapshot): string => {
  const slideNumber = Number(artifact.metadata?.slideNumber);
  if (Number.isInteger(slideNumber) && slideNumber > 0) return `page:${slideNumber}`;
  const slideId = artifact.metadata?.slideId;
  return typeof slideId === 'string' && slideId ? `slide:${slideId}` : artifact.artifactId;
};

const artifactTime = (artifact: ArtifactSnapshot): string =>
  artifact.updatedAt || artifact.createdAt || '';

/** Keep one visible artifact per logical page while a new revision streams in. */
export const currentSlideArtifacts = (artifacts: ArtifactSnapshot[]): ArtifactSnapshot[] => {
  const byPage = new Map<string, ArtifactSnapshot>();

  for (const artifact of artifacts) {
    if (
      artifact.status !== 'ready' ||
      (artifact.type !== 'svg' && artifact.metadata?.artifactRole !== 'slide')
    ) {
      continue;
    }

    const key = slideKey(artifact);
    const existing = byPage.get(key);
    if (!existing || artifactTime(artifact) >= artifactTime(existing)) byPage.set(key, artifact);
  }

  return [...byPage.values()].sort(
    (a, b) => Number(a.metadata?.slideNumber ?? 0) - Number(b.metadata?.slideNumber ?? 0),
  );
};
