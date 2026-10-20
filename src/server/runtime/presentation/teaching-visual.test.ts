// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { strToU8, zipSync } from 'fflate';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type TeachingPattern,
  teachingPatternSchema,
  teachingSourceReferenceSchema,
} from '@/types/presentationTeaching';

import { presentationAccountScope } from './account-workspace';
import { InMemoryPresentationArtifactStore } from './artifact-store';
import type { MultimodalChatPort } from './multimodal-chat-provider';
import { FileTeachingMemory, scanTeachingSequence, TeachingLearning } from './teaching-memory';
import { captureTeachingPages, validateTeachingVisualComparisons } from './teaching-visual';
import { FilePresentationTemplateLibrary } from './templates/library';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const scope = { userId: 'teacher', sessionId: 'first-session' };
const bitmap = () =>
  sharp({ create: { width: 320, height: 180, channels: 3, background: '#345678' } })
    .png()
    .toBuffer();
const pages = [1, 2].map((page) => ({
  page,
  text: '观察实验结果',
  notes: '解释系统机制',
  cues: `Page ${page}`,
  imageRefs: [],
}));
const pattern: TeachingPattern = {
  name: '先观察后解释',
  observation: '模型不应作为已核实的观察',
  inference: '可能支持比较，待教师确认',
  confidence: 'medium',
  applicability: '需要比较时',
  prerequisites: '已知变量',
  teacherAction: '等待回应',
  learnerAction: '提出预测',
  sequence: ['观察', '解释'],
  limitations: '不能由静态图判断动画',
  evidence: [
    { page: 1, field: 'text', quote: '观察实验结果' },
    { page: 2, field: 'text', quote: '观察实验结果' },
  ],
  visualComparisons: [
    {
      fromPage: 1,
      toPage: 2,
      kind: 'focus-shift',
      visibleChange: '待核对：右侧区域改变',
      alternativeExplanation: '可能只是主题格式',
      uncertainty: '不能验证点击顺序',
      regions: [1, 2].map((page) => ({
        page,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
        description: '右侧图',
      })),
    },
  ],
};
const fixture = () =>
  zipSync(
    Object.fromEntries(
      Object.entries({
        'ppt/presentation.xml':
          '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="r1"/><p:sldId r:id="r2"/></p:sldIdLst></p:presentation>',
        'ppt/_rels/presentation.xml.rels':
          '<Relationships><Relationship Id="r1" Target="slides/slide1.xml" Type="x/slide"/><Relationship Id="r2" Target="slides/slide2.xml" Type="x/slide"/></Relationships>',
        ...Object.fromEntries(
          [1, 2].map((page) => [
            `ppt/slides/slide${page}.xml`,
            '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>观察实验结果</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:timing><p:cTn id="5" nodeType="clickEffect" presetClass="entr"><p:childTnLst><p:animEffect filter="fade"><p:spTgt spid="7"/></p:animEffect></p:childTnLst></p:cTn></p:timing></p:sld>',
          ]),
        ),
      }).map(([key, value]) => [key, strToU8(value)]),
    ),
  );

