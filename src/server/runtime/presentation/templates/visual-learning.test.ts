import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';

import { InMemoryPresentationArtifactStore } from '../artifact-store';
import type { GLMMultimodalChatPort } from '../multimodal-chat-provider-glm';
import { FilePresentationTemplateLibrary } from './library';
import type { TemplateMediaAnalyzer } from './media-analysis';
import { TemplateVisualLearning } from './visual-learning';
import type { TemplateLearningQuestion } from './visual-types';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const scope = { userId: 'designer', sessionId: 'account' };
const fixture = (count = 1) => {
  const entries: Record<string, string> = {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${Array.from({ length: count }, (_, index) => `<p:sldId id="${256 + index}" r:id="r${index + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships>${Array.from({ length: count }, (_, index) => `<Relationship Id="r${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>`,
  };
  for (let index = 1; index <= count; index++) {
    entries[`ppt/slides/slide${index}.xml`] =
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>';
  }
  return zipSync(
    Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, strToU8(value)])),
  );
};

const videoFixture = () => {
  const files = unzipSync(fixture());
  files['ppt/slides/slide1.xml'] = strToU8(
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:pic><p:nvPicPr><p:cNvPr id="2" name="Video"/><p:nvPr><a:videoFile r:link="video1"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="poster1"/></p:blipFill><p:spPr><a:xfrm><a:off x="914400" y="514350"/><a:ext cx="7315200" cy="4114800"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld></p:sld>',
  );
  files['ppt/slides/_rels/slide1.xml.rels'] = strToU8(
    '<Relationships><Relationship Id="video1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/video1.mp4"/><Relationship Id="poster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/poster.png"/></Relationships>',
  );
  files['ppt/media/video1.mp4'] = strToU8('video');
  files['ppt/media/poster.png'] = strToU8('poster');
  expect(strFromU8(files['ppt/slides/slide1.xml'])).toContain('videoFile');
  return zipSync(files);
};

it('looks at native page pixels, caches by owned version, and refuses to reuse baked text', async () => {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'jumi-visual-test-'));
  directories.push(root);
  const library = new FilePresentationTemplateLibrary({ root });
  const profile = await library.importPptx(scope, { bytes: fixture(), name: 'Watercolor' });
  const store = new InMemoryPresentationArtifactStore();
  const jpeg = await sharp({
    create: { width: 200, height: 100, channels: 3, background: '#92afc4' },
  })
    .jpeg()
    .toBuffer();
  const renderer = vi.fn(async () => [{ page: 1, bytes: jpeg }]);
  const analysis = {
    summary: '水彩课堂',
    families: [
      {
        id: 'watercolor',
        name: '水彩',
        pages: [1],
        palette: ['#92afc4'],
        typography: '留白标题',
        composition: '纸张与留白',
        artwork: '水彩笔触',
        preserve: ['纸张纹理'],
      },
    ],
    components: [
      {
        id: 'book',
        name: '书本',
        page: 1,
        familyId: 'watercolor',
        box: { x: 0, y: 0, width: 0.4, height: 0.8 },
        role: 'artwork',
        containsText: false,
        treatment: 'crop',
        rationale: '独立装饰',
      },
      {
        id: 'ribbon',
        name: '旧标题',
        page: 1,
        familyId: 'watercolor',
        box: { x: 0.4, y: 0.1, width: 0.5, height: 0.3 },
        role: 'heading',
        containsText: true,
        treatment: 'redraw',
        rationale: '文字烧录',
      },
    ],
    guidance: '复用书本，标题重绘',
  };
  const chat = vi.fn<GLMMultimodalChatPort['chat']>(async () => ({
    choices: [
      { index: 0, message: { role: 'assistant' as const, content: JSON.stringify(analysis) } },
    ],
    id: 'vision',
    model: 'vision-test',
    created: 1,
  }));
  chat.mockResolvedValueOnce({
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            ...analysis,
            components: [
              { ...analysis.components[0], box: { x: 10, y: 20, width: 30, height: 40 } },
            ],
          }),
        },
      },
    ],
    id: 'invalid-coordinates',
    model: 'test',
    created: 1,
  });
  const port: GLMMultimodalChatPort = {
    chat,
    providerId: 'test',
    manifest: {
      providerId: 'test',
      model: 'vision-test',
      displayName: 'Vision',
      supportsVision: true,
      supportsIdempotency: true,
    },
  };
  const learning = new TemplateVisualLearning({ library, store, chat: port, renderer });
  expect(
    learning.operations().find(({ name }) => name === 'presentation.template.analyzeVisual')?.agent
      ?.maxCalls,
  ).toBe(12);
  expect(
    learning.operations().find(({ name }) => name === 'presentation.template.extractComponent')
      ?.agent?.maxCalls,
  ).toBe(16);
  const ref = { templateId: profile.templateId, versionId: profile.versionId };
  const result = await learning.analyze(ref, { scope });
  expect(result.pages).toHaveLength(1);
  expect(chat.mock.calls[0][0].messages[1].content).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]),
  );
  expect(chat.mock.calls[0][1].trustedImages).toBeDefined();
  await learning.analyze(ref, { scope });
  expect(chat).toHaveBeenCalledTimes(2);
  expect(renderer).toHaveBeenCalledOnce();
  const component = await learning.extract({ ...ref, componentId: 'p1-book' }, { scope });
  expect((await store.get(scope, component.ref))?.metadata).toMatchObject({
    sourcePage: 1,
    componentId: 'p1-book',
  });
  await expect(learning.extract({ ...ref, componentId: 'p1-ribbon' }, { scope })).rejects.toThrow(
    '旧文字',
  );
  await expect(learning.analyze(ref, { scope: { ...scope, userId: 'other' } })).rejects.toThrow(
    '找不到',
  );
  expect((await library.resolve(scope, ref)).visual?.families[0].name).toBe('水彩');
  analysis.components[0].box.x = 0.1;
  await learning.analyze({ ...ref, pages: [1], refresh: true }, { scope });
  const refined = await learning.extract({ ...ref, componentId: 'p1-book' }, { scope });
  expect(refined.ref).not.toBe(component.ref);
  expect((await store.get(scope, refined.ref))?.metadata?.region).toMatchObject({ x: 0.1 });
});

