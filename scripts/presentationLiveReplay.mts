/** Explicit opt-in real-provider regression. Writes an isolated run, never overwrites the source job. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createPresentationArtifactAssetStoreBridge } from '../src/server/runtime/presentation/asset-store';
import { FileCapabilityCapsuleStore } from '../src/server/runtime/presentation/capability-memory';
import { inspectPresentationContent } from '../src/server/runtime/presentation/content-quality';
import { FilePresentationStorage } from '../src/server/runtime/presentation/file-storage';
import { createImageGenerationCapability } from '../src/server/runtime/presentation/image-generation-capability';
import { createPresentationImageGenerationEventPublisher } from '../src/server/runtime/presentation/image-event-bridge';
import { createPresentationJobEventPublisher } from '../src/server/runtime/presentation/publisher';
import { createResilientMultimodalChatPort } from '../src/server/runtime/presentation/multimodal-chat-fallback';
import { PRODUCTION_PRESENTATION_ENV_KEYS } from '../src/server/runtime/presentation/production-config';
import {
  createPptMasterProcessRunnerFactory,
  createProductionPresentationGenerationComposition,
} from '../src/server/runtime/presentation/production-factory';
import { createProductionOpenAIImageGenerationPort } from '../src/server/runtime/presentation/production-image-config';
import { createProductionMultimodalChatPort } from '../src/server/runtime/presentation/production-multimodal-chat-config';
import { createPresentationChatFetch } from '../src/server/runtime/presentation/resilient-fetch';
import { createProcessPresentationRunner } from '../src/server/runtime/presentation/runner';
import { FilePresentationTemplateLibrary } from '../src/server/runtime/presentation/templates';
import { PptMasterToolchain } from '../src/server/runtime/presentation/toolchain';

const [sourceJob, sourceTemplate, resumeRoot] = process.argv.slice(2);
if (!sourceJob || !sourceTemplate)
  throw new Error(
    'Usage: bun --env-file=.env.local scripts/presentationLiveReplay.mts job.json template.pptx',
  );
for (const key of [
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CORDIS_PPT_MASTER_ROOT',
  'CORDIS_PPT_RUNNER',
])
  if (!process.env[key]) throw new Error(`Missing configuration: ${key}`);
const old = JSON.parse(await readFile(sourceJob, 'utf8'));
const parent = path.resolve('.data/presentation-replays');
await mkdir(parent, { recursive: true });
const root = resumeRoot ? path.resolve(resumeRoot) : await mkdtemp(path.join(parent, 'live-'));
if (path.dirname(root) !== parent)
  throw new Error('Resume directory must belong to presentation-replays');
const previous = resumeRoot
  ? JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8'))
  : null;
const previousReport = resumeRoot
  ? JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'))
  : null;
const scope = {
  userId: 'local-presentation-validation',
  sessionId: path.basename(root),
  request: new Request('http://localhost/presentation-validation'),
};
const store = new FilePresentationStorage(path.join(root, 'storage'));
const assets = createPresentationArtifactAssetStoreBridge(store);
const memory = new FileCapabilityCapsuleStore(path.join(root, 'capability-memory'));
const library = new FilePresentationTemplateLibrary({ root: path.join(root, 'templates') });
const template = previous
  ? await library.get(scope, previous.input.template)
  : await library.importPptx(scope, {
      name: path.basename(sourceTemplate, '.pptx'),
      bytes: await readFile(sourceTemplate),
    });
if (!template) throw new Error('Replay template is missing');
const started = Date.now();
const log = (event: string, data: unknown = {}) =>
  console.log(
    JSON.stringify({ elapsedSeconds: Math.round((Date.now() - started) / 1000), event, data }),
  );
let chatCalls = previousReport?.chatCalls ?? 0,
  imageCalls = previousReport?.imageCalls ?? 0;
const primaryChat = createProductionMultimodalChatPort({
  env: { ...process.env },
  fetcher: createPresentationChatFetch(globalThis.fetch),
});
const resilientChat = createResilientMultimodalChatPort(primaryChat);
// Task-specific evidence belongs to this regression fixture, never the generic planner.
const scientificContext =
  '本次最优化课程的核查资料：Boyd/Vandenberghe 的 Slater 条件是凸优化强对偶的充分条件，不能仅凭凸性断言强对偶（https://stanford.edu/class/ee364a/lectures/duality.pdf）；L-BFGS 是有限记忆方法，不能将完整 BFGS 的超线性收敛保证无条件搬给固定记忆 L-BFGS（https://academic.oup.com/imajna/article/41/1/1/5706038）。KKT 法向平衡中，反向的矢量是 ∇f 与 λ∇g；∇f 与 -λ∇g 同向，不能因复核文字笔误而画反。可用严格可算的示意例：min y, g(x,y)=x²-y≤0，在(0,0)最优，边界y=x²与目标等高线y=0相切，λ=1，∇f=(0,1)，λ∇g=(0,-1)，可用两条polynomial曲线和两条带arrowEnd:true的points向量呈现，示意而非实测，完整假设留notes。若页面出现“全局全局”等重复文字需同时改正。上述仅作内容事实核查，仍需遵守当前页面的精确 LaTeX、素材及排版协议。';
const chat = {
  ...resilientChat,
  chat: async (...args: Parameters<typeof resilientChat.chat>) => {
    const call = ++chatCalls;
    log('chat-start', { call, instruction: String(args[0].messages[0]?.content).slice(0, 70) });
    const last = args[0].messages.at(-1)?.content;
    if (typeof last === 'string' && last.startsWith('上一轮 JSON 未通过校验'))
      log('validation-repair', { call, feedback: last });
    const result = await resilientChat.chat(
      { ...args[0], messages: [...args[0].messages, { role: 'user', content: scientificContext }] },
      args[1],
    );
    // Save only generated content, never provider request headers or credentials.
    await writeFile(path.join(root, `response-${call}.json`), JSON.stringify(result));
    log('chat-done', { call });
    return result;
  },
};
const imagePort = createProductionOpenAIImageGenerationPort(
  { ...process.env },
  {
    fetcher: async (...args) => {
      imageCalls++;
      log('image-request', { imageCalls });
      return globalThis.fetch(...args);
    },
    readReferenceAsset: async (assetScope, ref) => {
      const asset = await store.get(assetScope, ref);
      return asset?.bytes && asset.mimeType
        ? { bytes: asset.bytes, mimeType: asset.mimeType }
        : null;
    },
    assetSink: async ({ bytes, metadata, scope: assetScope }) => {
      const artifactId = `image-${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
      return (
        await assets.put(assetScope, {
          asset: { ref: artifactId },
          bytes,
          idempotencyKey: artifactId,
          metadata,
        })
      ).asset;
    },
  },
);
const pptRoot = process.env.CORDIS_PPT_MASTER_ROOT!;
const python = process.env.CORDIS_PPT_PYTHON ?? 'python3';
const runnerId = 'ppt-master-generation-toolchain';
const runner = createProcessPresentationRunner({
  id: runnerId,
  command: [python],
  maxArtifacts: 64,
  declareArtifacts: (request) =>
    request.operation === 'export' ? ['exports/presentation.pptx'] : [],
});
const scripts = path.join(pptRoot, 'skills/ppt-master/scripts');
const toolchain = new PptMasterToolchain({
  allowedRunnerIds: [runnerId],
  convertScriptPath: path.join(scripts, 'svg_to_pptx.py'),
  qualityScriptPath: path.join(scripts, 'svg_quality_checker.py'),
  providerCommand: [python],
  pptMasterRoot: pptRoot,
  runner,
  runnerId,
  timeoutMs: 120_000,
  workspaceRoot: root,
});
const journal = store.createJournal(scope);
const result = createProductionPresentationGenerationComposition({
  artifactStore: store,
  jobRepository: store,
  capabilityMemory: memory,
  templateLibrary: library,
  multimodalChatPort: chat,
  imageGenerationCapability: createImageGenerationCapability({
    assetStore: assets,
    imagePort,
    eventPublisherFactory: async (imageScope) =>
      createPresentationImageGenerationEventPublisher({
        scope: imageScope,
        publisher: createPresentationJobEventPublisher({ journal, scope: imageScope }),
      }),
  }),
  journalLoader: async () => journal,
  runnerFactory: createPptMasterProcessRunnerFactory({ pptMasterRoot: pptRoot }),
  env: {
    [PRODUCTION_PRESENTATION_ENV_KEYS.provider]: 'ppt-master',
    [PRODUCTION_PRESENTATION_ENV_KEYS.command]: JSON.stringify([
      python,
      process.env.CORDIS_PPT_RUNNER,
    ]),
    [PRODUCTION_PRESENTATION_ENV_KEYS.runnerId]: 'ppt-master-runner',
    [PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds]: JSON.stringify(['ppt-master-runner']),
    [PRODUCTION_PRESENTATION_ENV_KEYS.imageBudget]:
      process.env[PRODUCTION_PRESENTATION_ENV_KEYS.imageBudget],
  },
  contextFactory: (jobId) => {
    const workspacePath = path.join(root, 'workspace', jobId);
    return {
      plannerContext: {},
      workerContext: {
        jobId,
        convert: (directory, signal) => toolchain.convert(directory, signal),
        qualityCheck: (directory, signal) => toolchain.qualityCheck(directory, signal),
        workspace: {
          path: workspacePath,
          write: async (relative, content) => {
            const target = path.join(workspacePath, relative);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, content);
          },
        },
      },
    };
  },
});
const port = result.composition.generationPortFactory!(scope);
const input = {
  aspectRatio: old.input.aspectRatio,
  language: old.input.language,
  notebookId: 'studio',
  title: old.input.title,
  sourceVersionIds: old.input.sourceVersionIds,
  slideCount: old.input.slideCount,
  template: template.templateId,
  prompt: `重新创作《${old.input.title}》，沿用确认的${old.input.slideCount}页大纲和模板视觉语言。学习模板的表达方式，不复制原课件内容。公式与科研图必须准确表达，避免过密排版，完整解释放演讲备注。画图能力须实际服务于教学：优先生成有明确知识作用的二维科研框架图、机制图或真实资料图；不得为凑配图生成抽象三维地形和无意义装饰。精确坐标、公式、数值与轨迹用原生矢量绘制或校核；生成式插图可用于图文素材，但不得替代可验证的科学关系。`,
  options: {
    audience: old.input.options.audience,
    lessonPlan: old.input.options.lessonPlan,
    visualStoryboard: old.input.options.visualStoryboard,
    contentRevision: old.input.options.contentRevision,
    outline: old.input.options.outline,
    style: old.input.options.style,
    templateVersionId: template.versionId,
  },
};
await writeFile(path.join(root, 'input.json'), JSON.stringify(input, null, 2));
const priorSequence = previous
  ? Math.max(-1, ...journal.replay(previous.job.jobId).map((event) => event.seq))
  : -1;
const created = previous ? await port.retryJob(previous.job.jobId) : await port.createJob(input);
log('created', {
  root,
  jobId: created.jobId,
  templateId: template.templateId,
  title: input.title,
  slides: input.slideCount,
  model: chat.manifest.model,
});
journal.subscribe(created.jobId, (event) => {
  if (event.seq <= priorSequence) return;
  const data = event.data as Record<string, unknown>;
  if (data.activity || event.type.includes('failed'))
    log(event.type, { activity: data.activity, phase: data.phase });
});
for (;;) {
  const job = await port.getJob(created.jobId);
  if (!job) throw new Error('Replay job disappeared');
  if (['completed', 'failed', 'cancelled'].includes(job.state)) {
    const snapshot = await store.getJob(scope, job.jobId);
    await writeFile(path.join(root, 'result.json'), JSON.stringify(snapshot, null, 2));
    for (const id of job.artifactIds ?? []) {
      const artifact = await store.get(scope, id);
      if (artifact?.bytes && artifact.mimeType?.includes('presentationml'))
        await writeFile(path.join(root, 'presentation.pptx'), artifact.bytes);
    }
    const report = {
      root,
      jobId: job.jobId,
      state: job.state,
      error: job.error,
      chatCalls,
      imageCalls,
      contentQuality: snapshot?.plan ? inspectPresentationContent(snapshot.plan) : null,
      learnedCapabilities: await memory.search(
        { ...scope, sessionId: 'subsequent-session' },
        '学术 公式 科研 曲线 蓝红',
      ),
      slideSummary: snapshot?.plan?.slides.map((slide) => ({
        slideId: slide.slideId,
        contentBlocks: slide.metadata?.contentBlocks,
        visualDirection: slide.metadata?.visualDirection,
      })),
    };
    await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    log('finished', {
      root,
      state: job.state,
      error: job.error,
      chatCalls,
      imageCalls,
      learnedCapabilityCount: report.learnedCapabilities.length,
    });
    process.exitCode = job.state === 'completed' ? 0 : 1;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
