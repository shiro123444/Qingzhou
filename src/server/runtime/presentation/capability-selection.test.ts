import { describe, expect, it, vi } from 'vitest';

import type { CapabilityCapsule } from './capability-memory';
import { createPresentationCapabilitySelector } from './capability-selection';
import type { MultimodalChatPort } from './multimodal-chat-provider';

const capsule = (id: string, kind: CapabilityCapsule['kind']): CapabilityCapsule => ({
  id,
  kind,
  name: id,
  schemaVersion: 1,
  createdAt: '2026-10-15',
  palette: [],
  rules: [],
  triggers: [],
  source: { evidencePages: [] },
});
const candidates = [
  capsule('style-a', 'style'),
  capsule('style-b', 'style'),
  capsule('layout-c', 'layout'),
  capsule('recipe-d', 'render-recipe'),
];
const scope = { userId: 'user', sessionId: 'session' };
const input = {
  title: '商务汇报',
  prompt: '两大板块均衡汇报',
  slideCount: 18,
  aspectRatio: '16:9' as const,
  language: 'zh-CN',
  notebookId: 'notebook',
  sourceVersionIds: [],
};
const port = (ids: string[]): MultimodalChatPort => ({
  providerId: 'test',
  manifest: {
    providerId: 'test',
    model: 'test',
    displayName: 'Test',
    supportsVision: false,
    supportsIdempotency: true,
  },
  chat: vi.fn(async () => ({
    id: 'selection',
    created: 0,
    model: 'test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant' as const,
          content: JSON.stringify({ ids, rationale: '选择适合当前汇报的设计能力' }),
        },
      },
    ],
  })),
});

describe('PPT capability selection recovery', () => {
  it('keeps the preferred style and methods from other templates without aborting generation', async () => {
    const chat = port(['style-b', 'layout-c', 'style-a', 'recipe-d']);
    expect(
      await createPresentationCapabilitySelector(chat).select(input, candidates, { scope }),
    ).toEqual(['style-b', 'layout-c', 'recipe-d']);
    expect(chat.chat).toHaveBeenCalledTimes(1);
  });
  it('still rejects capabilities outside the offered owned candidates', async () => {
    await expect(
      createPresentationCapabilitySelector(port(['unknown'])).select(input, candidates, { scope }),
    ).rejects.toThrow('offered owned candidates');
  });
  it('allows layout and rendering composition without a historical primary style', async () => {
    expect(
      await createPresentationCapabilitySelector(port(['layout-c', 'recipe-d'])).select(
        input,
        candidates,
        { scope },
      ),
    ).toEqual(['layout-c', 'recipe-d']);
  });
});
