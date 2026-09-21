import { create, type StoreApi, type UseBoundStore } from 'zustand';

import type {
  ArtifactSnapshot,
  ExportResult,
  PresentationExportFormat,
  PresentationJob,
  PresentationJobInput,
  PresentationMessageInput,
} from '../../../../packages/runtime-contracts/src/index';
import {
  type PresentationJobEvent,
  runtimeClient,
  type RuntimePresentationClient,
  type RuntimePresentationStreamClient,
} from '../../../services/runtime/client';

/**
 * The presentation transport seam (C-15-L / C-60). The studio depends on the
 * shared `RuntimePresentationClient` type from `src/services/runtime/client` —
 * the real HTTP `RuntimeClientImpl` satisfies it structurally; tests and demos
 * inject a fake implementation. No server classes, paths or database models
 * are reachable from here.
 */
export type PresentationClient = RuntimePresentationClient;

/**
 * Resolves the generation prompt for a material slot on-demand (C-99).
 * Invoked by the default HTTP retry adapter; prompt text travels directly in
 * the request body and never enters Zustand state, the DOM or logs.
 */
export type SlotPromptResolver = (input: {
  jobId: string;
  slideId: string;
  slotId: string;
}) => string | undefined;

export interface CreateHttpRetrySlotAdapterOptions {
  resolveSlotPrompt?: SlotPromptResolver;
}

/**
 * C-96 / C-99 default HTTP seam for single-slot retries. The store never
 * stores prompts in state: prompts live in caller-owned slot metadata outside
 * this store and are resolved on-demand by `resolveSlotPrompt`. If no prompt is
 * resolved or the prompt is empty, no request is dispatched and IMAGE_PLAN_INVALID
 * is returned honestly. Scope is resolved by the server session; the client
 * cannot forge userId/sessionId.
 */
export const createHttpRetrySlotAdapter = (
  client: RuntimePresentationClient,
  optionsOrResolver?: CreateHttpRetrySlotAdapterOptions | SlotPromptResolver,
): NonNullable<PresentationStoreOptions['retrySlotAdapter']> => {
  const resolveSlotPrompt =
    typeof optionsOrResolver === 'function'
      ? optionsOrResolver
      : optionsOrResolver?.resolveSlotPrompt;

  return async ({ jobId, slideId, slotId }) => {
    try {
      const rawPrompt = resolveSlotPrompt?.({ jobId, slideId, slotId });
      const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : undefined;
      if (!prompt) {
        return { errorCode: 'IMAGE_PLAN_INVALID', status: 'failed' };
      }
      if (typeof client.createImageGeneration !== 'function') {
        return { errorCode: 'PROVIDER_UNAVAILABLE', status: 'failed' };
      }

      const result = await client.createImageGeneration({
        jobId,
        slots: [{ idempotencyKey: `${jobId}:${slideId}:${slotId}`, prompt, slideId, slotId }],
      });
      const echo = result.slots.find((s) => s.slotId === slotId && s.slideId === slideId);
      if (!echo) {
        return { errorCode: 'IMAGE_PAYLOAD_INVALID', status: 'failed' };
      }
      return echo.status === 'accepted'
        ? { status: 'generating' }
        : { errorCode: echo.errorCode ?? 'IMAGE_UNAVAILABLE', status: 'failed' };
    } catch (err) {
      return { errorCode: toPresentationError(err).code, status: 'failed' };
    }
  };
};

/** Transport with the optional live job event stream (subscribePresentationJob). */
export type PresentationStreamClient = RuntimePresentationStreamClient;

export type PresentationTransportMode = 'http' | 'demo';

export type PresentationPendingAction =
  | 'cancel'
  | 'create'
  | 'delete'
  | 'export'
  | 'refresh'
  | 'retry'
  | undefined;

/**
 * Per-job live stream status (C-66): null/absent = not determined,
 * 'live' = event stream active, 'reconnecting' = bounded backoff in progress
 * (non-fatal), 'polling' = degraded fallback for that job.
 */
export type PresentationStreamStatus = 'live' | 'reconnecting' | 'polling' | null;

export interface PresentationErrorInfo {
  code: string;
  message: string;
}

/* ------------------------------------------------------------------------- *
 * Material slot state (C-87): per-slide/per-slot asset generation status as
 * projected from wire-safe events. Prompts never enter the store — the slot
 * key alone identifies a slot; no user text is logged or displayed.
 * ------------------------------------------------------------------------ */

export type PresentationSlotStatus = 'cancelled' | 'failed' | 'generating' | 'queued' | 'ready';

/** Wire-safe projection of one material slot (no prompt, no binary). */
export interface PresentationSlotState {
  /** Ready assets for this slot — refs/snapshots only, never bytes. */
  artifactIds: string[];
  /** Stable failure code when status === 'failed'; never a prompt. */
  errorCode: string | null;
  /** Human-readable, prompt-free label (e.g. "Chart 2"). */
  label: string;
  /** Highest event seq applied to this slot (per-slot seq idempotency). */
  lastSeq: number;
  /** The slide this slot belongs to. */
  slideId: string;
  /** Stable slot identifier from the generation plan (slideId/slotId). */
  slotId: string;
  status: PresentationSlotStatus;
}

export interface PresentationSlotUpdate {
  artifactId?: string;
  errorCode?: string | null;
  label?: string;
  slideId: string;
  slotId: string;
  status?: PresentationSlotStatus;
}

export interface PresentationStoreOptions {
  /** Initial job ids to be restored (C-112-04). */
  initialJobIds?: string[];
  /** Force initial loading flag during hydration before polling (C-112-04). */
  initialLoading?: boolean;
  /**
   * Optional slot prompt resolver (C-99). Used by the default HTTP retry
   * adapter to supply prompts directly into the request body without storing
   * them in Zustand, the DOM, or logs.
   */
  resolveSlotPrompt?: SlotPromptResolver;
  /**
   * Injected slot adapter (C-87): re-runs one material slot. Tests and demos
   * inject a fake; the real seam is a server route adapter. The prompt travels
   * only inside the adapter's own request, never through the store.
   */
  retrySlotAdapter?: (input: {
    jobId: string;
    scopeKey: string;
    slideId: string;
    slotId: string;
  }) => Promise<{ errorCode?: string; status: PresentationSlotStatus }>;
  transportMode?: PresentationTransportMode;
}

const appendActivity = (
  history: { id: string; text: string }[] = [],
  text: string | undefined,
  id: string,
) => (!text || history.at(-1)?.text === text ? history : [...history, { id, text }].slice(-60));