it('renders a template learned from an existing SVG deck without requiring a native PPTX', async () => {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'jumi-plan-visual-'));
  directories.push(root);
  const library = new FilePresentationTemplateLibrary({ root });
  const store = new InMemoryPresentationArtifactStore();
  const profile = await library.learnFromPlan(scope, {
    name: 'Existing work',
    plan: {
      planId: 'p',
      title: 'Work',
      aspectRatio: '16:9',
      sourceVersionIds: [],
      slides: [
        {
          slideId: 's1',
          order: 1,
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="#F9F0E2"/><text x="50" y="80" font-size="32">Course</text></svg>',
        },
      ],
    },
  });
  const chat = {} as GLMMultimodalChatPort;
  const pages = await new TemplateVisualLearning({ library, store, chat }).render(
    { templateId: profile.templateId },
    { scope },
  );
  expect(pages).toHaveLength(1);
  expect(pages[0].nativeTextCount).toBe(1);
  const image = await store.get(scope, pages[0].ref);
  expect(image?.mimeType).toBe('image/jpeg');
  expect((await sharp(image!.bytes).metadata()).width).toBe(1400);
});

it('pauses for a material media decision and resumes the same learned version with guidance', async () => {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'jumi-visual-clarification-'));
  directories.push(root);
  const library = new FilePresentationTemplateLibrary({ root });
  const profile = await library.importPptx(scope, { bytes: videoFixture(), name: 'Video lesson' });
  const store = new InMemoryPresentationArtifactStore();
  const jpeg = await sharp({
    create: { background: '#ece8df', channels: 3, height: 100, width: 200 },
  })
    .jpeg()
    .toBuffer();
  const renderer = vi.fn(async () => [{ bytes: jpeg, page: 1 }]);
  const analysis = {
    components: [],
    families: [
      {
        artwork: '课堂视频与纸张纹理',
        composition: '视频占据主舞台',
        id: 'lesson',
        name: '课程页',
        pages: [1],
        palette: ['#ECE8DF'],
        preserve: ['视频位置'],
        typography: '克制标题',
      },
    ],
    guidance: '保持内容区和视频之间的比例',
    questions: [],
    summary: '视频课程模板',
  };
  const chat = vi.fn<GLMMultimodalChatPort['chat']>(async () => ({
    choices: [
      { index: 0, message: { content: JSON.stringify(analysis), role: 'assistant' as const } },
    ],
    created: 1,
    id: 'vision',
    model: 'vision-test',
  }));
  const port: GLMMultimodalChatPort = {
    chat,
    manifest: {
      displayName: 'Vision',
      model: 'vision-test',
      providerId: 'test',
      supportsIdempotency: true,
      supportsVision: true,
    },
    providerId: 'test',
  };
  const question: TemplateLearningQuestion = {
    choices: [
      { consequence: '先理解音轨再取舍', id: 'transcribe', label: '先转写音轨' },
      { consequence: '保留动态内容', id: 'preserve', label: '保留原视频' },
      { consequence: '只保留视觉', id: 'poster', label: '只留封面' },
    ],
    id: 'video-role',
    mediaId: profile.media![0].mediaId,
    page: 1,
    question: '这段视频需要继续播放吗？',
    reason: '静态页面不能决定动态内容是否是课程主体。',
    recommendedChoiceId: 'preserve',
  };
  const secondQuestion: TemplateLearningQuestion = {
    choices: [
      { consequence: '保持原身份', id: 'preserve', label: '保留旧标识' },
      { consequence: '适配新项目', id: 'redraw', label: '重绘标识区' },
    ],
    id: 'brand-mark',
    page: 1,
    question: '页面上的旧标识需要保留吗？',
    reason: '这会改变组件是否可以直接复用。',
    recommendedChoiceId: 'redraw',
  };
  const mediaAnalyzer: TemplateMediaAnalyzer = vi.fn(async () => [
    {
      confidence: 0.5,
      frameRefs: ['frame-1'],
      kind: 'video' as const,
      mediaId: profile.media![0].mediaId,
      page: 1,
      preserveRecommendation: 'preserve' as const,
      questions: [question, secondQuestion],
      role: 'demonstration' as const,
      status: 'analyzed' as const,
      summary: '演示视频',
      transcriptStatus: 'not-requested' as const,
      visualStyle: '纸张质感',
    },
  ]);
  const learning = new TemplateVisualLearning({
    chat: port,
    library,
    mediaAnalyzer,
    renderer,
    store,
  });
  const reference = { templateId: profile.templateId, versionId: profile.versionId };
  const paused = await learning.analyze(reference, { scope });
  expect(paused.learning.status).toBe('needs_input');
  expect(paused.learning.questions).toEqual([question, secondQuestion]);
  await learning.analyze(reference, { scope });
  expect(chat).toHaveBeenCalledOnce();
  await expect(
    learning.analyze(
      {
        ...reference,
        choiceId: 'transcribe',
        guidance: '尝试转写这个没有转写选项的问题。',
        questionId: secondQuestion.id,
      },
      { scope },
    ),
  ).rejects.toThrow('模板学习选择不属于当前待确认问题');
  expect(mediaAnalyzer).toHaveBeenCalledOnce();
  const resumed = await learning.analyze(
    {
      ...reference,
      choiceId: 'transcribe',
      guidance: '先转写音轨，再结合内容决定是否保留。',
      questionId: question.id,
    },
    { scope },
  );
  expect(resumed.learning).toMatchObject({
    guidanceHistory: ['[video-role] (transcribe) 先转写音轨，再结合内容决定是否保留。'],
    questions: [secondQuestion],
    status: 'needs_input',
  });
  expect(mediaAnalyzer).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      existing: expect.arrayContaining([
        expect.objectContaining({ mediaId: profile.media![0].mediaId }),
      ]),
      transcribeMediaIds: [profile.media![0].mediaId],
    }),
  );
  const ready = await learning.analyze(
    { ...reference, guidance: '重绘标识区，换成新项目身份。', questionId: secondQuestion.id },
    { scope },
  );
  expect(ready.learning).toMatchObject({
    guidanceHistory: [
      '[video-role] (transcribe) 先转写音轨，再结合内容决定是否保留。',
      '[brand-mark] 重绘标识区，换成新项目身份。',
    ],
    questions: [],
    status: 'ready',
  });
  expect(JSON.stringify(chat.mock.calls[2][0])).toContain(
    '[video-role] (transcribe) 先转写音轨，再结合内容决定是否保留。',
  );
  const refreshed = await learning.analyze({ ...reference, refresh: true }, { scope });
  expect(refreshed.learning.status).toBe('ready');
  expect(mediaAnalyzer).toHaveBeenCalledTimes(3);
  expect(chat).toHaveBeenCalledTimes(4);
});

