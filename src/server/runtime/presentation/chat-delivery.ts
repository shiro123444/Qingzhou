import type {
  ArtifactSnapshot,
  PresentationJob,
  PresentationJobInput,
} from '../../../../packages/runtime-contracts/src';

export const readChatOrigin = (input: PresentationJobInput): PresentationJob['chatOrigin'] => {
  const value = input?.options?.chatOrigin;
  if (!value || typeof value !== 'object') return;
  const { agentId, messageId, topicId } = value as Record<string, unknown>;
  if (
    typeof agentId === 'string' &&
    agentId &&
    typeof messageId === 'string' &&
    messageId &&
    typeof topicId === 'string' &&
    topicId
  )
    return { agentId, messageId, topicId };
};

export const deliveryFromArtifacts = (
  versionId: string,
  artifacts: readonly ArtifactSnapshot[],
) => ({
  coverId: artifacts.find(
    (artifact) =>
      artifact.status === 'ready' &&
      artifact.type === 'svg' &&
      Number(artifact.metadata?.slideNumber) === 1,
  )?.artifactId,
  pptxId: artifacts.find((artifact) => artifact.status === 'ready' && artifact.type === 'pptx')
    ?.artifactId,
  versionId,
});