export interface PresentationJobGenerationProgress {
  /** Short real-time action description from backend SSE/snapshot (R1-B / R2-B) */
  activity?: string;
  activityHistory?: { id: string; text: string }[];
  /** List of generated artifact IDs associated with this job (R2-B) */
  artifactIds?: string[];
  /** Currently active slide number or identifier (1-indexed) */
  currentSlide?: number;
  /** Current lifecycle phase from backend (R2-B) */
  phase?: string;
  /** Generation progress percentage (0 - 100) from backend */
  progress?: number;
  /** Identifier of the current slide being produced (R2-B) */
  slideId?: string;
  /** Current lifecycle stage from backend */
  stage?: string;
  /** Total planned slides */
  totalSlides?: number;
  /** Timestamp of update */
  updatedAt?: string | number;
}

export interface PresentationStudioState {
  artifacts: Record<string, ArtifactSnapshot>;
  clientError: PresentationErrorInfo | null;
  exported: ExportResult | null;
  /**
   * Last failed export attempt (C-80): kept so the failure Alert can offer a
   * keyboard-reachable retry. Cleared only by a successful export or dismiss.
   */
  exportError:
    | (PresentationErrorInfo & { artifactId: string; format: PresentationExportFormat })
    | null;
  exporting: string | null;
  /**
   * Real-time generation progress projected per job from backend events/snapshots (R1-B).
   * Populated ONLY from wire events or backend job snapshots; never guessed from queued/running.
   */
  generationProgressByJob: Record<string, PresentationJobGenerationProgress>;
  /** Count of event payloads that were invalid/unknown and safely ignored. */
  ignoredEvents: number;
  initialLoading: boolean;
  jobOrder: string[];
  jobs: Record<string, PresentationJob>;
  jobTitles: Record<string, string>;
  /**
   * Last input passed to `createJob` (C-74): kept so a provider-unavailable
   * error can offer an honest resubmit recovery action. Never a fabricated job.
   */
  lastCreateInput: PresentationJobInput | null;
  lastSeqByJob: Record<string, number>;
  pendingActions: Record<string, PresentationPendingAction>;
  /**
   * True while a resubmit (C-76) is in flight: the recovery button disables
   * itself and repeated Enter/Space can never start a concurrent create.
   */
  resubmitting: boolean;
  selectedArtifactId: string | null;
  selectedJobId: string | null;
  /** Slot keys with an in-flight retry/regenerate (C-87 re-entrancy guard). */
  slotRetryPending: Record<string, boolean>;
  /**
   * Material slots keyed by `${jobId}:${slideId}:${slotId}` (C-87). One slot's
   * status change never touches another slot; prompts are never stored.
   */
  slots: Record<string, PresentationSlotState>;
  /** Backward-compatible aggregate of `streamStatusByJob` (null = not determined). */
  streamStatus: PresentationStreamStatus;
  /**
   * Per-job live stream status (C-66): a job's status change never overwrites
   * another job's status; absent key means "not determined".
   */
  streamStatusByJob: Record<string, PresentationStreamStatus>;
  transportMode: PresentationTransportMode;
}

export interface PresentationStudioActions {
  /** Applies one wire-safe job event (frozen C-60 semantics, seq-deduplicated). */
  applyPresentationEvent: (event: PresentationJobEvent) => void;
  /**
   * Applies one wire-safe slot event (C-87): per-slot seq idempotency, prompt
   * fields are stripped before they can enter the store, no fabricated ready.
   */
  applySlotEvent: (jobId: string, event: { data: unknown; seq: number; type: string }) => void;
  cancelJob: (jobId: string) => Promise<void>;
  createJob: (input: PresentationJobInput) => Promise<string | null>;
  deleteJob: (jobId: string) => Promise<boolean>;
  dismissError: () => void;
  dismissExport: () => void;
  /** Clears a slot's error after the user saw it (C-87 recovery affordance). */
  dismissSlotError: (jobId: string, slideId: string, slotId: string) => void;
  exportArtifact: (artifactId: string, format: PresentationExportFormat) => Promise<void>;
  refreshArtifacts: (jobId: string) => Promise<void>;
  refreshJob: (jobId: string) => Promise<void>;
  restoreJobList: () => Promise<string[]>;
  /** Re-runs the last failed `createJob` draft (C-74); no-op without a draft. */
  resubmitLastInput: () => Promise<string | null>;
  retryJob: (jobId: string) => Promise<void>;
  /**
   * Re-runs one material slot through the injected slot adapter (C-87). Only
   * that slot is touched; other slots, selection and the draft are preserved.
   * Resolves to true when the slot ended ready.
   */
  retrySlot: (jobId: string, slideId: string, slotId: string) => Promise<boolean>;
  selectArtifact: (artifactId: string) => void;
  selectJob: (jobId: string | null) => void;
  sendMessage: (jobId: string, input: PresentationMessageInput) => Promise<boolean>;
  setInitialLoading: (loading: boolean) => void;
  /** Legacy aggregate setter (C-64 compatibility); does not touch per-job map. */
  setStreamStatus: (status: PresentationStreamStatus) => void;
  /** Idempotent per-job setter (C-66); also recomputes the aggregate. */
  setStreamStatusForJob: (jobId: string, status: PresentationStreamStatus) => void;
}

export type PresentationStudioStore = PresentationStudioState &
  PresentationStudioActions & {
    presentationClient: PresentationStreamClient;
  };

/** The zustand hook returned by `createPresentationStudioStore`. */
export type PresentationStudioStoreHook = UseBoundStore<StoreApi<PresentationStudioStore>>;

export const presentationInitialState: Pick<
  PresentationStudioState,
  | 'artifacts'
  | 'clientError'
  | 'exported'
  | 'exportError'
  | 'exporting'
  | 'generationProgressByJob'
  | 'ignoredEvents'
  | 'initialLoading'
  | 'jobOrder'
  | 'jobs'
  | 'jobTitles'
  | 'lastCreateInput'
  | 'lastSeqByJob'
  | 'pendingActions'
  | 'resubmitting'
  | 'selectedArtifactId'
  | 'selectedJobId'
  | 'slotRetryPending'
  | 'slots'
  | 'streamStatus'
  | 'streamStatusByJob'
> = {
  artifacts: {},
  clientError: null,
  exported: null,
  exportError: null,
  exporting: null,
  generationProgressByJob: {},
  ignoredEvents: 0,
  initialLoading: false,
  jobTitles: {},
  jobs: {},
  jobOrder: [],
  lastCreateInput: null,
  lastSeqByJob: {},
  pendingActions: {},
  resubmitting: false,
  selectedArtifactId: null,
  selectedJobId: null,
  slotRetryPending: {},
  slots: {},
  streamStatus: null,
  streamStatusByJob: {},
};

