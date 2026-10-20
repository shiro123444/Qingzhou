/** Real model + corpus selection + owned references + image generation + native PPTX export. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { PresentationJobInput } from '../packages/runtime-contracts/src';
import { presentationAccountScope } from '../src/server/runtime/presentation/account-workspace';
import { createPresentationArtifactAssetStoreBridge } from '../src/server/runtime/presentation/asset-store';
import { FileCapabilityCapsuleStore } from '../src/server/runtime/presentation/capability-memory';
import { inspectPresentationContent } from '../src/server/runtime/presentation/content-quality';
import { FilePresentationStorage } from '../src/server/runtime/presentation/file-storage';
import { createPresentationImageGenerationEventPublisher } from '../src/server/runtime/presentation/image-event-bridge';
import { createImageGenerationCapability } from '../src/server/runtime/presentation/image-generation-capability';
import { createLocalCorpusSeeder } from '../src/server/runtime/presentation/local-corpus';
import { createFallbackMultimodalChatPort } from '../src/server/runtime/presentation/multimodal-chat-fallback';
import { PRODUCTION_PRESENTATION_ENV_KEYS } from '../src/server/runtime/presentation/production-config';
import { createProductionPresentationGenerationComposition } from '../src/server/runtime/presentation/production-factory';
import { createProductionOpenAIImageGenerationPort } from '../src/server/runtime/presentation/production-image-config';
import { createProductionMultimodalChatPort } from '../src/server/runtime/presentation/production-multimodal-chat-config';
import { createPresentationJobEventPublisher } from '../src/server/runtime/presentation/publisher';
import { createPresentationChatFetch } from '../src/server/runtime/presentation/resilient-fetch';
import { presentationAssetHref } from '../src/server/runtime/presentation/revision-assets';
import { createProcessPresentationRunner } from '../src/server/runtime/presentation/runner';
import { composePresentationAssets } from '../src/server/runtime/presentation/slide-asset-placement';
import { FilePresentationTemplateLibrary } from '../src/server/runtime/presentation/templates';
import { PptMasterToolchain } from '../src/server/runtime/presentation/toolchain';

const root = path.resolve(process.argv[2] ?? '.data/presentation');
const output = path.resolve(process.argv[3] ?? `.data/presentation-validation/${Date.now()}`);
await mkdir(output, { recursive: true });
const scope = {
  ...presentationAccountScope('presentation-corpus-validation'),
  request: new Request('http://localhost/presentation-corpus-validation'),
};
const store = new FilePresentationStorage(root);
const library = new FilePresentationTemplateLibrary({ root: path.join(root, 'templates') });
const memory = new FileCapabilityCapsuleStore(path.join(root, 'capability-memory'));
const seed = createLocalCorpusSeeder({
  sourceUserId: process.env.CORDIS_PRESENTATION_LOCAL_CORPUS_USER_ID ?? 'local-ppt-user',
  library,
  store,
  memory,
});
const primary = createProductionMultimodalChatPort({
  env: { ...process.env },
  fetcher: createPresentationChatFetch(globalThis.fetch),
});
const fallback = process.env.PRESENTATION_VISION_FALLBACK_MODEL
  ? createProductionMultimodalChatPort({
      env: { ...process.env, ANTHROPIC_MODEL: process.env.PRESENTATION_VISION_FALLBACK_MODEL },
      fetcher: createPresentationChatFetch(globalThis.fetch),
    })
  : undefined;
const provider = createFallbackMultimodalChatPort(primary, fallback, {
  primaryCooldownMs: 5 * 60_000,
});
let chatCalls = 0,
  imageCalls = 0;
const started = Date.now();
const log = (event: string, detail: unknown = {}) =>
  console.log(
    JSON.stringify({ event, seconds: Math.round((Date.now() - started) / 1000), detail }),
  );
const chat = {
  ...provider,
  chat: async (...args: Parameters<typeof provider.chat>) => {
    const call = ++chatCalls;
    log('model-start', { call });
    const result = await provider.chat(...args);
    await writeFile(path.join(output, `response-${call}.json`), JSON.stringify(result));
    log('model-done', { call, model: result.model });
    return result;
  },
};
const visionChat = fallback ? {
  ...fallback,
  chat: async (...args: Parameters<typeof fallback.chat>) => {
    const call = ++chatCalls;
    log('vision-start', { call });
    const result = await fallback.chat(...args);
    await writeFile(path.join(output, `response-${call}.json`), JSON.stringify(result));
    log('vision-done', { call, model: result.model });
    return result;
  },
} : chat;
const assets = createPresentationArtifactAssetStoreBridge(store);
const journal = store.createJournal(scope);
const imagePort = createProductionOpenAIImageGenerationPort(
  { ...process.env },
  {
    fetcher: async (...args) => {
      log('image-request', { call: ++imageCalls });
      return fetch(...args);
    },
    readReferenceAsset: async (owner, ref) => {
      const image = await store.get(owner, ref);
      return image?.bytes && image.mimeType
        ? { bytes: image.bytes, mimeType: image.mimeType }
        : null;
    },
    assetSink: async ({ bytes, metadata, scope: owner }) => {
      const ref = `image-${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
      return (await assets.put(owner, { asset: { ref }, bytes, metadata, idempotencyKey: ref }))
        .asset;
    },
  },
);
const pptRoot = process.env.CORDIS_PPT_MASTER_ROOT;
if (!pptRoot) throw new Error('Configure CORDIS_PPT_MASTER_ROOT');
const python = process.env.CORDIS_PPT_PYTHON ?? 'python3';
const scripts = path.join(pptRoot, 'skills/ppt-master/scripts');
const runner = createProcessPresentationRunner({
  id: 'corpus-export',
  command: [python],
  declareArtifacts: (request) =>
    request.operation === 'export' ? ['exports/presentation.pptx'] : [],
  maxArtifacts: 32,
});
const toolchain = new PptMasterToolchain({
  runner,
  runnerId: runner.id,
  allowedRunnerIds: [runner.id],
  pptMasterRoot: pptRoot,
  providerCommand: [python],
  workspaceRoot: output,
  convertScriptPath: path.join(scripts, 'svg_to_pptx.py'),
  qualityScriptPath: path.join(scripts, 'svg_quality_checker.py'),
  qualityArgs: ['--quick-generate', '--stage', 'final', '--json'],
  convertArgs: ['--quick-generate', '--with-notes'],
  timeoutMs: 120000,
});
const { composition } = createProductionPresentationGenerationComposition({
  artifactStore: store,
  jobRepository: store,
  capabilityMemory: memory,
  templateLibrary: library,
  prepareCapabilityLibrary: seed,
  multimodalChatPort: chat,
  visionChatPort: visionChat,
  imageBudget: 3,
  imageGenerationCapability: createImageGenerationCapability({
    assetStore: assets,
    imagePort,
    eventPublisherFactory: async (owner) =>
      createPresentationImageGenerationEventPublisher({
        scope: owner,
        publisher: createPresentationJobEventPublisher({ journal, scope: owner }),
      }),
  }),
  journalLoader: async () => journal,
  env: {
    [PRODUCTION_PRESENTATION_ENV_KEYS.provider]: 'ppt-master',
    [PRODUCTION_PRESENTATION_ENV_KEYS.command]: JSON.stringify([
      python,
      path.join(scripts, 'svg_to_pptx.py'),
    ]),
    [PRODUCTION_PRESENTATION_ENV_KEYS.runnerId]: runner.id,
    [PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds]: JSON.stringify([runner.id]),
  },
  contextFactory: (jobId) => {
    const workspace = path.join(output, 'workspace', jobId);
    return {
      plannerContext: {},
      workerContext: {
        jobId,
        workspace: {
          path: workspace,
          write: async (name, content) => {
            const file = path.join(workspace, name);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, content);
          },
        },
        qualityCheck: (directory, signal) => toolchain.qualityCheck(directory, signal),
        convert: (directory, signal) => toolchain.convert(directory, signal),
      },
    };
  },
});
const port = composition.generationPortFactory!(scope);
let input: PresentationJobInput = {
  notebookId: 'studio',
  title: '高校教学与科研工作汇报',
  sourceVersionIds: [],
  slideCount: 6,
  aspectRatio: '16:9',
  language: 'zh-CN',
  prompt:
    '制作一份6页高校教学与科研工作汇报验收样稿。内容是规划方案示例，不代表某校真实业绩，不引用模板中原有的数字、校名、标识或活动照片作为新事实。先按主题和页面任务自主检索已学习的模板能力，组合至少两份不同模板的适用布局与无文字素材。统一整体画风，按需要利用跨模板素材参考生成2张新的相关插图；将复用背景、边框或装饰与新插图分层排版，不把整页生成成图片。标题与正文保持可编辑。每页只表达一个核心观点。每页notes记录设计用法、素材来源与示例性质。',
  options: {
    style: '水彩、纸张纹理或自然插画；整稿统一主色与字体，版式有变化',
    outline: [
      {
        title: '高校教学与科研工作汇报',
        keyPoints: ['以教学问题带动研究改进'],
        visualSuggestion: '封面留白，相关校园或知识生长插图；模板装饰与新插图组合',
      },
      {
        title: '教学改进围绕学生学习证据展开',
        keyPoints: ['课程任务暴露学习难点', '课堂反馈推动教学调整'],
        visualSuggestion: '图文页，可复用无文字边框，生成具有解释作用的课堂学习插图',
      },
      {
        title: '教学与科研通过共同问题连接',
        keyPoints: ['课程问题进入研究议题', '研究方法反哺课程实践'],
        visualSuggestion: '左右对比；借用另一模板的布局结构，保持主风格',
      },
      {
        title: '问题发现形成可持续的改进流程',
        keyPoints: ['收集学习证据', '分析问题与设计行动', '实践反馈与再次调整'],
        visualSuggestion: '可编辑流程，装饰仅放在空白角落',
      },
      {
        title: '资源投入优先支持持续协作',
        keyPoints: ['教师共同备课', '共享研究工具与案例', '积累可复用的教学材料'],
        visualSuggestion: '错落图文布局，结合合适的模板素材；不虚构业绩数字',
      },
      {
        title: '下一阶段以可验证的改进结果推进',
        keyPoints: ['明确改进问题与行动', '保留实施过程和反馈证据'],
        visualSuggestion: '收束页，留白与简洁总结',
      },
    ],
  },
};
const inputIndex = process.argv.indexOf('--input-from');
if (inputIndex >= 0) input = JSON.parse(await readFile(path.resolve(process.argv[inputIndex + 1]), 'utf8'));
const reuseIndex = process.argv.indexOf('--reuse-from');
if (reuseIndex >= 0) {
  const sourceOutput = path.resolve(process.argv[reuseIndex + 1]);
  const sourceJob = JSON.parse(await readFile(path.join(sourceOutput, 'job.json'), 'utf8'));
  const previousAssets = await store.getJob(scope, sourceJob.jobId);
  const descriptions = [];
  for (const slot of (previousAssets?.preparedAssets?.initial?.input.options?.generatedImageSlots ?? []) as Array<{ slideId: string; assetRefs: Array<{ ref: string }> }>) {
    let ref = slot.assetRefs[0]?.ref;
    if (!ref) continue;
    const asset = await store.get(scope, ref);
    if (ref.startsWith('asset-') && Array.isArray(asset?.metadata?.sources))
      ref = asset.metadata.sources.find((source) => typeof source === 'string' && source.startsWith('image-')) ?? ref;
    if (!ref.startsWith('image-')) continue;
    const original = await store.get(scope, ref);
    if (!original?.bytes) throw new Error('Previously generated pixels are unavailable');
    descriptions.push({ slideId: slot.slideId, ref });
  }
  if (!descriptions.length) throw new Error('No reusable generated artwork in the specified job');
  input = { ...input,
    prompt: `${input.prompt}\n同一账号本次验证已经生成了这些新主题插图（不是旧模板照片）：${JSON.stringify(descriptions)}。优先按所属页直接复用这些真实ref，不再重复生图。保留完整插画背景，不再抠掉校园、纸张和知识生长场景。封面与结尾严禁使用带旧年度标题的蓝色整块背景；用原生浅纸色和干净水彩笔触重组。`,
    options: { ...input.options, availableAssetRefs: descriptions.map(({ ref }) => ref) },
  };
  log('reusing-actual-artwork', { sourceJobId: sourceJob.jobId, assets: descriptions });
}
await writeFile(path.join(output, 'input.json'), JSON.stringify(input, null, 2));
const previous = await readFile(path.join(output, 'job.json'), 'utf8')
  .then(JSON.parse)
  .catch(() => null);
const fixLayerIndex = process.argv.indexOf('--fix-page-layer');
const replacementIndex = process.argv.indexOf('--replace-page-from');
let job;
if (previous && replacementIndex >= 0) {
  const replacement = JSON.parse(await readFile(path.resolve(process.argv[replacementIndex + 1]), 'utf8'));
  const latest = await port.readPlan(previous.jobId);
  job = await port.replacePage({ jobId: previous.jobId, page: replacement.page,
    expectedVersionId: latest.job.versionId!, requestId: `replace-${createHash('sha256').update(JSON.stringify(replacement)).digest('hex').slice(0,24)}`,
    svg: replacement.svg, notes: replacement.notes });
} else if (previous && fixLayerIndex >= 0) {
  const page = Number(process.argv[fixLayerIndex + 1]);
  const latest = await port.readPlan(previous.jobId);
  const slide = latest.plan.slides[page - 1];
  if (!slide) throw new Error('Layer repair page does not exist');
  const saved = await store.getJob(scope, previous.jobId);
  const slots = saved?.preparedAssets?.initial?.input.options?.generatedImageSlots as Array<{
    slideId: string; layout: import('../src/server/runtime/presentation/revision-assets').PresentationAssetPlacement;
    assetRefs: Array<{ ref: string }>;
  }>;
  const materialIndex = process.argv.indexOf('--materials');
  const materials = materialIndex >= 0 ? JSON.parse(await readFile(path.resolve(process.argv[materialIndex + 1]), 'utf8')) : [];
  const svg = composePresentationAssets(slide.svg, [...slots.filter((slot) => slot.slideId === slide.slideId)
    .flatMap((slot) => slot.assetRefs.map(({ ref }) => ({ href: presentationAssetHref(ref), layout: slot.layout }))),
    ...materials.map((material: {ref:string;layout: import('../src/server/runtime/presentation/revision-assets').PresentationAssetPlacement}) => ({ href:presentationAssetHref(material.ref), layout:material.layout }))]);
  job = await port.replacePage({ jobId: previous.jobId, page,
    expectedVersionId: latest.job.versionId!, requestId: `repair-layer-${createHash('sha256').update(svg).digest('hex').slice(0,24)}`,
    svg, notes: `${slide.notes ?? ''}\n${materials.length ? `复用素材（真实原稿裁切，已排除旧文字）：${JSON.stringify(materials.map((material: {templateId:string;versionId:string;componentName:string})=>({templateId:material.templateId,versionId:material.versionId,name:material.componentName})))}` : ''}` });
} else job = previous ? await port.retryJob(previous.jobId) : await port.createJob(input);
await writeFile(path.join(output, 'job.json'), JSON.stringify({ jobId: job.jobId }));
log('created', { jobId: job.jobId, output });
journal.subscribe(job.jobId, (event) => {
  const data = event.data as Record<string, unknown>;
  if (data.activity || event.type.includes('failed'))
    log(event.type, { activity: data.activity, phase: data.phase });
});
for (;;) {
  const status = await port.getJob(job.jobId);
  if (['failed', 'cancelled', 'completed'].includes(status!.state)) {
    await writeFile(path.join(output, 'status.json'), JSON.stringify(status, null, 2));
    if (status!.state !== 'completed') {
      log('failed', status!.error);
      process.exitCode = 1;
      break;
    }
    const { plan } = await port.readPlan(job.jobId);
    await writeFile(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2));
    const evidence = [];
    for (const artifactId of status!.artifactIds ?? []) {
      const artifact = await store.get(scope, artifactId);
      if (!artifact) continue;
      evidence.push({ artifactId, type: artifact.type, metadata: artifact.metadata });
      if (artifact.type === 'pptx' && artifact.bytes)
        await writeFile(path.join(output, '高校教学与科研工作汇报.pptx'), artifact.bytes);
    }
    const report = {
      jobId: job.jobId,
      chatCalls,
      imageCalls,
      slides: plan.slides.length,
      contentQuality: inspectPresentationContent(plan),
      capabilityIds: plan.designSpec?.learnedCapabilityIds,
      sources: (await store.getJob(scope, job.jobId))?.input.options?.templateSources,
      artifacts: evidence,
    };
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    log('completed', { slides: plan.slides.length, chatCalls, imageCalls });
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
