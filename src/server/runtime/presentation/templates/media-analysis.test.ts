import { strToU8, zipSync } from 'fflate';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';

import { InMemoryPresentationArtifactStore } from '../artifact-store';
import type { GLMMultimodalChatPort } from '../multimodal-chat-provider-glm';
import { analyzeEmbeddedTemplateMedia, selectRepresentativeVideoFrames } from './media-analysis';

const scope = { sessionId: 'account', userId: 'designer' };
const chat: GLMMultimodalChatPort = {
  chat: vi.fn(),
  manifest: {
    displayName: 'Vision',
    model: 'vision-test',
    providerId: 'test',
    supportsIdempotency: true,
    supportsVision: true,
  },
  providerId: 'test',
};

it('keeps an undecodable embedded video and asks instead of guessing or deleting it', async () => {
  const source = strToU8('not-a-video');
  const result = await analyzeEmbeddedTemplateMedia({
    bytes: zipSync({ 'ppt/media/lesson.mp4': source }),
    chat,
    media: [
      {
        kind: 'video',
        mediaId: 'slide-1:video:1',
        mimeType: 'video/mp4',
        page: 1,
        path: 'ppt/media/lesson.mp4',
        relationshipId: 'rVideo',
        sizeBytes: source.byteLength,
      },
    ],
    scope,
    store: new InMemoryPresentationArtifactStore(),
    templateVersionId: 'version-1',
  });
  expect(result).toEqual([
    expect.objectContaining({
      confidence: 0,
      frameRefs: [],
      preserveRecommendation: 'preserve',
      status: 'unavailable',
    }),
  ]);
  expect(result[0].questions[0]).toMatchObject({ mediaId: 'slide-1:video:1', page: 1 });
  expect(chat.chat).not.toHaveBeenCalled();
});

it('records embedded audio as metadata and requires an explicit semantic decision', async () => {
  const result = await analyzeEmbeddedTemplateMedia({
    bytes: zipSync({ 'ppt/media/narration.mp3': strToU8('audio') }),
    chat,
    media: [
      {
        kind: 'audio',
        mediaId: 'slide-2:audio:1',
        mimeType: 'audio/mpeg',
        page: 2,
        path: 'ppt/media/narration.mp3',
        relationshipId: 'rAudio',
        sizeBytes: 5,
      },
    ],
    scope,
    store: new InMemoryPresentationArtifactStore(),
    templateVersionId: 'version-1',
  });
  expect(result[0]).toMatchObject({
    kind: 'audio',
    preserveRecommendation: 'preserve',
    status: 'metadata-only',
  });
  expect(result[0].questions[0].question).toContain('音频');
  expect(result[0].questions[0]).toMatchObject({ recommendedChoiceId: 'transcribe' });
  expect(result[0].questions[0].choices.map((choice) => choice.id)).toContain('transcribe');
  expect(chat.chat).not.toHaveBeenCalled();
});

it('transcribes embedded audio only after the exact media id is explicitly selected', async () => {
  const source = strToU8('owned-audio');
  const media = {
    kind: 'audio' as const,
    mediaId: 'slide-2:audio:1',
    mimeType: 'audio/mpeg',
    page: 2,
    path: 'ppt/media/narration.mp3',
    relationshipId: 'rAudio',
    sizeBytes: source.byteLength,
  };
  const initial = await analyzeEmbeddedTemplateMedia({
    bytes: zipSync({ [media.path]: source }),
    chat,
    media: [media],
    scope,
    store: new InMemoryPresentationArtifactStore(),
    templateVersionId: 'version-1',
  });
  const transcribe = vi.fn(async () => ({ language: 'zh', text: '课程核心旁白' }));
  const audioNormalizer = vi.fn(async () => ({
    bytes: new Uint8Array([9, 8, 7]),
    mimeType: 'audio/mpeg',
    name: 'speech.mp3',
  }));
  const learned = await analyzeEmbeddedTemplateMedia({
    audioNormalizer,
    audioTranscriber: transcribe,
    bytes: zipSync({ [media.path]: source }),
    chat,
    existing: initial,
    media: [media],
    scope,
    store: new InMemoryPresentationArtifactStore(),
    templateVersionId: 'version-1',
    transcribeMediaIds: [media.mediaId],
  });
  expect(audioNormalizer).toHaveBeenCalledOnce();
  expect(transcribe).toHaveBeenCalledWith(
    expect.objectContaining({
      bytes: new Uint8Array([9, 8, 7]),
      mimeType: 'audio/mpeg',
      scope,
    }),
  );
  expect(learned[0]).toMatchObject({
    status: 'analyzed',
    transcript: '课程核心旁白',
    transcriptLanguage: 'zh',
    transcriptStatus: 'ready',
  });
  expect(learned[0].questions).toEqual([]);
});

it('keeps boundaries and selects a visually distinct scene frame', async () => {
  const image = (background: string) =>
    sharp({ create: { background, channels: 3, height: 90, width: 160 } })
      .jpeg()
      .toBuffer();
  const frames = await Promise.all([
    image('#ff0000'),
    image('#f00000'),
    image('#0000ff'),
    image('#00f000'),
    image('#00ff00'),
  ]);
  const selected = await selectRepresentativeVideoFrames(frames, 3);
  expect(selected).toHaveLength(3);
  expect(selected[0]).toEqual(new Uint8Array(frames[0]));
  expect(selected[1]).toEqual(new Uint8Array(frames[2]));
  expect(selected[2]).toEqual(new Uint8Array(frames[4]));
});