/**
 * Maps a transport/protocol error into structured `{ code, message }`.
 * Prefers the stable error code (e.g. `PROVIDER_UNAVAILABLE`) and preserves
 * protocol errors verbatim — nothing is swallowed or reframed as success.
 */
export const toPresentationError = (err: unknown): PresentationErrorInfo => {
  const raw = err instanceof Error ? err.message : String(err);

  // Prefer a JSON error body: {"error":{"code","message"}}.
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as {
        error?: { code?: string; message?: string };
      };
      if (parsed?.error?.code) {
        return { code: parsed.error.code, message: parsed.error.message ?? raw };
      }
    } catch {
      // not JSON — fall through to the code-prefix parser
    }
  }

  // Second: a `CODE[: message]` protocol prefix (e.g. `HTTP 409 INVALID_TRANSITION: …`).
  const stripped = raw.replace(/^HTTP\s+\d+\s+/, '');
  if (/^[A-Z][A-Z0-9_]*$/.test(stripped)) {
    return { code: stripped, message: raw };
  }
  const sepIndex = stripped.indexOf(':');
  if (sepIndex > 0) {
    const maybeCode = stripped.slice(0, sepIndex);
    if (/^[A-Z][A-Z0-9_]*$/.test(maybeCode)) {
      return { code: maybeCode, message: stripped.slice(sepIndex + 1).trim() || raw };
    }
  }

  return { code: 'RUNTIME_ERROR', message: raw };
};

const terminal = (state: string): boolean =>
  state === 'completed' || state === 'failed' || state === 'cancelled';

/** Aggregate precedence: any live > any reconnecting > any polling. */
export const aggregateJobStreamStatus = (
  statusByJob: Record<string, PresentationStreamStatus>,
): PresentationStreamStatus => {
  for (const status of ['live', 'reconnecting', 'polling'] as const) {
    if (Object.values(statusByJob).includes(status)) return status;
  }
  return null;
};

/* ------------------------------------------------------------------------- *
 * Event payload projection (C-68): maps wire-safe event data into store
 * snapshots. Only whitelisted fields are kept: bytes/path/workspace data can
 * never enter the store, and malformed payloads are projected as `invalid`.
 * ------------------------------------------------------------------------ */

const JOB_FIELDS = [
  'jobId',
  'state',
  'createdAt',
  'updatedAt',
  'artifactIds',
  'error',
  'title',
  'aspectRatio',
  'projectId',
  'versionId',
  'messages',
  'revisions',
  'slideCount',
] as const;
const ARTIFACT_FIELDS = [
  'artifactId',
  'type',
  'name',
  'mimeType',
  'sizeBytes',
  'status',
  'createdAt',
  'updatedAt',
  'uri',
  'metadata',
] as const;
/** Keys that never belong in the client store regardless of nesting (R1-B). */
const FORBIDDEN_STORE_KEYS = new Set([
  'apiKey',
  'bytes',
  'path',
  'prompt',
  'secret',
  'token',
  'workspace',
  'workspacePath',
]);

const isString = (value: unknown): value is string => typeof value === 'string';

const pickFields = <T>(source: Record<string, unknown>, fields: readonly string[]): T => {
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    const value = source[key];
    if (value === undefined) continue;
    if (FORBIDDEN_STORE_KEYS.has(key)) continue;
    result[key] = value;
  }
  return result as T;
};

export const projectJobSnapshot = (data: unknown): PresentationJob | null => {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (!isString(record.jobId) || !isString(record.state)) return null;
  const job = pickFields<PresentationJob>(record, JOB_FIELDS);
  if (!Array.isArray(job.artifactIds)) delete job.artifactIds;
  else job.artifactIds = job.artifactIds.filter(isString);
  if (job.error && typeof job.error === 'object') {
    const error = job.error as unknown as Record<string, unknown>;
    const { code, message, details } = error;
    job.error = {
      code: isString(code) ? code : 'UNKNOWN',
      message: isString(message) ? message : 'The job failed without an error detail.',
      ...(details !== undefined ? { details } : {}),
    };
  }
  return job;
};

export const projectArtifactSnapshot = (data: unknown): ArtifactSnapshot | null => {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (!isString(record.artifactId)) return null;
  const artifact = pickFields<ArtifactSnapshot>(record, ARTIFACT_FIELDS);
  // Metadata is free-form; strip binary/path-ish keys defensively.
  if (artifact.metadata && typeof artifact.metadata === 'object') {
    const metadata = { ...(artifact.metadata as Record<string, unknown>) };
    for (const forbidden of FORBIDDEN_STORE_KEYS) delete metadata[forbidden];
    artifact.metadata = metadata;
  }
  if (artifact.sizeBytes !== undefined && typeof artifact.sizeBytes !== 'number') {
    delete artifact.sizeBytes;
  }
  return artifact;
};

const needsArtifactHydration = (artifact?: ArtifactSnapshot): boolean =>
  !artifact ||
  (artifact.status === 'ready' &&
    !artifact.uri &&
    (artifact.type === 'svg' ||
      artifact.type === 'image' ||
      Boolean(artifact.mimeType?.startsWith('image/'))));

/** Events carry partial snapshots. Keep fetched preview data and newer state. */
const mergeArtifactSnapshot = (
  current: ArtifactSnapshot | undefined,
  incoming: ArtifactSnapshot,
  changedDuringFetch = false,
): ArtifactSnapshot => {
  if (!current) return incoming;
  const stale =
    changedDuringFetch ||
    Date.parse(incoming.updatedAt ?? '') < Date.parse(current.updatedAt ?? '');
  const [base, latest] = stale ? [incoming, current] : [current, incoming];
  return {
    ...base,
    ...Object.fromEntries(Object.entries(latest).filter(([, value]) => value !== undefined)),
    metadata: { ...base.metadata, ...latest.metadata },
    uri: latest.uri || base.uri,
  };
};

/**
 * Projects real-time generation progress fields (R1-B).
 * Only whitelisted fields (stage, activity, currentSlide, totalSlides, progress, updatedAt)
 * are picked from the backend snapshot or wire event. Forbidden fields (prompt, bytes, etc.)
 * are never admitted.
 */
