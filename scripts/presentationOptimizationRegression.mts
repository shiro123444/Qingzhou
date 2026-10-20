/** Live application-pipeline regression. Source job is read-only; all output is isolated. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createPresentationArtifactAssetStoreBridge } from '../src/server/runtime/presentation/asset-store';
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
import { PptMasterToolchain } from '../src/server/runtime/presentation/toolchain';
import { lessonPlanSchema } from '../src/types/presentationLesson';

const source = process.argv[2];
if (!source || !process.env.CORDIS_PPT_MASTER_ROOT || !process.env.CORDIS_PPT_RUNNER)
  throw new Error(
    'Pass the saved job JSON and configure the existing presentation providers/toolchain.',
  );
const old = JSON.parse(await readFile(source, 'utf8'));
const lesson = lessonPlanSchema.parse(old.input.options.lessonPlan);
const full = process.argv.includes('--full');
const title = old.input.title;
const opening = {
  id: 'regression-opening',
  title,
  objective: '引入课程',
  teacherCue: '',
  studentAction: '',
  checkForUnderstanding: '',
  durationMinutes: 0.5,
  locked: false,
  frames: [
    {
      id: 'regression-cover',
      title,
      kind: 'cover',
      visibleContent: [],
      visualCue: '独立课程封面，只显示课程标题，无正文、公式与装饰拼贴。',
      withheldContent: [],
      boardSpace: 'none',
    },
  ],
};
const selected = full
  ? lesson.beats
  : [{ ...lesson.beats[2], frames: [lesson.beats[2].frames[0], lesson.beats[2].frames[2]] }];
const nextLesson = lessonPlanSchema.parse({ ...lesson, beats: [opening, ...selected] });
const parent = path.resolve('.data/presentation-optimization-regressions');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, 'live-'));
const scope = {
  userId: 'local-optimization-regression',
  sessionId: path.basename(root),
  request: new Request('http://localhost/regression'),
};
const store = new FilePresentationStorage(path.join(root, 'storage'));
const assets = createPresentationArtifactAssetStoreBridge(store);
const journal = store.createJournal(scope);
const primary = createResilientMultimodalChatPort(
  createProductionMultimodalChatPort({
    env: { ...process.env },
    fetcher: createPresentationChatFetch(globalThis.fetch),
  }),
);
let calls = 0,
  imageCalls = 0;
const chat = {
  ...primary,
  chat: async (...args: Parameters<typeof primary.chat>) => {
    const call = ++calls;
    console.log(JSON.stringify({ event: 'chat-start', call }));
    const feedback = args[0].messages.at(-1)?.content;
    if (typeof feedback === 'string' && feedback.startsWith('上一轮 JSON 未通过校验'))
      console.log(JSON.stringify({ event: 'repair', feedback }));
    const result = await primary.chat(...args);
    await writeFile(path.join(root, `response-${call}.json`), JSON.stringify(result));
    return result;
  },
};
const imagePort = createProductionOpenAIImageGenerationPort(
  { ...process.env },
  {
    fetcher: async (...args) => {
      imageCalls++;
      console.log(JSON.stringify({ event: 'image-request', imageCalls }));
      return globalThis.fetch(...args);
    },
    assetSink: async ({ bytes, metadata, scope: assetScope }) => {
      const ref = `image-${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
      return (
        await assets.put(assetScope, { asset: { ref }, bytes, idempotencyKey: ref, metadata })
      ).asset;
    },
    readReferenceAsset: async (assetScope, ref) => {
      const a = await store.get(assetScope, ref);
      return a?.bytes && a.mimeType ? { bytes: a.bytes, mimeType: a.mimeType } : null;
    },
  },
);
const pptRoot = process.env.CORDIS_PPT_MASTER_ROOT;
const python = process.env.CORDIS_PPT_PYTHON ?? 'python3';
const runnerId = 'optimization-regression';
const runner = createProcessPresentationRunner({
  id: runnerId,
  command: [python],
  maxArtifacts: 100,
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
  timeoutMs: 120000,
  workspaceRoot: root,
});
const result = createProductionPresentationGenerationComposition({
  artifactStore: store,
  jobRepository: store,
  multimodalChatPort: chat,
  journalLoader: async () => journal,
  imageGenerationCapability: createImageGenerationCapability({
    assetStore: assets,
    imagePort,
    eventPublisherFactory: async (imageScope) =>
      createPresentationImageGenerationEventPublisher({
        scope: imageScope,
        publisher: createPresentationJobEventPublisher({ journal, scope: imageScope }),
      }),
  }),
  runnerFactory: createPptMasterProcessRunnerFactory({ pptMasterRoot: pptRoot }),
  env: {
    [PRODUCTION_PRESENTATION_ENV_KEYS.provider]: 'ppt-master',
    [PRODUCTION_PRESENTATION_ENV_KEYS.command]: JSON.stringify([
      python,
      process.env.CORDIS_PPT_RUNNER,
    ]),
    [PRODUCTION_PRESENTATION_ENV_KEYS.runnerId]: 'ppt-master-runner',
    [PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds]: JSON.stringify(['ppt-master-runner']),
  },
  contextFactory: (jobId) => ({
    plannerContext: {},
    workerContext: {
      jobId,
      convert: (directory, signal) => toolchain.convert(directory, signal),
      qualityCheck: (directory, signal) => toolchain.qualityCheck(directory, signal),
      workspace: {
        path: path.join(root, 'workspace', jobId),
        write: async (relative, content) => {
          const file = path.join(root, 'workspace', jobId, relative);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, content);
        },
      },
    },
  }),
});
const port = result.composition.generationPortFactory!(scope);
const input = {
  notebookId: 'studio',
  title,
  aspectRatio: '16:9' as const,
  language: 'zh-CN',
  sourceVersionIds: [],
  options: { lessonPlan: nextLesson, style: old.input.options.style },
};
await writeFile(path.join(root, 'input.json'), JSON.stringify(input, null, 2));
console.log(JSON.stringify({ event: 'started', root, full }));
const created = await port.createJob(input);
journal.subscribe(created.jobId, (event) => {
  const data = event.data as Record<string, unknown>;
  if (data.activity) console.log(JSON.stringify({ event: event.type, activity: data.activity }));
});
for (;;) {
  const snapshot = await store.getJob(scope, created.jobId);
  if (snapshot && ['failed', 'completed', 'cancelled'].includes(snapshot.job.state)) {
    await writeFile(path.join(root, 'result.json'), JSON.stringify(snapshot, null, 2));
    for (const id of snapshot.job.artifactIds ?? []) {
      const a = await store.get(scope, id);
      if (a?.bytes && a.type === 'pptx')
        await writeFile(path.join(root, 'regression.pptx'), a.bytes);
    }
    const report = {
      root,
      state: snapshot.job.state,
      error: snapshot.job.error,
      calls,
      imageCalls,
      slides: snapshot.plan?.slides.length,
      drafts: snapshot.draftCheckpoint?.slides.length,
    };
    await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    process.exitCode = snapshot.job.state === 'completed' ? 0 : 1;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
await port.dispose();
