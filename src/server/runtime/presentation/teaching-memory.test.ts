// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LessonPlan } from '@/types/presentationLesson';
import type {
  TeachingPageObservation,
  TeachingPattern,
  TeachingRecord,
} from '@/types/presentationTeaching';
import { teachingSourceReferenceSchema } from '@/types/presentationTeaching';

import type { MultimodalChatPort } from './multimodal-chat-provider';
import { createPresentationOutlineCapability } from './outline-capability';
import { handleTeachingRequest } from './teaching-handler';
import {
  FileTeachingMemory,
  scanTeachingSequence,
  TeachingLearning,
  validateTeachingEvidence,
} from './teaching-memory';
import { FilePresentationTemplateLibrary } from './templates/library';

const scope = { userId: 'teacher', sessionId: 'session-1' };
const pages: TeachingPageObservation[] = [
  { page: 1, text: '实验现象：学习与遗忘', notes: '先让学生观察现象', cues: '', imageRefs: [] },
  { page: 2, text: '解释电路机制', notes: '接下来解释电路机制', cues: '', imageRefs: [] },
];
const source: TeachingRecord['source'] = {
  templateId: 'template',
  versionId: 'version-1',
  name: '测试',
  sha256: 'a'.repeat(64),
  pageCount: 2,
  analysis: 'ooxml-sequence-v1',
};
const pattern: TeachingPattern = {
  name: '现象到机制',
  observation: '两页依次出现现象与解释',
  inference: '可能支持从观察到解释，待教师确认',
  confidence: 'medium',
  applicability: '需要由实验现象建立机制解释时',
  prerequisites: '知道实验变量',
  teacherAction: '等待解释再展开',
  learnerAction: '提出机制假说',
  sequence: ['观察现象并描述', '提出可能机制并检验'],
  limitations: '不适用于尚未理解实验变量的学生',
  evidence: [
    { page: 1, field: 'text', quote: '实验现象：学习与遗忘' },
    { page: 2, field: 'notes', quote: '接下来解释电路机制' },
  ],
};
const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'teaching-memory-test-'));
  roots.push(root);
  const memory = new FileTeachingMemory(root);
  const [record] = await memory.propose(scope, source, [pattern], pages);
  return { root, memory, record };
}
const review = (record: TeachingRecord, course = '') => ({
  id: record.id,
  expectedRevision: record.revision,
  action: 'confirm' as const,
  course,
  applicability: '教师修订：比较两个解释时',
  limitations: '先检查变量理解，不强制采用',
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('conditional teaching memory', () => {
  it('keeps proposals out of search/compose and persists across sessions, not accounts', async () => {
    const { memory, record, root } = await setup();
    expect(await memory.search(scope, '')).toEqual([]);
    await expect(memory.compose(scope, { ids: [record.id] })).rejects.toThrow('unconfirmed');
    expect(await memory.load({ ...scope, userId: 'other' }, record.id)).toBeNull();
    const confirmed = await memory.review(scope, review(record));
    const resumed = new FileTeachingMemory(root);
    expect(
      (await resumed.compose({ ...scope, sessionId: 'new-session' }, { ids: [record.id] }))[0],
    ).toEqual(confirmed);
  });
  it('enforces course scopes, teacher revisions, optimistic review and revocation', async () => {
    const { memory, record } = await setup();
    const confirmed = await memory.review(scope, review(record, '认知科学'));
    expect(await memory.search(scope, '')).toEqual([]);
    expect(await memory.search(scope, '现象', '认知科学')).toHaveLength(1);
    await expect(memory.compose(scope, { ids: [record.id], course: '其他课' })).rejects.toThrow(
      'outside',
    );
    await expect(memory.review(scope, review(record))).rejects.toThrow('changed');
    const repeated = await memory.propose(scope, source, [pattern], pages);
    expect(repeated[0]).toEqual(confirmed);
    await memory.review(scope, { ...review(confirmed, '认知科学'), action: 'revoke' });
    await expect(memory.compose(scope, { ids: [record.id], course: '认知科学' })).rejects.toThrow(
      'revoked',
    );
    expect(await memory.search(scope, '', '认知科学')).toEqual([]);
  });
  it('rejects fabricated excerpts, single-page patterns and spoofed approval fields', async () => {
    const { memory } = await setup();
    expect(() =>
      validateTeachingEvidence(
        {
          ...pattern,
          evidence: [{ page: 1, field: 'notes', quote: '并不存在的指令' }, pattern.evidence[1]],
        },
        pages,
      ),
    ).toThrow('verbatim');
    expect(() =>
      validateTeachingEvidence(
        { ...pattern, evidence: [pattern.evidence[0], pattern.evidence[0]] },
        pages,
      ),
    ).toThrow('two pages');
    await expect(
      memory.propose(
        scope,
        source,
        [{ ...pattern, status: 'confirmed' } as TeachingPattern],
        pages,
      ),
    ).rejects.toThrow();
  });
  it('publishes one immutable decision per revision under concurrent reviews', async () => {
    const { memory, record, root } = await setup();
    const concurrent = new FileTeachingMemory(root);
    const results = await Promise.allSettled([
      memory.review(scope, review(record)),
      concurrent.review(scope, { ...review(record), action: 'revoke' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const latest = (await memory.load(scope, record.id))!;
    expect(latest.revision).toBe(1);
    expect(latest.history).toHaveLength(1);
    await memory.review(scope, { ...review(latest), action: 'revoke' });
    expect(
      (await concurrent.load(scope, record.id))?.history?.map((item) => item.revision),
    ).toEqual([1, 2]);
  });
  it('does not expose approval as an agent operation and guards the browser review boundary', async () => {
    const { memory, record, root } = await setup();
    const learning = new TeachingLearning(
      memory,
      new FilePresentationTemplateLibrary({ root }),
      {} as MultimodalChatPort,
    );
    expect(learning.operations().map((op) => op.name)).toEqual([
      'presentation.teaching.analyze',
      'presentation.teaching.search',
      'presentation.teaching.compose',
    ]);
    const body = JSON.stringify({ action: 'review', review: review(record) });
    const request = (origin?: string) =>
      new Request('https://example.test/api/runtime/presentation/teaching', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body,
      });
    expect((await handleTeachingRequest(request(), scope, learning, async () => true)).status).toBe(
      403,
    );
    expect(
      (await handleTeachingRequest(request('https://evil.test'), scope, learning, async () => true))
        .status,
    ).toBe(403);
    expect(
      (
        await handleTeachingRequest(
          request('https://example.test'),
          scope,
          learning,
          async () => false,
        )
      ).status,
    ).toBe(403);
    expect((await memory.load(scope, record.id))?.status).toBe('pending');
    expect(
      (
        await handleTeachingRequest(
          request('https://example.test'),
          scope,
          learning,
          async () => true,
        )
      ).status,
    ).toBe(200);
  });
  it('loads only server-confirmed patterns into planning and binds provenance itself', async () => {
    const { memory, record } = await setup();
    const confirmed = await memory.review(scope, review(record));
    const brief = {
      intention: '先观察再解释',
      audience: '本科生',
      priorKnowledge: '变量',
      learningGoal: '解释现象',
      durationMinutes: 5,
    };
    const plan: LessonPlan = {
      schemaVersion: 1,
      brief,
      beats: [
        {
          id: 'b',
          title: '现象',
          objective: '解释',
          durationMinutes: 5,
          locked: false,
          teacherCue: '教师提示',
          studentAction: '观察',
          checkForUnderstanding: '说明变量',
          frames: [
            {
              id: 'f',
              kind: 'question',
              title: '你观察到了什么',
              visibleContent: [],
              visualCue: '',
              withheldContent: [],
              boardSpace: 'none',
            },
          ],
        },
      ],
    };
    const chat = {
      manifest: { model: 'test' },
      chat: vi.fn(async () => ({
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(plan) } }],
        created: 0,
        id: 'r',
        model: 'test',
      })),
    } as unknown as MultimodalChatPort;
    const capability = createPresentationOutlineCapability({ chat, teachingMemory: memory });
    const result = await capability.execute(
      {
        operation: 'propose',
        brief: { topic: '认知', teacherBrief: brief },
        teachingSelection: { ids: [record.id], course: '' },
      },
      { scope },
    );
    expect(JSON.stringify(vi.mocked(chat.chat).mock.calls)).toContain('教师修订：');
    expect(result.lessonPlan?.teachingPatterns).toEqual([
      { id: record.id, revision: 1, name: pattern.name },
    ]);
    await memory.review(scope, { ...review(confirmed), action: 'revoke' });
    await expect(
      capability.execute(
        {
          operation: 'propose',
          brief: { topic: '认知', teacherBrief: brief },
          teachingSelection: { ids: [record.id], course: '' },
        },
        { scope },
      ),
    ).rejects.toThrow('revoked');
    expect(chat.chat).toHaveBeenCalledOnce();
  });
});

describe('OOXML sequential observations', () => {
  it('bounds teacher-selected consecutive windows and rejects malformed scopes', () => {
    expect(
      teachingSourceReferenceSchema.safeParse({ templateId: 't', window: { start: 42, end: 45 } })
        .success,
    ).toBe(true);
    for (const [start, end] of [
      [1, 1],
      [1, 8],
      [0, 2],
      [7, 3],
      [99, 101],
    ])
      expect(
        teachingSourceReferenceSchema.safeParse({ templateId: 't', window: { start, end } })
          .success,
      ).toBe(false);
  });
  it('uses presentation order and note relationships, not numeric filename order, and never infers duration', () => {
    const bytes = zipSync(
      Object.fromEntries(
        Object.entries({
          'ppt/presentation.xml':
            '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="r2"/><p:sldId r:id="r1"/></p:sldIdLst></p:presentation>',
          'ppt/_rels/presentation.xml.rels':
            '<Relationships><Relationship Id="r1" Target="slides/slide1.xml" Type="x/slide"/><Relationship Id="r2" Target="slides/slide2.xml" Type="x/slide"/></Relationships>',
          'ppt/slides/slide1.xml': '<p:sld xmlns:p="p"><p:cSld><p:spTree/></p:cSld></p:sld>',
          'ppt/slides/slide2.xml':
            '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>真正的第一页</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:timing><p:cTn id="1"/><p:animEffect filter="fade"/></p:timing></p:sld>',
          'ppt/slides/_rels/slide2.xml.rels':
            '<Relationships><Relationship Id="n" Target="../notesSlides/notesSlide9.xml" Type="x/notesSlide"/></Relationships>',
          'ppt/notesSlides/notesSlide9.xml':
            '<p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>先请学生解释</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
        }).map(([key, value]) => [key, strToU8(value)]),
      ),
    );
    const result = scanTeachingSequence(bytes);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('真正的第一页');
    expect(result[0].notes).toBe('先请学生解释');
    expect(result[0].cues).toContain('timing present true');
    expect(result[0].cues).toContain('not lecture duration');
    expect(result[1].notes).toBe('');
  });
});