export const projectGenerationProgress = (
  data: unknown,
): PresentationJobGenerationProgress | null => {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;

  const nested =
    (record.progress && typeof record.progress === 'object'
      ? (record.progress as Record<string, unknown>)
      : null) ??
    (record.generation && typeof record.generation === 'object'
      ? (record.generation as Record<string, unknown>)
      : null);

  const source = nested ?? record;

  const phase = isString(source.phase)
    ? source.phase.trim()
    : isString(source.stage)
      ? source.stage.trim()
      : undefined;
  const stage = isString(source.stage)
    ? source.stage.trim()
    : isString(source.phase)
      ? source.phase.trim()
      : undefined;
  const slideId = isString(source.slideId)
    ? source.slideId.trim()
    : isString(source.slide_id)
      ? source.slide_id.trim()
      : undefined;
  const activity = isString(source.activity)
    ? source.activity.trim()
    : isString(source.action)
      ? source.action.trim()
      : isString(source.lastAction)
        ? source.lastAction.trim()
        : undefined;

  const rawCurrent =
    source.currentSlide ?? source.activeSlide ?? source.slideIndex ?? source.slideId;
  const currentSlide =
    typeof rawCurrent === 'number' && Number.isFinite(rawCurrent) && rawCurrent > 0
      ? Math.floor(rawCurrent)
      : undefined;

  const rawTotal = source.totalSlides ?? source.slideCount ?? source.totalPages;
  const totalSlides =
    typeof rawTotal === 'number' && Number.isFinite(rawTotal) && rawTotal > 0
      ? Math.floor(rawTotal)
      : undefined;

  const rawProgress =
    typeof source.progress === 'number'
      ? source.progress
      : typeof source.percent === 'number'
        ? source.percent
        : undefined;
  const progress =
    rawProgress !== undefined && Number.isFinite(rawProgress)
      ? Math.max(0, Math.min(100, Math.round(rawProgress)))
      : undefined;

  const rawArtifactIds = Array.isArray(source.artifactIds)
    ? source.artifactIds.filter(isString)
    : undefined;
  const artifactIds =
    rawArtifactIds && rawArtifactIds.length > 0 ? [...new Set(rawArtifactIds)] : undefined;

  const updatedAt =
    typeof source.updatedAt === 'string' || typeof source.updatedAt === 'number'
      ? source.updatedAt
      : undefined;

  if (
    phase === undefined &&
    stage === undefined &&
    activity === undefined &&
    slideId === undefined &&
    currentSlide === undefined &&
    totalSlides === undefined &&
    progress === undefined &&
    artifactIds === undefined
  ) {
    return null;
  }

  return {
    ...(activity ? { activity } : {}),
    ...(artifactIds ? { artifactIds } : {}),
    ...(currentSlide !== undefined ? { currentSlide } : {}),
    ...(phase ? { phase } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(slideId ? { slideId } : {}),
    ...(stage ? { stage } : {}),
    ...(totalSlides !== undefined ? { totalSlides } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
};

export type PresentationEventProjection =
  | { kind: 'artifact'; artifact: ArtifactSnapshot }
  | {
      kind: 'bundle';
      artifact?: ArtifactSnapshot;
      artifactIds?: string[];
      job?: PresentationJob;
      progress?: PresentationJobGenerationProgress;
    }
  | { kind: 'invalid' }
  | { kind: 'job'; job: PresentationJob; progress?: PresentationJobGenerationProgress }
  | { kind: 'progress'; progress: PresentationJobGenerationProgress };

/**
 * Classifies the wire payload of one presentation event (C-68):
 * - legacy top-level job/artifact snapshots, and
 * - C-63 nested bundle `{ job, artifact, artifactIds }`.
 * Order matters: a nested bundle wins over top-level shapes.
 */
export const projectPresentationEventData = (data: unknown): PresentationEventProjection => {
  if (!data || typeof data !== 'object') return { kind: 'invalid' };
  const record = data as Record<string, unknown>;
  const topLevelJob = projectJobSnapshot(data);

  if (
    record.job !== undefined ||
    record.artifact !== undefined ||
    (record.artifactIds !== undefined && !topLevelJob)
  ) {
    const job = projectJobSnapshot(record.job);
    const artifact = projectArtifactSnapshot(record.artifact);
    const artifactIds = Array.isArray(record.artifactIds)
      ? record.artifactIds.filter(isString)
      : undefined;
    const progress =
      projectGenerationProgress(record) ??
      (record.job ? projectGenerationProgress(record.job) : null);
    if (!job && !artifact && (!artifactIds || artifactIds.length === 0) && !progress) {
      return { kind: 'invalid' };
    }
    return {
      kind: 'bundle',
      job: job ?? undefined,
      artifact: artifact ?? undefined,
      artifactIds,
      progress: progress ?? undefined,
    };
  }

  const job = topLevelJob;
  if (job) {
    const progress = projectGenerationProgress(data);
    return { kind: 'job', job, progress: progress ?? undefined };
  }
  const artifact = projectArtifactSnapshot(data);
  if (artifact) return { kind: 'artifact', artifact };
  const progress = projectGenerationProgress(data);
  if (progress) return { kind: 'progress', progress };
  return { kind: 'invalid' };
};

/**
 * Creates an isolated presentation studio store backed by an injectable
 * transport. The default real client hits `/api/runtime/presentation/*` and
 * surfaces provider errors honestly; it never fabricates a completed job.
 */
export const createPresentationStudioStore = (
  client: PresentationStreamClient | undefined = runtimeClient,
  options: PresentationStoreOptions = {},
): PresentationStudioStoreHook => {
  // C-96 / C-99: explicit injection wins; otherwise the real HTTP seam backs the
  // retry action (using options.resolveSlotPrompt if provided).
  const retrySlotAdapter =
    options.retrySlotAdapter ??
    (client ? createHttpRetrySlotAdapter(client, options.resolveSlotPrompt) : undefined);

  const initialLastSeqByJob: Record<string, number> = {};
  if (typeof window !== 'undefined' && window.sessionStorage && options.initialJobIds) {
    for (const id of options.initialJobIds) {
      try {
        const stored = window.sessionStorage.getItem(`presentation_studio_last_seq_${id}`);
        if (stored) initialLastSeqByJob[id] = Number(stored);
      } catch {}
    }
  }

  const initialLoading = options.initialLoading ?? Boolean(options.initialJobIds?.length);

  const artifactFetches = new Map<string, Promise<ArtifactSnapshot | null>>();
  const fetchArtifact = (id: string) => {
    const existing = artifactFetches.get(id);
    if (existing) return existing;
    const task = Promise.resolve().then(async () => {
      const snapshot = await client.getArtifact(id);
      if (snapshot && snapshot.artifactId !== id) throw new Error('Artifact response ID mismatch');
      return snapshot;
    });
    artifactFetches.set(id, task);
    const release = () => {
      if (artifactFetches.get(id) === task) artifactFetches.delete(id);
    };
    void task.then(release, release);
    return task;
  };

  return create<PresentationStudioStore>()((set, get) => ({
    ...presentationInitialState,
    initialLoading,
    lastSeqByJob: initialLastSeqByJob,
    presentationClient: client ?? runtimeClient,
    transportMode: options.transportMode ?? 'http',

    applyPresentationEvent: (event) => {
      const lastKnown = get().lastSeqByJob[event.job_id] ?? -1;
      // Idempotent replay: same/older seqs never re-apply (out-of-order guard).
      if (event.seq <= lastKnown) return;

      if (typeof window !== 'undefined' && window.sessionStorage) {
        try {
          window.sessionStorage.setItem(
            `presentation_studio_last_seq_${event.job_id}`,
            String(event.seq),
          );
        } catch {}
      }

      const projection = projectPresentationEventData(event.data);
      if (projection.kind === 'invalid') {
        // Malformed/unknown payload: safe ignore, observable via the counter;
        // seq still advances monotonically (never fabricate completed/ready).
        set((s) => ({
          ignoredEvents: s.ignoredEvents + 1,
          lastSeqByJob: { ...s.lastSeqByJob, [event.job_id]: event.seq },
        }));
        return;
      }

      set((s) => {
        const snapshot =
          projection.kind === 'job' || projection.kind === 'bundle' ? projection.job : undefined;
        const currentJob = s.jobs[event.job_id];
        if (
          snapshot?.jobId === event.job_id &&
          currentJob &&
          Date.parse(snapshot.updatedAt ?? '') < Date.parse(currentJob.updatedAt ?? '')
        ) {
          // A reconnect can replay an old failure after HTTP already restored
          // the completed work. Consume its cursor without rolling back the UI.
          return { lastSeqByJob: { ...s.lastSeqByJob, [event.job_id]: event.seq } };
        }
        const jobs = { ...s.jobs };
        const jobOrder = s.jobOrder.slice();
        const artifacts = { ...s.artifacts };
        const generationProgressByJob = { ...s.generationProgressByJob };
        let ignoredEvents = 0;

        const upsertJob = (job: PresentationJob) => {
          jobs[job.jobId] = job;
          if (!jobOrder.includes(job.jobId)) jobOrder.unshift(job.jobId);
        };

        // Associates artifact ids with a job; unknown jobs are never fabricated.
        const linkArtifactIds = (jobId: string, ids: string[]) => {
          const existing = jobs[jobId];
          if (!existing) return;
          const merged = [...new Set([...(existing.artifactIds ?? []), ...ids])];
          upsertJob({ ...existing, artifactIds: merged });
        };

        // C-72: the wire event's `job_id` is the single ownership anchor. A
        // snapshot naming a different job is foreign state — it is counted as
        // ignored and never creates, rewrites or mutates that other job.
        const upsertOwnedJob = (job: PresentationJob) => {
          // The wire event owns the job scope; a nested snapshot naming a
          // different job must never create or mutate it.
          if (job.jobId === event.job_id) upsertJob(job);
          else ignoredEvents += 1;
        };

        const applyProgress = (progress?: PresentationJobGenerationProgress) => {
          if (!progress) return;
          const current = generationProgressByJob[event.job_id] ?? {};
          generationProgressByJob[event.job_id] = {
            ...current,
            ...progress,
            activityHistory: appendActivity(
              current.activityHistory,
              progress.activity,
              `job:${event.seq}`,
            ),
            ...(progress.artifactIds
              ? {
                  artifactIds: [
                    ...new Set([...(current.artifactIds ?? []), ...progress.artifactIds]),
                  ],
                }
              : {}),
          };
        };

        if (projection.kind === 'bundle') {
          if (projection.job) upsertOwnedJob(projection.job);
          if (projection.artifact) {
            artifacts[projection.artifact.artifactId] = mergeArtifactSnapshot(
              artifacts[projection.artifact.artifactId],
              projection.artifact,
            );
            linkArtifactIds(event.job_id, [projection.artifact.artifactId]);
          }
          if (projection.artifactIds && projection.artifactIds.length > 0) {
            linkArtifactIds(event.job_id, projection.artifactIds);
          }
          applyProgress(projection.progress);
        } else if (projection.kind === 'job') {
          upsertOwnedJob(projection.job);
          applyProgress(projection.progress);
        } else if (projection.kind === 'progress') {
          applyProgress(projection.progress);
        } else {
          artifacts[projection.artifact.artifactId] = mergeArtifactSnapshot(
            artifacts[projection.artifact.artifactId],
            projection.artifact,
          );
          linkArtifactIds(event.job_id, [projection.artifact.artifactId]);
        }

        return {
          artifacts,
          generationProgressByJob,
          jobOrder,
          jobs,
          ...(ignoredEvents > 0 ? { ignoredEvents: s.ignoredEvents + ignoredEvents } : {}),
          lastSeqByJob: { ...s.lastSeqByJob, [event.job_id]: event.seq },
        };
      });
    },

    cancelJob: async (jobId) => {
      const current = get().pendingActions[jobId];
      if (current && current !== 'refresh') return;

      set((s) => ({ pendingActions: { ...s.pendingActions, [jobId]: 'cancel' } }));
      try {
        const job = await client.cancelPresentationJob(jobId);
        set((s) => ({
          jobs: { ...s.jobs, [jobId]: job },
          pendingActions: { ...s.pendingActions, [jobId]: undefined },
        }));
      } catch (err) {
        set((s) => ({
          clientError: toPresentationError(err),
          pendingActions: { ...s.pendingActions, [jobId]: undefined },
        }));
      }
    },

    deleteJob: async (jobId) => {
      const current = get().pendingActions[jobId];
      if (current && current !== 'refresh') return false;
      set((s) => ({
        clientError: null,
        pendingActions: { ...s.pendingActions, [jobId]: 'delete' },
      }));
      try {
        if (!client.deletePresentationJob)
          throw Object.assign(new Error('Presentation deletion is unavailable'), {
            code: 'PROVIDER_UNAVAILABLE',
          });
        await client.deletePresentationJob(jobId);
        const selectedWasDeleted = get().selectedJobId === jobId;
        if (selectedWasDeleted && typeof window !== 'undefined' && window.sessionStorage) {
          try {
            window.sessionStorage.removeItem('presentation_studio_active_job_id');
          } catch {}
        }
        set((s) => {
          const artifacts = { ...s.artifacts };
          const generationProgressByJob = { ...s.generationProgressByJob };
          const jobs = { ...s.jobs };
          const jobTitles = { ...s.jobTitles };
          const lastSeqByJob = { ...s.lastSeqByJob };
          const pendingActions = { ...s.pendingActions };
          const slots = { ...s.slots };
          const slotRetryPending = { ...s.slotRetryPending };
          const streamStatusByJob = { ...s.streamStatusByJob };
          const artifactIds = new Set(jobs[jobId]?.artifactIds ?? []);
          for (const [artifactId, artifact] of Object.entries(artifacts)) {
            if (artifactIds.has(artifactId) || artifact.metadata?.jobId === jobId) {
              delete artifacts[artifactId];
            }
          }
          for (const key of Object.keys(slots)) {
            if (key.startsWith(`${jobId}:`)) delete slots[key];
          }
          for (const key of Object.keys(slotRetryPending)) {
            if (key.startsWith(`${jobId}:`)) delete slotRetryPending[key];
          }
          delete generationProgressByJob[jobId];
          delete jobs[jobId];
          delete jobTitles[jobId];
          delete lastSeqByJob[jobId];
          delete pendingActions[jobId];
          delete streamStatusByJob[jobId];
          return {
            artifacts,
            generationProgressByJob,
            jobOrder: s.jobOrder.filter((id) => id !== jobId),
            jobs,
            jobTitles,
            lastSeqByJob,
            pendingActions,
            selectedArtifactId: selectedWasDeleted ? null : s.selectedArtifactId,
            selectedJobId: selectedWasDeleted ? null : s.selectedJobId,
            slots,
            slotRetryPending,
            streamStatus: aggregateJobStreamStatus(streamStatusByJob),
            streamStatusByJob,
          };
        });
        return true;
      } catch (error) {
        set((s) => ({
          clientError: toPresentationError(error),
          pendingActions: { ...s.pendingActions, [jobId]: undefined },
        }));
        return false;
      }
    },

    createJob: async (input) => {
      // Re-entrancy guard (C-112-04): avoid duplicate creation if in flight
      if (get().pendingActions['create'] === 'create') return null;

      // Remember the draft (C-74) so a failed create can be resubmitted; the
      // provider error itself is preserved verbatim, never converted to a job.
      set((s) => ({
        clientError: null,
        lastCreateInput: input,
        pendingActions: { ...s.pendingActions, create: 'create' },
      }));
      try {
        const job = await client.createPresentationJob(input);
        if (typeof window !== 'undefined' && window.sessionStorage) {
          try {
            window.sessionStorage.setItem('presentation_studio_active_job_id', job.jobId);
          } catch {}
        }
        const progress = projectGenerationProgress(job);
        set((s) => ({
          artifacts: s.artifacts,
          generationProgressByJob: progress
            ? { ...s.generationProgressByJob, [job.jobId]: progress }
            : s.generationProgressByJob,
          jobOrder: [job.jobId, ...s.jobOrder.filter((id) => id !== job.jobId)],
          jobTitles: { ...s.jobTitles, [job.jobId]: input.title },
          jobs: { ...s.jobs, [job.jobId]: job },
          pendingActions: { ...s.pendingActions, create: undefined },
          selectedArtifactId: null,
          selectedJobId: job.jobId,
        }));
        return job.jobId;
      } catch (err) {
        set((s) => ({
          clientError: toPresentationError(err),
          pendingActions: { ...s.pendingActions, create: undefined },
        }));
        return null;
      }
    },

    dismissError: () => set({ clientError: null }),

    dismissExport: () => set({ exported: null, exportError: null }),

    exportArtifact: async (artifactId, format) => {
      set({ exporting: artifactId, clientError: null, exportError: null });
      try {
        const exported = await client.exportArtifact(artifactId, format);
        // A payload without a usable URI is an honest failure — never fake a
        // download success (C-80).
        if (!exported.uri) {
          set({
            exportError: {
              artifactId,
              code: 'EXPORT_EMPTY_PAYLOAD',
              format,
              message: 'The export finished without downloadable content.',
            },
            exporting: null,
          });
          return;
        }
        set({ exported, exportError: null, exporting: null });
      } catch (err) {
        // Selection, artifacts and draft are untouched — only the error
        // surfaces so the user can retry the same export. The code is also
        // mirrored into `clientError` (C-60 compatibility) while `exportError`
        // carries the retry payload (C-80); the UI suppresses the duplicate
        // generic alert while an export error is showing.
        const info = toPresentationError(err);
        set({
          clientError: info,
          exportError: { artifactId, format, ...info },
          exporting: null,
        });
      }
    },

    refreshArtifacts: async (jobId) => {
      const job = get().jobs[jobId];
      const ids = job?.artifactIds ?? [];
      if (ids.length === 0) return;

      const beforeFetch = get().artifacts;
      const missingIds = ids.filter((id) => needsArtifactHydration(beforeFetch[id]));
      if (missingIds.length === 0) {
        if (!get().selectedArtifactId && (!get().selectedJobId || get().selectedJobId === jobId)) {
          set({ selectedArtifactId: ids[0] });
        }
        return;
      }

      const snapshots = await Promise.all(
        missingIds.map(async (artifactId) => {
          try {
            return await fetchArtifact(artifactId);
          } catch (err) {
            if (!get().clientError) {
              set({ clientError: toPresentationError(err) });
            }
            return null;
          }
        }),
      );

      const newArtifacts: Record<string, ArtifactSnapshot> = {};
      for (const snap of snapshots) {
        if (snap) newArtifacts[snap.artifactId] = snap;
      }

      if (Object.keys(newArtifacts).length > 0) {
        set((s) => {
          const artifacts = { ...s.artifacts };
          for (const [id, snapshot] of Object.entries(newArtifacts)) {
            artifacts[id] = mergeArtifactSnapshot(
              artifacts[id],
              snapshot,
              artifacts[id] !== beforeFetch[id],
            );
          }
          return {
            artifacts,
            selectedArtifactId:
              s.selectedArtifactId ??
              (!s.selectedJobId || s.selectedJobId === jobId ? ids[0] : null),
          };
        });
      }
    },

    /**
     * Re-runs the last failed create draft (C-74/C-76); null without a draft.
     * Re-entrancy guard: an in-flight resubmit can never start a second
     * concurrent create, whatever the UI fires (double Enter/Space/click).
     * The provider error stays visible while in flight and on failure — it is
     * cleared only by a successful recovery, so the Alert (and its disabled
     * in-flight button) never unmounts mid-request.
     */
    resubmitLastInput: async () => {
      if (get().resubmitting) return null;
      const input = get().lastCreateInput;
      if (!input) return null;
      set({ resubmitting: true });
      try {
        const job = await client.createPresentationJob(input);
        set((s) => ({
          artifacts: s.artifacts,
          clientError: null,
          jobOrder: [job.jobId, ...s.jobOrder.filter((id) => id !== job.jobId)],
          jobTitles: { ...s.jobTitles, [job.jobId]: input.title },
          jobs: { ...s.jobs, [job.jobId]: job },
          selectedArtifactId: null,
          selectedJobId: job.jobId,
        }));
        return job.jobId;
      } catch (err) {
        // Preserve (or restore) the structured provider error — never a fake
        // transition; the draft stays so the user can retry or edit.
        set({ clientError: toPresentationError(err) });
        return null;
      } finally {
        set({ resubmitting: false });
      }
    },

    sendMessage: async (jobId, input) => {
      try {
        if (!client.sendPresentationMessage)
          throw Object.assign(new Error('Conversation updates are unavailable'), {
            code: 'PROVIDER_UNAVAILABLE',
          });
        const job = await client.sendPresentationMessage(jobId, input);
        set((s) => ({ jobs: { ...s.jobs, [jobId]: job }, clientError: null }));
        return true;
      } catch (error) {
        set({ clientError: toPresentationError(error) });
        return false;
      }
    },

    restoreJobList: async () => {
      if (!client.listPresentationJobs) return [];
      try {
        const jobs = await client.listPresentationJobs();
        set((s) => ({
          jobs: { ...Object.fromEntries(jobs.map((job) => [job.jobId, job])), ...s.jobs },
          jobOrder: [...new Set([...s.jobOrder, ...jobs.map((job) => job.jobId)])],
          jobTitles: {
            ...Object.fromEntries(
              jobs.filter((job) => job.title).map((job) => [job.jobId, job.title!]),
            ),
            ...s.jobTitles,
          },
        }));
        return jobs.map((job) => job.jobId);
      } catch (error) {
        set({ clientError: toPresentationError(error) });
        return [];
      }
    },

    refreshJob: async (jobId) => {
      if (get().pendingActions[jobId] === 'refresh') return;

      const beforeJob = get().jobs[jobId];
      set((s) => ({ pendingActions: { ...s.pendingActions, [jobId]: 'refresh' } }));
      try {
        const job = await client.getPresentationJob(jobId);
        if (job) {
          const beforeFetch = get().artifacts;
          const newArtifacts: Record<string, ArtifactSnapshot> = {};
          if (job.artifactIds && job.artifactIds.length > 0) {
            const missingIds = job.artifactIds.filter((id) =>
              needsArtifactHydration(beforeFetch[id]),
            );
            if (missingIds.length > 0) {
              const snapshots = await Promise.all(
                missingIds.map(async (id) => {
                  try {
                    return await fetchArtifact(id);
                  } catch (err) {
                    if (!get().clientError) {
                      set({ clientError: toPresentationError(err) });
                    }
                    return null;
                  }
                }),
              );
              for (const snap of snapshots) {
                if (snap) newArtifacts[snap.artifactId] = snap;
              }
            }
          }
          set((s) => {
            const allArtifacts = { ...s.artifacts };
            for (const [id, snapshot] of Object.entries(newArtifacts)) {
              allArtifacts[id] = mergeArtifactSnapshot(
                allArtifacts[id],
                snapshot,
                allArtifacts[id] !== beforeFetch[id],
              );
            }
            const currentJob = s.jobs[jobId];
            const currentTime = Date.parse(currentJob?.updatedAt ?? '');
            const incomingTime = Date.parse(job.updatedAt ?? '');
            const keepCurrent =
              currentJob &&
              (currentTime > incomingTime ||
                (currentJob !== beforeJob && !(incomingTime > currentTime)));
            const latestJob = keepCurrent ? { ...job, ...currentJob } : job;
            const progress = projectGenerationProgress(latestJob);
            const firstId = latestJob.artifactIds?.[0] ?? null;
            const selectedArtifactId =
              s.selectedArtifactId ??
              (!s.selectedJobId || s.selectedJobId === jobId ? firstId : null);
            const currentProgress = s.generationProgressByJob[jobId] ?? {};
            return {
              artifacts: allArtifacts,
              generationProgressByJob: progress
                ? {
                    ...s.generationProgressByJob,
                    [jobId]: {
                      ...currentProgress,
                      ...progress,
                      ...(progress.artifactIds
                        ? {
                            artifactIds: [
                              ...new Set([
                                ...(currentProgress.artifactIds ?? []),
                                ...progress.artifactIds,
                              ]),
                            ],
                          }
                        : {}),
                    },
                  }
                : s.generationProgressByJob,
              jobOrder: s.jobOrder.includes(jobId) ? s.jobOrder : [jobId, ...s.jobOrder],
              jobTitles: latestJob.title
                ? { ...s.jobTitles, [jobId]: latestJob.title }
                : s.jobTitles,
              jobs: { ...s.jobs, [jobId]: latestJob },
              pendingActions: { ...s.pendingActions, [jobId]: undefined },
              selectedArtifactId,
            };
          });
        } else {
          // The job is not reachable: keep the last known honest state and do
          // not fabricate a transition.
          set((s) => ({
            pendingActions: { ...s.pendingActions, [jobId]: undefined },
          }));
        }
      } catch (err) {
        set((s) => ({
          clientError: toPresentationError(err),
          pendingActions: { ...s.pendingActions, [jobId]: undefined },
        }));
      }
    },

    retryJob: async (jobId) => {
      const current = get().pendingActions[jobId];
      if (current && current !== 'refresh') return;

      set((s) => ({ pendingActions: { ...s.pendingActions, [jobId]: 'retry' } }));
      try {
        const job = await client.retryPresentationJob(jobId);
        set((s) => ({
          clientError: null,
          jobs: { ...s.jobs, [jobId]: job },
          pendingActions: { ...s.pendingActions, [jobId]: undefined },
        }));
      } catch (err) {
        set((s) => ({
          clientError: toPresentationError(err),
          pendingActions: { ...s.pendingActions, [jobId]: undefined },
        }));
      }
    },

    selectArtifact: (artifactId) => set({ selectedArtifactId: artifactId }),

    applySlotEvent: (jobId, event) => {
      // C-87 slot projection: per-slot seq idempotency. Unknown/malformed
      // payloads are ignored observably (ignoredEvents) — never a fabricated
      // ready, and prompts are stripped before they can enter the store.
      const data = (event.data ?? {}) as Record<string, unknown>;
      const slotId = typeof data.slotId === 'string' ? data.slotId : null;
      const slideId = typeof data.slideId === 'string' ? data.slideId : null;
      if (!slotId || !slideId) {
        set((s) => ({ ignoredEvents: s.ignoredEvents + 1 }));
        return;
      }
      const key = `${jobId}:${slideId}:${slotId}`;
      const ignoredIncrement = (s: { ignoredEvents: number }): { ignoredEvents: number } => ({
        ignoredEvents: s.ignoredEvents + 1,
      });
      set((s) => {
        const existing = s.slots[key];
        if (existing && event.seq <= existing.lastSeq) return s;

        const rawStatus = typeof data.status === 'string' ? data.status : null;
        const status: PresentationSlotStatus | null =
          rawStatus === 'queued' ||
          rawStatus === 'generating' ||
          rawStatus === 'ready' ||
          rawStatus === 'failed' ||
          rawStatus === 'cancelled'
            ? rawStatus
            : (existing?.status ?? 'queued');

        // A ready status without an artifact id is not trusted (no fabricated
        // ready): it is counted as ignored and leaves the slot untouched.
        const artifactId = typeof data.artifactId === 'string' ? data.artifactId : null;
        if (status === 'ready' && !artifactId && !(existing?.artifactIds.length ?? 0)) {
          return { ...s, ...ignoredIncrement(s) };
        }

        const label =
          typeof data.label === 'string' && data.label.trim().length > 0
            ? data.label
            : (existing?.label ?? slotId);

        const next: PresentationSlotState = {
          artifactIds:
            artifactId && !(existing?.artifactIds ?? []).includes(artifactId)
              ? [...(existing?.artifactIds ?? []), artifactId]
              : (existing?.artifactIds ?? []),
          errorCode:
            status === 'failed'
              ? typeof data.errorCode === 'string'
                ? data.errorCode
                : 'UNKNOWN'
              : null,
          label,
          lastSeq: event.seq,
          slotId,
          slideId,
          status,
        };
        const page = /^slide-(\d+)$/u.exec(slideId)?.[1];
        const slotKeys = Object.keys(s.slots).filter((item) =>
          item.startsWith(`${jobId}:${slideId}:`),
        );
        const ordinal = slotKeys.includes(key) ? slotKeys.indexOf(key) + 1 : slotKeys.length + 1;
        const subject = `${page ? `第 ${page} 页 · ` : ''}第 ${ordinal} 张素材`;
        const activity =
          status === 'generating'
            ? `${subject} · 正在绘画`
            : status === 'ready'
              ? `${subject} · 绘画已完成`
              : status === 'failed'
                ? `${subject} · 绘画未完成`
                : status === 'cancelled'
                  ? `${subject} · 已取消`
                  : undefined;
        const current = s.generationProgressByJob[jobId] ?? {};
        const changed = activity && status !== existing?.status;
        return {
          slots: { ...s.slots, [key]: next },
          ...(changed
            ? {
                generationProgressByJob: {
                  ...s.generationProgressByJob,
                  [jobId]: {
                    ...current,
                    activity,
                    activityHistory: appendActivity(
                      current.activityHistory,
                      activity,
                      `image:${slideId}:${slotId}:${event.seq}`,
                    ),
                  },
                },
              }
            : {}),
        };
      });
    },

    dismissSlotError: (jobId, slideId, slotId) => {
      const key = `${jobId}:${slideId}:${slotId}`;
      set((s) => {
        const slot = s.slots[key];
        if (!slot || slot.errorCode === null) return s;
        return { slots: { ...s.slots, [key]: { ...slot, errorCode: null } } };
      });
    },

    retrySlot: async (jobId, slideId, slotId) => {
      if (!retrySlotAdapter) return false;
      const key = `${jobId}:${slideId}:${slotId}`;
      if (get().slotRetryPending[key]) return false; // re-entrancy guard

      set((s) => ({ slotRetryPending: { ...s.slotRetryPending, [key]: true } }));
      // The slot visibly enters generating while the adapter runs; every other
      // slot, the selection and the composer draft are untouched.
      set((s) => {
        const slot = s.slots[key];
        if (!slot) return s;
        return { slots: { ...s.slots, [key]: { ...slot, status: 'generating' } } };
      });
      try {
        const result = await retrySlotAdapter({ jobId, scopeKey: key, slideId, slotId });
        set((s) => {
          const slot = s.slots[key];
          if (!slot) return { slotRetryPending: { ...s.slotRetryPending, [key]: false } };
          const errorCode = result.status === 'failed' ? (result.errorCode ?? 'UNKNOWN') : null;
          return {
            slotRetryPending: { ...s.slotRetryPending, [key]: false },
            slots: { ...s.slots, [key]: { ...slot, errorCode, status: result.status } },
          };
        });
        return get().slots[key]?.status === 'ready';
      } catch (err) {
        // Adapter-level failure maps to a stable slot error, honest and
        // prompt-free; the user keeps the retry affordance.
        set((s) => {
          const slot = s.slots[key];
          if (!slot) return { slotRetryPending: { ...s.slotRetryPending, [key]: false } };
          return {
            slotRetryPending: { ...s.slotRetryPending, [key]: false },
            slots: {
              ...s.slots,
              [key]: { ...slot, errorCode: toPresentationError(err).code, status: 'failed' },
            },
          };
        });
        return false;
      }
    },

    selectJob: (jobId) => {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        try {
          if (jobId) window.sessionStorage.setItem('presentation_studio_active_job_id', jobId);
          else window.sessionStorage.removeItem('presentation_studio_active_job_id');
        } catch {}
      }
      const job = jobId ? get().jobs[jobId] : undefined;
      const firstArtifact = job?.artifactIds?.[0] ?? null;

      set({
        selectedArtifactId: firstArtifact,
        selectedJobId: jobId,
      });
    },

    setInitialLoading: (loading) => set({ initialLoading: loading }),

    setStreamStatus: (status) => set({ streamStatus: status }),

    setStreamStatusForJob: (jobId, status) => {
      // Idempotent: identical status is a no-op (no subscriber notification).
      set((s) => {
        const current = s.streamStatusByJob[jobId] ?? null;
        if (current === status) return s;

        const next = { ...s.streamStatusByJob };
        if (status === null) {
          delete next[jobId];
        } else {
          next[jobId] = status;
        }
        return {
          streamStatus: aggregateJobStreamStatus(next),
          streamStatusByJob: next,
        };
      });
    },
  }));
};

/**
 * Shared singleton used by the rendered `/presentation` route. It talks to the
 * real HTTP seam; provider failures are surfaced, never faked.
 */
export const usePresentationStudioStore = createPresentationStudioStore();

export const isPresentationJobTerminal = terminal;
