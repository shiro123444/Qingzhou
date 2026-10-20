import type {
  ArtifactSnapshot,
  ExportResult,
  PresentationExportFormat,
  PresentationJob,
  PresentationJobInput,
} from '../../../../packages/runtime-contracts/src/index';
import type { PresentationClient } from '../store/presentationStore';

/**
 * Demo transport for the PresentationStudio shell (C-58).
 *
 * The demo client drives jobs through queued -> running -> completed|failed|cancelled
 * with deterministic wall-clock timing, so the UI can be exercised with fake
 * data. It is explicitly NOT a real provider: the UI shows a "demo" badge
 * whenever this client is injected, and failures/pending states are never
 * rewritten into ready artifacts.
 */

export interface PresentationDemoOptions {
  /** If true, the job always ends `failed` with a stable error. Default false. */
  fail?: boolean;
  now?: () => number;
  /** Milliseconds the job stays `queued` after creation. Default 1200. */
  queuedMs?: number;
  /** Milliseconds the job stays `running` before completing. Default 2400. */
  runningMs?: number;
}

interface DemoJobRecord {
  cancelRequestedAt: number | null;
  failedAttempts: number;
  input: PresentationJobInput;
  startedAt: number;
}

const DEMO_ERROR_FAILED = {
  code: 'PPT_MASTER_FAILED',
  message: 'Demo provider unavailable: PPT Master is not configured (honest failure)',
};

const DEMO_ERROR_ALREADY_TERMINAL = {
  code: 'INVALID_TRANSITION',
  message: 'Job is already in a terminal state and cannot run this operation',
};

const svgDataUri = (slideNumber: number, total: number): string => {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">`,
    `<defs><linearGradient id="g${slideNumber}" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="#1d2a3a"/><stop offset="1" stop-color="#123047"/>`,
    `</linearGradient></defs>`,
    `<rect width="640" height="360" rx="14" fill="url(#g${slideNumber})"/>`,
    `<circle cx="580" cy="40" r="90" fill="#2f7ef7" opacity="0.16"/>`,
    `<rect x="48" y="60" width="280" height="26" rx="13" fill="#2f7ef7"/>`,
    `<text x="66" y="79" font-family="sans-serif" font-size="16" fill="#ffffff">DEMO SLIDE</text>`,
    `<text x="48" y="170" font-family="sans-serif" font-size="52" font-weight="700" fill="#ffffff">Slide ${slideNumber}</text>`,
    `<text x="48" y="216" font-family="sans-serif" font-size="20" fill="#d5e2f2">of ${total} · generated slide</text>`,
    `<rect x="48" y="248" width="544" height="64" rx="10" fill="#ffffff" opacity="0.08"/>`,
    `<rect x="48" y="248" width="544" height="64" rx="10" fill="none" stroke="#ffffff" stroke-opacity="0.18"/>`,
    `<text x="70" y="292" font-family="sans-serif" font-size="16" fill="#a9c6e8">placeholder visual structure – no Qingzhou assets</text>`,
    `</svg>`,
  ].join('');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const dateIso = (ms: number): string => new Date(ms).toISOString();