describe('teacher visual evidence boundary', () => {
  it('requires explicit bounded page selection and rejects conflicting or forged inputs', () => {
    expect(teachingSourceReferenceSchema.safeParse({ templateId: 't', visual: true }).success).toBe(
      false,
    );
    expect(
      teachingSourceReferenceSchema.safeParse({ templateId: 't', pages: [1, 2] }).success,
    ).toBe(false);
    for (const ref of [
      { pages: [1, 1] },
      { pages: [1, 2], window: { start: 1, end: 2 } },
      { pages: [1, 2], imageUrl: 'https://evil.test' },
    ])
      expect(
        teachingSourceReferenceSchema.safeParse({ templateId: 't', visual: true, ...ref }).success,
      ).toBe(false);
    expect(
      teachingSourceReferenceSchema.safeParse({
        templateId: 't',
        visual: true,
        pages: [36, 37, 49, 56],
      }).success,
    ).toBe(true);
  });
  it('persists exact scoped snapshots, sorts by source order, and reuses identical evidence', async () => {
    const bytes = await bitmap();
    const store = new InMemoryPresentationArtifactStore();
    const renderer = vi.fn(async () => [
      { page: 2, bytes },
      { page: 1, bytes },
    ]);
    const input = { bytes: new Uint8Array([1]), sourceHash: 'a'.repeat(64), pages };
    const first = await captureTeachingPages({ store, renderer }, input, scope);
    const second = await captureTeachingPages({ store, renderer }, input, {
      ...scope,
      sessionId: 'new-session',
    });
    expect(first.snapshots).toEqual(second.snapshots);
    expect(first.snapshots.map((page) => page.page)).toEqual([1, 2]);
    expect(first.trustedImages.urls).toHaveLength(2);
    expect(first.trustedImages.urls[0]).toMatch(/^data:image\/jpeg;base64,/u);
    expect(
      (await store.get(presentationAccountScope(scope.userId), first.snapshots[0].ref))?.bytes,
    ).toBeDefined();
    await expect(
      store.get(presentationAccountScope('other'), first.snapshots[0].ref),
    ).rejects.toThrow('another scope');
    expect(JSON.stringify(first.snapshots)).not.toContain('base64');
  });
  it('fails closed on missing, duplicate or unrequested rendered pages and cancellation', async () => {
    const bytes = await bitmap();
    for (const result of [
      [{ page: 1, bytes }],
      [
        { page: 1, bytes },
        { page: 1, bytes },
      ],
      [
        { page: 1, bytes },
        { page: 3, bytes },
      ],
    ]) {
      await expect(
        captureTeachingPages(
          { store: new InMemoryPresentationArtifactStore(), renderer: async () => result },
          { bytes, sourceHash: 'a', pages },
          scope,
        ),
      ).rejects.toThrow('exactly once');
    }
    const renderer = vi.fn(async () => []);
    await expect(
      captureTeachingPages(
        { store: new InMemoryPresentationArtifactStore(), renderer },
        { bytes, sourceHash: 'a', pages },
        scope,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(renderer).not.toHaveBeenCalled();
  });
  it('never accepts a visual claim without captured pages, paired regions or valid bounds', async () => {
    expect(() => validateTeachingVisualComparisons(pattern)).toThrow('server-rendered');
    const bytes = await bitmap();
    const { snapshots } = await captureTeachingPages(
      {
        store: new InMemoryPresentationArtifactStore(),
        renderer: async () => pages.map(({ page }) => ({ page, bytes })),
      },
      { bytes, sourceHash: 'a', pages },
      scope,
    );
    expect(() => validateTeachingVisualComparisons(pattern, snapshots)).not.toThrow();
    expect(() =>
      validateTeachingVisualComparisons({ ...pattern, visualComparisons: undefined }, snapshots),
    ).toThrow('localized');
    const unseen = structuredClone(pattern);
    unseen.visualComparisons![0].toPage = 3;
    expect(() => validateTeachingVisualComparisons(unseen, snapshots)).toThrow('unseen');
    const missing = structuredClone(pattern);
    missing.visualComparisons![0].regions.pop();
    expect(() => validateTeachingVisualComparisons(missing, snapshots)).toThrow('both');
    const badBox = structuredClone(pattern);
    badBox.visualComparisons![0].regions[0].x = 0.9;
    expect(teachingPatternSchema.safeParse(badBox).success).toBe(false);
  });
  it('extracts build structure but never certifies playback or duration', () => {
    const result = scanTeachingSequence(fixture());
    expect(result[0].builds).toEqual([
      { id: '5', nodeType: 'clickEffect', presetClass: 'entr', targets: ['7'], effects: ['fade'] },
    ]);
    expect(result[0].cues).toContain('not lecture duration');
  });
  it('passes actual images to the model and saves pending, provenance-bound comparisons', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teaching-visual-'));
    roots.push(root);
    const library = new FilePresentationTemplateLibrary({ root: path.join(root, 'templates') });
    const template = await library.importPptx(scope, {
      bytes: fixture(),
      name: 'Teaching fixture',
    });
    const bytes = await bitmap();
    const chat = {
      manifest: { model: 'test', supportsVision: true },
      chat: vi.fn(async () => ({
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify({ patterns: [pattern] }) },
          },
        ],
        created: 0,
        id: 'r',
        model: 'test',
      })),
    } as unknown as MultimodalChatPort;
    const memory = new FileTeachingMemory(path.join(root, 'memory'));
    const learning = new TeachingLearning(memory, library, chat, {
      store: new InMemoryPresentationArtifactStore(),
      renderer: async () => pages.map(({ page }) => ({ page, bytes })),
    });
    const records = await learning.analyze(scope, {
      templateId: template.templateId,
      visual: true,
      pages: [2, 1],
    });
    expect(records[0].status).toBe('pending');
    expect(records[0].source.analysis).toBe('native-static-sequence-v1');
    expect(records[0].source.visualPages?.map((page) => page.page)).toEqual([1, 2]);
    expect(records[0].pattern.observation).not.toContain('模型不应');
    expect(vi.mocked(chat.chat).mock.calls[0][1].trustedImages?.urls).toHaveLength(2);
    expect(JSON.stringify(vi.mocked(chat.chat).mock.calls[0][0])).toContain(
      'data:image/jpeg;base64',
    );
    expect(await memory.search(scope, '')).toEqual([]);
    await expect(
      new TeachingLearning(memory, library, chat).analyze(scope, {
        templateId: template.templateId,
        visual: true,
        pages: [1, 2],
      }),
    ).rejects.toThrow('no text-only fallback');
    await expect(
      learning.analyze(
        { ...scope, userId: 'other' },
        { templateId: template.templateId, visual: true, pages: [1, 2] },
      ),
    ).rejects.toThrow('Owned source');
  });
});
