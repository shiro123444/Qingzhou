import { describe, expect, it, vi } from 'vitest';

import { contentInputFingerprint } from './content-intent';
import { createPresentationContextRuntime } from './context-tools';
import { createPresentationConversationCapability } from './conversation-capability';
import {
  createMaterialDocument,
  mergePresentationMaterials,
  rehydratePresentationMaterials,
} from './material-document';
import type { MultimodalChatPort } from './multimodal-chat-provider';
import { createPresentationOutlineCapability } from './outline-capability';

const scope = { userId: 'alice', sessionId: 'account' };
const response = (value: unknown) => ({
  choices: [{ index: 0, message: { content: JSON.stringify(value), role: 'assistant' as const } }],
  created: 1,
  id: 'test',
  model: 'test',
});
const chatPort = (...values: unknown[]): MultimodalChatPort => {
  const chat = vi.fn();
  values.forEach((value) => chat.mockResolvedValueOnce(response(value)));
  return {
    chat,
    manifest: {
      displayName: 'Test',
      model: 'test',
      providerId: 'test',
      supportsVision: true,
      supportsIdempotency: true,
    },
    providerId: 'test',
  };
};
const op = (operation: string, input: unknown = {}) => ({ operation, input });

describe('materials to storyboard to generation', () => {
  it('requires multiple selected sources to be read, binds real segments and carries evidence outside compressed receipts', async () => {
    const a = createMaterialDocument({
      sourceId: 'a',
      name: 'teaching.txt',
      content: '计划12门课程，尚未验收。',
    });
    const b = createMaterialDocument({
      sourceId: 'b',
      name: 'research.pdf',
      content: '',
      pages: [{ pageContent: '预算37万元，实际支出未知。', metadata: { pageNumber: 7 } }],
    });
    const runtime = createPresentationContextRuntime({
      documents: {
        load: async (id) => (id === 'a' ? a : b),
        loadPdf: vi.fn(),
        save: vi.fn(),
      },
      readFile: vi.fn(),
      readSkill: vi.fn(),
      listSkills: async () => [],
      search: vi.fn(),
    });
    const refs = [a, b].map((document) => ({
      sourceId: document.manifest.sourceId,
      segmentId: document.segments[0].id,
    }));
    const chat = chatPort(
      op('planning.update', { topic: '教学科研计划' }),
      op('context.document.inspect', { id: 'a' }),
      op('context.document.read', { id: 'a', segmentIds: [a.segments[0].id] }),
      op('planning.outline'),
      op('context.document.read', { id: 'b', segmentIds: [b.segments[0].id] }),
      op('planning.outline'),
      {
        slides: [
          {
            id: 'slide-1',
            title: '计划与预算',
            keyPoints: ['计划12门课程', '预算37万元'],
            sourceRefs: refs,
          },
        ],
      },
      { phase: 'outline', message: '分镜已完成' },
    );
    try {
      const result = await createPresentationConversationCapability({ chat }).execute(
        {
          operation: 'turn',
          threadId: 't',
          messages: [{ role: 'user', content: '根据两份资料制作分镜' }],
          references: [
            { id: 'a', kind: 'text', name: 'teaching.txt', status: 'ready' },
            { id: 'b', kind: 'pdf', name: 'research.pdf', status: 'ready' },
          ],
          tools: { search: false, skillIds: [] },
        },
        { scope, tools: runtime },
      );
      expect(result.slides?.[0].sourceRefs).toEqual(refs);
      expect(result.slides?.[0].speakerNotes).toContain('research.pdf · 第7页');
      expect(result.brief.materials?.segments.map((segment) => segment.text)).toEqual([
        a.segments[0].text,
        b.segments[0].text,
      ]);
      expect(
        result.execution
          ?.filter((event) => event.operation === 'planning.outline')
          .map((event) => event.state),
      ).toEqual(['failed', 'completed']);
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects model invented source references even after one repair', async () => {
    const document = createMaterialDocument({
      sourceId: 'a',
      name: 'a.txt',
      content: '计划12门课程',
    });
    const materials = mergePresentationMaterials(undefined, {
      document: document.manifest,
      segments: document.segments,
    });
    const bad = {
      slides: [
        {
          title: '课程',
          keyPoints: ['12门'],
          sourceRefs: [{ sourceId: 'a', segmentId: 'invented' }],
        },
      ],
    };
    await expect(
      createPresentationOutlineCapability({ chat: chatPort(bad, bad) }).execute(
        { brief: { topic: '课程', materials }, operation: 'propose' },
        { scope },
      ),
    ).rejects.toThrow('未读取');
  });

  it('rehydrates actual owned text on resume and refuses stale or unowned sources', async () => {
    const document = createMaterialDocument({
      sourceId: 'a',
      name: 'a.txt',
      content: '预算37万元',
    });
    const materials = mergePresentationMaterials(undefined, {
      document: document.manifest,
      segments: document.segments,
    })!;
    const forged = {
      ...materials,
      segments: [{ ...materials.segments[0], text: '已支出100万元' }],
    };
    expect(
      (await rehydratePresentationMaterials(forged, async () => document)).segments[0].text,
    ).toBe('预算37万元');
    await expect(
      rehydratePresentationMaterials(forged, async () => {
        throw new Error('不属于当前账号');
      }),
    ).rejects.toThrow('不属于');
    await expect(
      rehydratePresentationMaterials(
        { ...materials, documents: [{ ...document.manifest, fingerprint: 'f'.repeat(64) }] },
        async () => document,
      ),
    ).rejects.toThrow('版本已变化');
  });

  it('invalidates generated content when materials change while title and outline stay fixed', () => {
    const input = {
      notebookId: 'n',
      title: '报告',
      sourceVersionIds: [],
      options: { materials: { text: '预算37万元' } },
    };
    expect(contentInputFingerprint(input)).not.toBe(
      contentInputFingerprint({ ...input, options: { materials: { text: '预算38万元' } } }),
    );
  });
});
