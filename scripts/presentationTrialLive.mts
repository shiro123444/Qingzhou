/** Opt-in live trial. Read-only import into a new local account; never writes source data.
 * TRIAL_ENV_FILE=/absolute/.env.local bun scripts/presentationTrialLive.mts JOB_JSON CAPSULE_JSON PAGE
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'dotenv';
import { z } from 'zod';

import { AtomicRuntime } from '../src/server/runtime/atomic-runtime';
import {
  capabilityCapsuleSchema,
  capabilityMemoryOperations,
  FileCapabilityCapsuleStore,
} from '../src/server/runtime/presentation/capability-memory';
import {
  FilePresentationStorage,
  type StoredPresentationJob,
} from '../src/server/runtime/presentation/file-storage';
import {
  createProductionMultimodalChatPort,
  loadProductionMultimodalChatProviderConfig,
} from '../src/server/runtime/presentation/production-multimodal-chat-config';
import {
  trialDigest,
  trialJson,
  type TrialSettings,
} from '../src/server/runtime/presentation/trial-configuration';
import { createRealTrialAdapters } from '../src/server/runtime/presentation/trial-real-adapters';
import { FileTrialEvidenceStore } from '../src/server/runtime/presentation/trial-review';
import type { TrialStageContext } from '../src/server/runtime/presentation/trial-runner';
import {
  createTrialExecutionPlugin,
  RepresentativeTrialRunner,
} from '../src/server/runtime/presentation/trial-runner';
import {
  assertTrialCanvas,
  fitTrialPageText,
} from '../src/server/runtime/presentation/trial-text-layout';

const [jobFile, capsuleFile, pageArg] = process.argv.slice(2);
if (!jobFile || !capsuleFile || !/^\d+$/u.test(pageArg ?? ''))
  throw new Error('Usage: JOB_JSON CAPSULE_JSON PAGE');
const raw = await readFile(jobFile);
const record = JSON.parse(raw.toString()) as StoredPresentationJob;
const slide = record.plan?.slides[Number(pageArg) - 1];
if (!slide || !record.job.versionId) throw new Error('Missing source page/version');
if (/<image\b/iu.test(slide.svg))
  throw new Error('Live importer supports text-only sources; use owned artifact import for images');
const sourceHash = createHash('sha256').update(raw).digest('hex');
const root = path.resolve('.data/presentation-trial-live', randomUUID());
await mkdir(root, { recursive: true, mode: 0o700 });
const scope = { userId: 'local-trial-import', sessionId: path.basename(root) };
const storage = new FilePresentationStorage(path.join(root, 'source-copy'));
await storage.saveJob(scope, { ...record, scope });
const capsuleRaw = await readFile(capsuleFile);
const capsule = capabilityCapsuleSchema.parse(JSON.parse(capsuleRaw.toString()));
if (capsule.kind !== 'layout') throw new Error('Expected observed layout capsule');
// Explicit local evidence import, not a bypass of a logged-in account's memory API.
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const memoryRoot = path.join(root, 'imported-memory');
const dir = path.join(memoryRoot, hash(scope.userId), 'capsules');
await mkdir(dir, { recursive: true, mode: 0o700 });
await writeFile(path.join(dir, `${hash(capsule.id)}.json`), trialJson(capsule), {
  flag: 'wx',
  mode: 0o600,
});
await writeFile(
  path.join(root, 'import-provenance.json'),
  trialJson({
    jobFile: path.resolve(jobFile),
    capsuleFile: path.resolve(capsuleFile),
    sourceHash,
    capsuleHash: createHash('sha256').update(capsuleRaw).digest('hex'),
    page: Number(pageArg),
    accountBoundary: 'explicit local read-only import',
  }),
  { flag: 'wx', mode: 0o600 },
);
const env = process.env.TRIAL_ENV_FILE
  ? parse(await readFile(process.env.TRIAL_ENV_FILE))
  : { ...process.env };
const config = loadProductionMultimodalChatProviderConfig(env);
const configuredPort = createProductionMultimodalChatPort({ env, fetcher: globalThis.fetch });
let responseIndex = 0;
const port: typeof configuredPort = {
  ...configuredPort,
  manifest: configuredPort.manifest,
  providerId: configuredPort.providerId,
  chat: async (request, context) => {
    const result = await configuredPort.chat(request, context);
    await writeFile(path.join(root, `model-response-${responseIndex++}.json`), trialJson(result), {
      flag: 'wx',
      mode: 0o600,
    });
    return result;
  },
};
const configurationDigest = trialDigest({ endpoint: config.endpoint, model: config.model });
const adapters = createRealTrialAdapters({
  version: process.env.TRIAL_REPLAY_PLAN ? 'real-probe-replay-v3' : 'real-probe-v3',
  evaluatorVersion: 'anonymous-visual-v1',
  planner: { port, configurationDigest },
  observer: { port, configurationDigest },
});
const model = {
  providerId: port.manifest.providerId,
  model: port.manifest.model,
  configurationDigest,
  maxOutputTokens: 7000,
  temperature: 0,
};
const settings: TrialSettings = {
  schemaVersion: 1,
  imageGeneration: false,
  executorVersion: adapters.version,
  rendererVersion: adapters.rendererVersion,
  recipe: {
    id: 'bounded-academic-layout-v2',
    instructions:
      '保留源页面的原配色、学术风格和全部原文。按固定 text-bounds-v1 规则控制行宽、容器和下一段边界；仅在放得下时将过小的正文提升至16、较长粗体小标题提升至18（以960宽为基准），不得缩字、裁剪或省略内容。',
  },
  models: { planner: model, observer: { ...model, maxOutputTokens: 4000 } },
  frozenInputs: { sourceImportHash: sourceHash },
  baselineCapsuleIds: z
    .array(z.string())
    .parse(record.plan?.designSpec?.learnedCapabilityIds ?? []),
  probeAllowance: { tokens: 24000, costMicros: 1000000 },
  evaluation: {
    version: adapters.evaluatorVersion,
    allowance: { tokens: 24000, costMicros: 1000000 },
    visualConstraints: '课程介绍。保持原配色、学术风格、全部原文和待确认项。',
  },
};
const replayFile = process.env.TRIAL_REPLAY_PLAN;
const replay = replayFile
  ? (JSON.parse(await readFile(replayFile, 'utf8')) as StoredPresentationJob['plan'])
  : undefined;
if (replayFile && !replay?.slides[0]) throw new Error('Replay page unavailable');
if (replay) settings.frozenInputs.replayPlanDigest = trialDigest(replay);
const backend = replay
  ? {
      ...adapters,
      probe: async (context: TrialStageContext) => {
        assertTrialCanvas(context.plan.slides[0].svg, replay.slides[0].svg);
        return {
          page: {
            svg: fitTrialPageText(replay.slides[0].svg, context.signal),
            notes: replay.slides[0].notes,
          },
          usage: { tokens: 0, costMicros: 0 },
        };
      },
    }
  : adapters;
const runtime = new AtomicRuntime([
  {
    id: 'presentation',
    version: 'memory-v1',
    operations: capabilityMemoryOperations(new FileCapabilityCapsuleStore(memoryRoot)),
  },
  createTrialExecutionPlugin(backend),
]);
const reviewEvidence = new FileTrialEvidenceStore(
  process.env.TRIAL_REVIEW_DIR ?? path.join(root, 'trial-evidence'),
);
const runner = new RepresentativeTrialRunner({
  publishEvidence: (scope, report) => reviewEvidence.publish(scope, report),
  runtime,
  repository: storage,
  artifacts: storage,
  root: path.join(root, 'runs'),
  settings: async () => settings,
  budget: {
    maxProbes: 1,
    maxRenders: 2,
    maxEvaluations: 1,
    maxTokens: 48000,
    maxCostMicros: 2000000,
    maxDurationMs: 180000,
    maxSnapshotBytes: 32 * 1024 * 1024,
    maxArtifactBytes: 16 * 1024 * 1024,
  },
});
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
try {
  const result = await runner.run(
    {
      jobId: record.job.jobId,
      expectedVersionId: record.job.versionId,
      slideId: slide.slideId,
      candidates: [{ id: 'observed-layout', patch: { layoutCapsuleIds: [capsule.id] } }],
    },
    { scope, signal: controller.signal },
  );
  const unchanged =
    sourceHash ===
    createHash('sha256')
      .update(await readFile(jobFile))
      .digest('hex');
  console.log(
    JSON.stringify(
      {
        root,
        status: result.status,
        errorCode: result.errorCode,
        selectedId: result.selectedId,
        selection: result.selection,
        charged: result.charged,
        costAccounting: 'reserved allowance; not a measured invoice',
        calls: result.calls,
        originalSourceUnchanged: unchanged,
        directory: result.directory,
      },
      null,
      2,
    ),
  );
  if (!unchanged || result.status !== 'completed') process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', cancel);
  await runner.drain();
  await runtime.dispose();
}
