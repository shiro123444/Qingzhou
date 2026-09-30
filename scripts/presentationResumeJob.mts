/**
 * Resume one real studio job in place: same storage root, same account scope and the same
 * composition the API route builds. Use it when the UI shows "已保留，等待续绘" and the
 * provider channel is the only thing that was broken.
 *
 * Usage: bun --env-file=.env.local scripts/presentationResumeJob.mts <jobId> <userId> [--dry]
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { presentationAccountScope } from '../src/server/runtime/presentation/account-workspace';
import { createPresentationArtifactAssetStoreBridge } from '../src/server/runtime/presentation/asset-store';
import { FileCapabilityCapsuleStore } from '../src/server/runtime/presentation/capability-memory';
import { FilePresentationStorage } from '../src/server/runtime/presentation/file-storage';
import { createImageGenerationCapability } from '../src/server/runtime/presentation/image-generation-capability';
import { createPresentationImageGenerationEventPublisher } from '../src/server/runtime/presentation/image-event-bridge';
import { createResilientMultimodalChatPort } from '../src/server/runtime/presentation/multimodal-chat-fallback';
import { PRODUCTION_PRESENTATION_ENV_KEYS } from '../src/server/runtime/presentation/production-config';
import {
  createPptMasterProcessRunnerFactory,
  createProductionPresentationGenerationComposition,
} from '../src/server/runtime/presentation/production-factory';
import { createProductionOpenAIImageGenerationPort } from '../src/server/runtime/presentation/production-image-config';
import { createProductionMultimodalChatPort } from '../src/server/runtime/presentation/production-multimodal-chat-config';
import { createPresentationJobEventPublisher } from '../src/server/runtime/presentation/publisher';
import { createPresentationChatFetch } from '../src/server/runtime/presentation/resilient-fetch';
import { createProcessPresentationRunner } from '../src/server/runtime/presentation/runner';
import { FileTeachingMemory } from '../src/server/runtime/presentation/teaching-memory';
import { FilePresentationTemplateLibrary } from '../src/server/runtime/presentation/templates';
import { PptMasterToolchain } from '../src/server/runtime/presentation/toolchain';

const [jobId, userId] = process.argv.slice(2);
const messageIndex = process.argv.indexOf('--message');
const instruction = messageIndex >= 0 ? process.argv[messageIndex + 1] : undefined;
const dryRun = process.argv.includes('--dry');
if (!jobId || !userId)
  throw new Error(
    'Usage: bun --env-file=.env.local scripts/presentationResumeJob.mts <jobId> <userId> [--message "…"] [--dry]',
  );
if (!process.env.CORDIS_PPT_MASTER_ROOT) throw new Error('Missing configuration: CORDIS_PPT_MASTER_ROOT');

const log = (event: string, data: unknown = {}) => console.log(JSON.stringify({ event, data }));
const dataRoot =
  process.env.CORDIS_PRESENTATION_DATA_DIR ?? path.join(process.cwd(), '.data', 'presentation');
const pptRoot = process.env.CORDIS_PPT_MASTER_ROOT;
const python = process.env.CORDIS_PPT_PYTHON ?? 'python3';
const pptEnv: Readonly<Record<string, string | undefined>> = {
  [PRODUCTION_PRESENTATION_ENV_KEYS.provider]: 'ppt-master',
  [PRODUCTION_PRESENTATION_ENV_KEYS.command]: JSON.stringify([
    python,
    process.env.CORDIS_PPT_RUNNER,
  ]),
  [PRODUCTION_PRESENTATION_ENV_KEYS.runnerId]: 'ppt-master-runner',
  [PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds]: JSON.stringify(['ppt-master-runner']),
  [PRODUCTION_PRESENTATION_ENV_KEYS.imageBudget]:
    process.env[PRODUCTION_PRESENTATION_ENV_KEYS.imageBudget],
};

const store = new FilePresentationStorage(dataRoot);
const assets = createPresentationArtifactAssetStoreBridge(store);
const scope = {
  ...presentationAccountScope(userId),
  request: new Request('http://localhost/presentation-resume'),
};
const journal = store.createJournal(scope);

const chat = createResilientMultimodalChatPort(
  createProductionMultimodalChatPort({
    env: { ...process.env },
    fetcher: createPresentationChatFetch(globalThis.fetch),
  }),
);
const imagePort = createProductionOpenAIImageGenerationPort(
  { ...process.env },
  {
    fetcher: globalThis.fetch,
    readReferenceAsset: async (assetScope, ref) => {
      const artifact = await store.get(assetScope, ref);
      return artifact?.bytes && artifact.mimeType
        ? { bytes: artifact.bytes, mimeType: artifact.mimeType }
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

const runnerId = 'ppt-master-generation-toolchain';
const runner = createProcessPresentationRunner({
  command: [python],
  declareArtifacts: (request) =>
    request.operation === 'export' ? ['exports/presentation.pptx'] : [],
  id: runnerId,
  maxArtifacts: 64,
});
const scripts = path.join(pptRoot, 'skills/ppt-master/scripts');
const workspaceRoot = path.join(dataRoot, '..', 'presentation-resume-workspaces');
const toolchain = new PptMasterToolchain({
  allowedRunnerIds: [runnerId],
  convertScriptPath: path.join(scripts, 'svg_to_pptx.py'),
  providerCommand: [python],
  pptMasterRoot: pptRoot,
  qualityScriptPath: path.join(scripts, 'svg_quality_checker.py'),
  runner,
  runnerId,
  timeoutMs: 120_000,
  workspaceRoot,
});


const { composition } = createProductionPresentationGenerationComposition({
  artifactStore: store,
  jobRepository: store,
  capabilityMemory: new FileCapabilityCapsuleStore(path.join(dataRoot, 'capability-memory')),
  teachingMemory: new FileTeachingMemory(path.join(dataRoot, 'teaching-memory')),
  templateLibrary: new FilePresentationTemplateLibrary({ root: path.join(dataRoot, 'templates') }),
  multimodalChatPort: chat,
  imageGenerationCapability: createImageGenerationCapability({
    assetStore: assets,
    imagePort,
    eventPublisherFactory: async (eventScope) =>
      createPresentationImageGenerationEventPublisher({
        scope: eventScope,
        publisher: createPresentationJobEventPublisher({ journal, scope: eventScope }),
      }),
  }),
  journalLoader: async () => journal,
  runnerFactory: createPptMasterProcessRunnerFactory({ pptMasterRoot: pptRoot }),
  env: pptEnv,
  contextFactory: (targetJobId) => {
    const workspacePath = path.join(workspaceRoot, targetJobId);
    return {
      plannerContext: {},
      workerContext: {
        jobId: targetJobId,
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

const port = composition.generationPortFactory!(scope);
const before = await port.getJob(jobId);
if (!before) throw new Error(`Job ${jobId} is not in ${path.join(dataRoot, '<account>', 'jobs')}`);
log('job-found', {
  error: before.error ?? null,
  jobId: before.jobId,
  slideCount: before.slideCount,
  state: before.state,
  title: before.title,
});
if (dryRun) process.exit(0);

const priorSequence = Math.max(-1, ...journal.replay(jobId).map((event) => event.seq));
journal.subscribe(jobId, (event) => {
  if (event.seq <= priorSequence) return;
  const data = event.data as Record<string, unknown>;
  if (data.activity || event.type.includes('failed')) {
    log(event.type, { activity: data.activity, phase: data.phase });
  }
});

const queued = instruction
  ? await port.sendMessage(jobId, {
      content: instruction,
      requestId: `resume-instruction-${Date.now()}`,
      target: { type: 'deck' },
    })
  : await port.retryJob(jobId);
log('queued', { appliedInstruction: Boolean(instruction), state: queued.state });
for (;;) {
  const current = await port.getJob(jobId);
  if (!current) throw new Error('Job disappeared while resuming');
  if (['completed', 'failed', 'cancelled'].includes(current.state)) {
    const artifacts: string[] = [];
    for (const artifactId of current.artifactIds ?? []) {
      const artifact = await store.get(scope, artifactId);
      if (artifact?.bytes && artifact.mimeType?.includes('presentationml')) {
        const target = path.join(dataRoot, '..', 'presentation-resume-artifacts', `${jobId}.pptx`);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, artifact.bytes);
        artifacts.push(target);
      }
    }
    log('finished', { artifacts, error: current.error ?? null, state: current.state });
    process.exitCode = current.state === 'completed' ? 0 : 1;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