export const createPresentationDemoClient = (
  options: PresentationDemoOptions = {},
): PresentationClient => {
  const queuedMs = options.queuedMs ?? 1200;
  const runningMs = options.runningMs ?? 2400;
  const shouldFail = options.fail ?? false;
  const clock = options.now ?? Date.now;

  const records = new Map<string, DemoJobRecord>();
  const artifactsByJob = new Map<string, ArtifactSnapshot[]>();
  const slideCount = 3;

  const artifactIdFor = (jobId: string, n: number): string => `${jobId}-slide-${n}`;

  const buildSlideArtifacts = (jobId: string): ArtifactSnapshot[] => {
    if (artifactsByJob.has(jobId)) return artifactsByJob.get(jobId)!;
    const now = clock();
    const slides: ArtifactSnapshot[] = [];
    for (let n = 1; n <= slideCount; n++) {
      const uri = svgDataUri(n, slideCount);
      slides.push({
        artifactId: artifactIdFor(jobId, n),
        createdAt: dateIso(now),
        metadata: { demo: true, slideNumber: n },
        mimeType: 'image/svg+xml',
        name: `Slide ${n}.svg`,
        sizeBytes: uri.length,
        status: 'ready',
        type: 'svg',
        updatedAt: dateIso(now),
        uri,
      });
    }
    artifactsByJob.set(jobId, slides);
    return slides;
  };

  const buildJob = (jobId: string): PresentationJob => {
    const record = records.get(jobId);
    if (!record) throw new Error(`Demo job ${jobId} not found`);

    const now = clock();
    const cancelledAt = record.cancelRequestedAt;

    let state: PresentationJob['state'];
    // cancelPresentationJob only records a request while the job is still
    // non-terminal, so a recorded cancel is always the terminal outcome.
    if (cancelledAt !== null) {
      state = 'cancelled';
    } else if (shouldFail && now >= record.startedAt + queuedMs + runningMs) {
      state = 'failed';
    } else if (now < record.startedAt + queuedMs) {
      state = 'queued';
    } else if (now < record.startedAt + queuedMs + runningMs) {
      state = 'running';
    } else {
      state = 'completed';
    }

    const job: PresentationJob = {
      createdAt: dateIso(record.startedAt),
      jobId,
      state,
      updatedAt: dateIso(now),
    };
    if (state === 'completed')
      job.artifactIds = buildSlideArtifacts(jobId).map((a) => a.artifactId);
    if (state === 'failed') job.error = { ...DEMO_ERROR_FAILED };
    return job;
  };

  return {
    createPresentationJob: async (input: PresentationJobInput): Promise<PresentationJob> => {
      const jobId = `demo-${Math.random().toString(36).slice(2, 10)}`;
      records.set(jobId, {
        cancelRequestedAt: null,
        failedAttempts: 0,
        input,
        startedAt: clock(),
      });
      return buildJob(jobId);
    },

    getPresentationJob: async (jobId: string): Promise<PresentationJob | null> => {
      if (!records.has(jobId)) return null;
      return buildJob(jobId);
    },

    deletePresentationJob: async (jobId: string): Promise<void> => {
      if (!records.delete(jobId)) throw new Error(`Demo job ${jobId} not found`);
      artifactsByJob.delete(jobId);
    },

    cancelPresentationJob: async (jobId: string): Promise<PresentationJob> => {
      const record = records.get(jobId);
      if (!record) throw new Error(`Demo job ${jobId} not found`);
      if (record.cancelRequestedAt === null) {
        const job = buildJob(jobId);
        if (job.state === 'completed' || job.state === 'failed') {
          throw new Error(
            `HTTP 409 ${DEMO_ERROR_ALREADY_TERMINAL.code}: ${DEMO_ERROR_ALREADY_TERMINAL.message}`,
          );
        }
        record.cancelRequestedAt = clock();
      }
      // Re-cancelling a cancelled job is idempotent and returns the truth.
      return buildJob(jobId);
    },

    retryPresentationJob: async (jobId: string): Promise<PresentationJob> => {
      const record = records.get(jobId);
      if (!record) throw new Error(`Demo job ${jobId} not found`);
      const job = buildJob(jobId);
      if (job.state === 'queued' || job.state === 'running') {
        throw new Error(`HTTP 409 INVALID_TRANSITION: cannot retry a job in state ${job.state}`);
      }
      record.failedAttempts += 1;
      record.startedAt = clock();
      record.cancelRequestedAt = null;
      artifactsByJob.delete(jobId);
      return buildJob(jobId);
    },

    getArtifact: async (artifactId: string): Promise<ArtifactSnapshot | null> => {
      for (const slides of artifactsByJob.values()) {
        const hit = slides.find((a) => a.artifactId === artifactId);
        if (hit) return { ...hit };
      }
      return null;
    },

    exportArtifact: async (
      artifactId: string,
      format: PresentationExportFormat,
    ): Promise<ExportResult> => {
      const jobId = artifactId.replace(/-slide-\d+$/, '');
      const slides = artifactsByJob.get(jobId);
      const artifact = slides?.find((a) => a.artifactId === artifactId);
      if (!artifact || artifact.status !== 'ready') {
        throw new Error(`HTTP 410 ARTIFACT_UNAVAILABLE: artifact ${artifactId} is not ready`);
      }
      const mimeTypes: Record<PresentationExportFormat, string> = {
        'pdf': 'application/pdf',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'quality-report': 'application/json',
        'svg': 'image/svg+xml',
      };
      const marker = `[demo ${format}] exported from ${artifactId} — real provider wiring pending (C-59)`;
      return {
        artifactId,
        format,
        mimeType: format === 'svg' ? artifact.mimeType : mimeTypes[format],
        uri: `data:text/plain;charset=utf-8,${encodeURIComponent(marker)}`,
      };
    },
  };
};

/** Shared singleton demo client for the studio demo mode. */
export const defaultPresentationDemoClient = createPresentationDemoClient();