it('surveys the whole native deck and keeps a diverse bounded set instead of fixed page numbers', async () => {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'jumi-visual-survey-'));
  directories.push(root);
  const library = new FilePresentationTemplateLibrary({ root });
  const profile = await library.importPptx(scope, {
    bytes: fixture(8),
    name: 'Many styles',
  });
  const store = new InMemoryPresentationArtifactStore();
  const renderer = vi.fn(async (_bytes: Uint8Array, pages: number[]) =>
    Promise.all(
      pages.map(async (page) => ({
        bytes: await sharp({
          create: {
            background: { b: page * 20, g: 255 - page * 20, r: page * 28 },
            channels: 3,
            height: 90,
            width: 160,
          },
        })
          .jpeg()
          .toBuffer(),
        page,
      })),
    ),
  );
  const pages = await new TemplateVisualLearning({
    chat: {} as GLMMultimodalChatPort,
    library,
    renderer,
    store,
  }).render({ templateId: profile.templateId }, { scope });
  expect(renderer).toHaveBeenCalledWith(
    expect.any(Uint8Array),
    [1, 2, 3, 4, 5, 6, 7, 8],
    undefined,
  );
  expect(pages).toHaveLength(6);
  expect(pages.map((page) => page.page)).toEqual(expect.arrayContaining([1, 8]));
});
