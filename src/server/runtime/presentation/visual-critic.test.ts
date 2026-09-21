import sharp from 'sharp';
import { expect, it, vi } from 'vitest';

import { InMemoryPresentationArtifactStore } from './artifact-store';
import type { GLMMultimodalChatPort } from './multimodal-chat-provider-glm';
import type { TemplateApplication } from './templates';
import { compileTemplateDesignProgram } from './templates/design-program';
import { createPresentationVisualCritic } from './visual-critic';

const scope = { sessionId: 'session', userId: 'user' };
const family = {
  artwork: 'watercolor',
  composition: 'left title, right art',
  id: 'soft',
  name: 'Soft',
  pages: [1],
  palette: ['#88AACC'],
  preserve: ['open center'],
  typography: 'large title',
};
const designProgram = compileTemplateDesignProgram({
  components: [],
  families: [family],
  guidance: 'preserve open center',
  summary: 'soft deck',
});
const template: TemplateApplication = {
  constraints: {
    aspectRatio: '16:9',
    fontFamilies: [],
    fontSizes: [],
    palette: ['#88AACC'],
    spacing: { horizontalGaps: [], margins: { height: 0, width: 0, x: 0, y: 0 }, verticalGaps: [] },
  },
  layouts: [],
  name: 'Soft',
  templateId: 'template',
  versionId: 'version',
  visual: {
    analyzedAt: '2026-09-19T00:00:00.000Z',
    components: [],
    designProgram,
    families: [family],
    guidance: 'preserve open center',
    learning: { guidanceHistory: [], iteration: 1, questions: [], status: 'ready' },
    media: [],
    model: 'vision',
    pages: [{ height: 788, nativeTextCount: 0, page: 1, ref: 'template-page', width: 1400 }],
    schemaVersion: 3,
    summary: 'soft deck',
    templateId: 'template',
    versionId: 'version',
  },
};

it('reviews rendered slide pixels against owned template pixels and returns bounded corrections', async () => {
  const store = new InMemoryPresentationArtifactStore();
  const reference = await sharp({
    create: { background: '#88AACC', channels: 3, height: 90, width: 160 },
  })
    .jpeg()
    .toBuffer();
  await store.put(scope, {
    artifactId: 'template-page',
    bytes: reference,
    mimeType: 'image/jpeg',
    name: 'reference.jpg',
    type: 'image',
  });
  const review = {
    issues: [
      {
        category: 'spacing',
        evidence: 'The title touches the left edge while the reference keeps a broad margin.',
        instruction: 'Move the title right and keep the illustration anchor unchanged.',
        severity: 'major',
        slideId: 'slide-1',
      },
    ],
    passed: false,
    schemaVersion: 1,
    summary: 'The hierarchy is sound but the left margin is too tight.',
  };
  const chat: GLMMultimodalChatPort = {
    chat: vi.fn(async () => ({
      choices: [
        {
          index: 0,
          message: { content: JSON.stringify(review), role: 'assistant' as const },
        },
      ],
      created: 1,
      id: 'review',
      model: 'vision',
    })),
    manifest: {
      displayName: 'Vision',
      model: 'vision',
      providerId: 'vision',
      supportsIdempotency: true,
      supportsVision: true,
    },
    providerId: 'vision',
  };
  const result = await createPresentationVisualCritic({ chat, store }).review(
    {
      plan: {
        aspectRatio: '16:9',
        planId: 'plan',
        slides: [
          {
            order: 1,
            slideId: 'slide-1',
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="#fff"/><text x="2" y="80">Title</text></svg>',
          },
        ],
        sourceVersionIds: [],
        title: 'Deck',
      },
      template,
    },
    { scope },
  );
  expect(result).toEqual(review);
  const [, context] = vi.mocked(chat.chat).mock.calls[0];
  expect(context.trustedImages?.urls).toHaveLength(2);
  const message = vi.mocked(chat.chat).mock.calls[0][0].messages[1].content;
  expect(
    Array.isArray(message) && message.filter((part) => part.type === 'image_url'),
  ).toHaveLength(2);
});

it('projects verbose critic output onto the trusted review contract', async () => {
  const store = new InMemoryPresentationArtifactStore();
  const reference = await sharp({
    create: { background: '#88AACC', channels: 3, height: 90, width: 160 },
  })
    .jpeg()
    .toBuffer();
  await store.put(scope, {
    artifactId: 'template-page',
    bytes: reference,
    mimeType: 'image/jpeg',
    name: 'reference.jpg',
    type: 'image',
  });
  const chat: GLMMultimodalChatPort = {
    chat: vi.fn(async () => ({
      choices: [
        {
          index: 0,
          message: {
            content: JSON.stringify({
              commentary: 'not part of the contract',
              issues: [
                {
                  category: 'template_fidelity',
                  evidence: { observation: 'The illustration anchor drifted.' },
                  instruction: { repair: 'Restore the original right-hand anchor.' },
                  severity: 'high',
                  slideId: 'slide-1',
                  thought: 'discard me',
                },
              ],
              passed: false,
              schemaVersion: '1',
              summary: { verdict: 'One bounded repair is needed.' },
            }),
            role: 'assistant' as const,
          },
        },
      ],
      created: 1,
      id: 'review-normalized',
      model: 'vision',
    })),
    manifest: {
      displayName: 'Vision',
      model: 'vision',
      providerId: 'vision',
      supportsIdempotency: true,
      supportsVision: true,
    },
    providerId: 'vision',
  };
  const result = await createPresentationVisualCritic({ chat, store }).review(
    {
      plan: {
        aspectRatio: '16:9',
        planId: 'plan',
        slides: [
          {
            order: 1,
            slideId: 'slide-1',
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="#fff"/></svg>',
          },
        ],
        sourceVersionIds: [],
        title: 'Deck',
      },
      template,
    },
    { scope },
  );

  expect(result).toEqual({
    issues: [
      {
        category: 'template-fidelity',
        evidence: '{"observation":"The illustration anchor drifted."}',
        instruction: '{"repair":"Restore the original right-hand anchor."}',
        severity: 'major',
        slideId: 'slide-1',
      },
    ],
    passed: false,
    schemaVersion: 1,
    summary: '{"verdict":"One bounded repair is needed."}',
  });
});
