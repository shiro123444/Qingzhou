import type {
  ArtifactSnapshot,
  ExportResult,
  PluginDescriptor,
  PluginRuntimeState,
  PresentationExportFormat,
  PresentationJob,
  PresentationJobInput,
  PresentationMessageInput,
  ResumeRunInput,
  RunSnapshot,
  RuntimeEvent,
  StartRunInput,
} from '../../../packages/runtime-contracts/src/index';
import { RUNTIME_PROTOCOL_VERSION } from '../../../packages/runtime-contracts/src/index';

const RUNTIME_ENDPOINTS = {
  cancelRun: (runId: string) => `/api/runtime/v1/runs/${encodeURIComponent(runId)}/cancel`,
  mountPlugin: (id: string) => `/api/runtime/v1/plugins/${encodeURIComponent(id)}/mount`,
  plugins: '/api/runtime/v1/plugins',
  presentationArtifact: (artifactId: string) =>
    `/api/runtime/presentation/artifacts/${encodeURIComponent(artifactId)}`,
  presentationExport: '/api/runtime/presentation/artifacts/export',
  presentationJob: (jobId: string) => `/api/runtime/presentation/jobs/${encodeURIComponent(jobId)}`,
  presentationJobCancel: (jobId: string) =>
    `/api/runtime/presentation/jobs/${encodeURIComponent(jobId)}/cancel`,
  presentationJobEvents: (jobId: string, afterSeq?: number) => {
    const base = `/api/runtime/presentation/jobs/${encodeURIComponent(jobId)}/events`;
    const query = typeof afterSeq === 'number' ? `?after_seq=${afterSeq}` : '';
    return `${base}${query}`;
  },
  presentationJobRetry: (jobId: string) =>
    `/api/runtime/presentation/jobs/${encodeURIComponent(jobId)}/retry`,
  presentationJobs: '/api/runtime/presentation/jobs',
  /** C-96: material-slot image generation seam for one presentation job. */
  presentationImageGeneration: (jobId: string) =>
    `/api/runtime/presentation/image-generation?jobId=${encodeURIComponent(jobId)}`,
  reloadPlugin: (id: string) => `/api/runtime/v1/plugins/${encodeURIComponent(id)}/reload`,
  resumeRun: (runId: string) => `/api/runtime/v1/runs/${encodeURIComponent(runId)}/resume`,
  run: (runId: string) => `/api/runtime/v1/runs/${encodeURIComponent(runId)}`,
  runEvents: (runId: string, afterSeq?: number) => {
    const base = `/api/runtime/v1/runs/${encodeURIComponent(runId)}/events`;
    const query = typeof afterSeq === 'number' ? `?after_seq=${afterSeq}` : '';
    return `${base}${query}`;
  },
  runs: '/api/runtime/v1/runs',
  unmountPlugin: (id: string) => `/api/runtime/v1/plugins/${encodeURIComponent(id)}/unmount`,
};

export interface RuntimeClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  getHeaders?: () => HeadersInit | Promise<HeadersInit>;
}

export interface SubscribeOptions {
  deduplicate?: boolean;
  onSeqReceived?: (seq: number) => void;
  signal?: AbortSignal;
}

/**
 * Presentation transport seam (C-15-L / C-60). The frontend only depends on
 * these request methods — never on server classes, paths or database models.
 * `RuntimeClientImpl` satisfies this type structurally; tests and demos inject
 * a fake implementation.
 */
export type RuntimePresentationClient = Pick<
  RuntimeClient,
  | 'createPresentationJob'
  | 'getPresentationJob'
  | 'cancelPresentationJob'
  | 'retryPresentationJob'
  | 'getArtifact'
  | 'exportArtifact'
> &
  Partial<
    Pick<
      RuntimeClient,
      | 'createImageGeneration'
      | 'deletePresentationJob'
      | 'downloadArtifact'
      | 'sendPresentationMessage'
      | 'listPresentationJobs'
    >
  >;

/**
 * Wire-safe job event for presentation jobs. Freezes the seam shape for
 * SSE/after_seq resume (C-60): `job_id` identifies the job, `seq` is strictly
 * increasing per job and `after_seq` replay resumes from the highest seen seq.
 */
export interface PresentationJobEvent {
  data: unknown;
  job_id: string;
  protocol_version: typeof RUNTIME_PROTOCOL_VERSION;
  seq: number;
  type: string;
}

export interface SubscribePresentationJobOptions {
  /** Resume from the highest already-seen sequence (>= 0). */
  afterSeq?: number;
  /** Emitted for every received sequence — used to persist `last seq`. */
  onSeqReceived?: (seq: number) => void;
  signal?: AbortSignal;
}

/** Client opt-in method for the presentation job event stream. */
export type RuntimePresentationStreamClient = RuntimePresentationClient & {
  subscribePresentationJob?: (
    jobId: string,
    options?: SubscribePresentationJobOptions,
  ) => AsyncIterable<PresentationJobEvent>;
};

/* ------------------------------------------------------------------------- *
 * C-96: material-slot image generation request seam. The wire request carries
 * only job/slot identifiers and generation parameters — prompts (if any) stay
 * inside the slot descriptors supplied by the caller and never enter Zustand,
 * traces, logs, SSE streams or client state.
 * ------------------------------------------------------------------------- */
/** One slot to (re)generate. `prompt` lives here and only inside the body. */
export interface ImageGenerationSlotRequest {
  /** Caller-supplied idempotency key; repeated retries may reuse it. */
  idempotencyKey?: string;
  /** Generation prompt for this slot; transported but never surfaced in UI. */
  prompt?: string;
  /** Opaque vendor-neutral quality hint. */
  quality?: string;
  /** Requested pixel size token (e.g. `1024x1024`), provider-scoped. */
  size?: string;
  /** The slide this slot belongs to. */
  slideId: string;
  /** Stable slot identifier from the generation plan. */
  slotId: string;
}

/** Wire-safe request for (re)generating material slots of one job. */
export interface CreateImageGenerationInput {
  /** The presentation job that owns the slots. */
  jobId: string;
  /** Slots to generate; order is preserved for the server plan. */
  slots: readonly ImageGenerationSlotRequest[];
}

/** Wire-safe accepted response: the server echoes plan acceptance per slot. */
export interface CreateImageGenerationResult {
  /** The job that owns the accepted generation plan. */
  jobId: string;
  /** Per-slot echo in the requested order. */
  slots: readonly {
    slotId: string;
    slideId: string;
    status: 'accepted' | 'failed';
    /** Stable error code when rejected; never a prompt. */
    errorCode?: string;
  }[];
}

export interface RuntimeClient {
  cancelPresentationJob: (
    jobId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<PresentationJob>;
  cancelRun: (runId: string, options?: { signal?: AbortSignal }) => Promise<void>;
  createImageGeneration: (
    input: CreateImageGenerationInput,
    options?: { signal?: AbortSignal },
  ) => Promise<CreateImageGenerationResult>;
  createPresentationJob: (
    input: PresentationJobInput,
    options?: { signal?: AbortSignal },
  ) => Promise<PresentationJob>;
  deletePresentationJob: (jobId: string, options?: { signal?: AbortSignal }) => Promise<void>;
  downloadArtifact: (artifactId: string, options?: { signal?: AbortSignal }) => Promise<Blob>;
  exportArtifact: (
    artifactId: string,
    format: PresentationExportFormat,
    options?: { signal?: AbortSignal },
  ) => Promise<ExportResult>;
  getArtifact: (
    artifactId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ArtifactSnapshot | null>;
  getPresentationJob: (
    jobId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<PresentationJob | null>;
  getRun: (runId: string, options?: { signal?: AbortSignal }) => Promise<RunSnapshot | null>;
  listPlugins: (options?: { signal?: AbortSignal }) => Promise<PluginDescriptor[]>;
  listPresentationJobs?: () => Promise<PresentationJob[]>;
  mountPlugin: (
    id: string,
    config?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<PluginRuntimeState>;
  reloadPlugin: (id: string, options?: { signal?: AbortSignal }) => Promise<PluginRuntimeState>;
  resumeRun: (
    runId: string,
    input: ResumeRunInput,
    options?: { signal?: AbortSignal },
  ) => Promise<RunSnapshot>;
  retryPresentationJob: (
    jobId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<PresentationJob>;
  sendPresentationMessage: (
    jobId: string,
    input: PresentationMessageInput,
  ) => Promise<PresentationJob>;
  startRun: (input: StartRunInput, options?: { signal?: AbortSignal }) => Promise<RunSnapshot>;
  subscribe: (
    runId: string,
    afterSeq?: number,
    options?: SubscribeOptions,
  ) => AsyncIterable<RuntimeEvent>;
  subscribePresentationJob: (
    jobId: string,
    options?: SubscribePresentationJobOptions,
  ) => AsyncIterable<PresentationJobEvent>;
  unmountPlugin: (id: string, options?: { signal?: AbortSignal }) => Promise<PluginRuntimeState>;
}

export class RuntimeClientImpl implements RuntimeClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly getHeaders?: () => HeadersInit | Promise<HeadersInit>;

  constructor(options: RuntimeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.getHeaders = options.getHeaders;
  }

  private resolveUrl(path: string): string {
    if (!this.baseUrl) return path;
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${cleanPath}`;
  }

  private async prepareHeaders(customHeaders?: HeadersInit): Promise<Headers> {
    const headers = new Headers(customHeaders);
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (this.getHeaders) {
      const extra = await this.getHeaders();
      const extraHeaders = new Headers(extra);
      extraHeaders.forEach((value, key) => {
        if (!headers.has(key)) {
          headers.set(key, value);
        }
      });
    }
    return headers;
  }

  async startRun(input: StartRunInput, options?: { signal?: AbortSignal }): Promise<RunSnapshot> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.runs);
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      body: JSON.stringify(input),
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to start run (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as RunSnapshot;
  }

  async getRun(runId: string, options?: { signal?: AbortSignal }): Promise<RunSnapshot | null> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.run(runId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'GET',
      signal: options?.signal,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to get run ${runId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as RunSnapshot;
  }

  async cancelRun(runId: string, options?: { signal?: AbortSignal }): Promise<void> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.cancelRun(runId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to cancel run ${runId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }
  }

  async resumeRun(
    runId: string,
    input: ResumeRunInput,
    options?: { signal?: AbortSignal },
  ): Promise<RunSnapshot> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.resumeRun(runId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      body: JSON.stringify(input),
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to resume run ${runId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as RunSnapshot;
  }

  async listPlugins(options?: { signal?: AbortSignal }): Promise<PluginDescriptor[]> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.plugins);
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'GET',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to list plugins (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as PluginDescriptor[];
  }

  async mountPlugin(
    id: string,
    config?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<PluginRuntimeState> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.mountPlugin(id));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      body: config !== undefined ? JSON.stringify(config) : undefined,
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to mount plugin ${id} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    const data = await response.json();
    return (data?.state ?? data) as PluginRuntimeState;
  }

  async unmountPlugin(id: string, options?: { signal?: AbortSignal }): Promise<PluginRuntimeState> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.unmountPlugin(id));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to unmount plugin ${id} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    const data = await response.json();
    return (data?.state ?? data) as PluginRuntimeState;
  }

  async reloadPlugin(id: string, options?: { signal?: AbortSignal }): Promise<PluginRuntimeState> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.reloadPlugin(id));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to reload plugin ${id} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    const data = await response.json();
    return (data?.state ?? data) as PluginRuntimeState;
  }

  // --- Presentation Client Methods ---

  /**
   * C-96: requests (re)generation of material slots for one presentation job.
   * POST `/api/runtime/presentation/image-generation?jobId=…`. The body holds
   * only job/slot identifiers and generation parameters; scope is resolved by
   * the server session — nothing here can forge a userId/sessionId.
   */
  async createImageGeneration(
    input: CreateImageGenerationInput,
    options?: { signal?: AbortSignal },
  ): Promise<CreateImageGenerationResult> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationImageGeneration(input.jobId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      body: JSON.stringify(input),
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to create image generation (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as CreateImageGenerationResult;
  }

  async createPresentationJob(
    input: PresentationJobInput,
    options?: { signal?: AbortSignal },
  ): Promise<PresentationJob> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationJobs);
    const headers = await this.prepareHeaders();
    // Keep the wire contract total at the HTTP boundary. The studio normally
    // supplies these fields, but a stale template or a browser replay can
    // otherwise serialize an incomplete payload and the server can only
    // report the opaque `notebookId, title and sourceVersionIds` error.
    const raw = input && typeof input === 'object' ? (input as Partial<PresentationJobInput>) : {};
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
    const optionsPrompt =
      raw.options && typeof raw.options.prompt === 'string' ? raw.options.prompt.trim() : '';
    const safeInput: PresentationJobInput = {
      ...raw,
      notebookId:
        typeof raw.notebookId === 'string' && raw.notebookId.trim()
          ? raw.notebookId.trim()
          : 'studio',
      // Preserve an explicitly supplied array verbatim so the server remains
      // the authority for malformed reference IDs; only an omitted field gets
      // the prompt-only default of an empty list.
      sourceVersionIds: Array.isArray(raw.sourceVersionIds) ? raw.sourceVersionIds : [],
      title:
        typeof raw.title === 'string' && raw.title.trim()
          ? raw.title.trim()
          : (prompt || optionsPrompt).split(/\r?\n/, 1)[0]?.slice(0, 120) || '智能演示文稿',
      ...(prompt || optionsPrompt ? { prompt: prompt || optionsPrompt } : {}),
    };
    const response = await this.fetcher(url, {
      body: JSON.stringify(safeInput),
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to create presentation job (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as PresentationJob;
  }

  async listPresentationJobs(): Promise<PresentationJob[]> {
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(
      this.resolveUrl('/api/runtime/presentation/tools/presentation.job.list'),
      { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' },
    );
    if (!response.ok) throw new Error(`Failed to restore presentations (${response.status})`);
    return ((await response.json()) as { jobs: PresentationJob[] }).jobs;
  }

  async getPresentationJob(
    jobId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PresentationJob | null> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationJob(jobId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'GET',
      signal: options?.signal,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to get presentation job ${jobId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as PresentationJob;
  }

  async sendPresentationMessage(
    jobId: string,
    input: PresentationMessageInput,
  ): Promise<PresentationJob> {
    const response = await this.fetcher(
      this.resolveUrl(`${RUNTIME_ENDPOINTS.presentationJob(jobId)}/messages`),
      {
        method: 'POST',
        headers: await this.prepareHeaders(),
        body: JSON.stringify(input),
      },
    );
    if (!response.ok)
      throw new Error(
        `Failed to send presentation message (${response.status}): ${await response.text()}`,
      );
    return (await response.json()) as PresentationJob;
  }

  async deletePresentationJob(jobId: string, options?: { signal?: AbortSignal }): Promise<void> {
    const response = await this.fetcher(this.resolveUrl(RUNTIME_ENDPOINTS.presentationJob(jobId)), {
      headers: await this.prepareHeaders(),
      method: 'DELETE',
      signal: options?.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to delete presentation job ${jobId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }
  }

  async cancelPresentationJob(
    jobId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PresentationJob> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationJobCancel(jobId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to cancel presentation job ${jobId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as PresentationJob;
  }

  async retryPresentationJob(
    jobId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PresentationJob> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationJobRetry(jobId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to retry presentation job ${jobId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as PresentationJob;
  }

  async getArtifact(
    artifactId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ArtifactSnapshot | null> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationArtifact(artifactId));
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      headers,
      method: 'GET',
      signal: options?.signal,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to get artifact ${artifactId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return (await response.json()) as ArtifactSnapshot;
  }

  async downloadArtifact(artifactId: string, options?: { signal?: AbortSignal }): Promise<Blob> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationArtifact(artifactId));
    const headers = await this.prepareHeaders({
      Accept: 'application/octet-stream',
    });
    const response = await this.fetcher(url, {
      headers,
      method: 'GET',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to download artifact ${artifactId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    return response.blob();
  }

  async exportArtifact(
    artifactId: string,
    format: PresentationExportFormat,
    options?: { signal?: AbortSignal },
  ): Promise<ExportResult> {
    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationExport);
    const headers = await this.prepareHeaders();
    const response = await this.fetcher(url, {
      body: JSON.stringify({ artifactId, format }),
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to export artifact ${artifactId} (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    const result = (await response.json()) as ExportResult;
    if (!result || typeof result.uri !== 'string' || !result.uri.trim()) {
      throw new Error(`Export result returned an empty URI for artifact ${artifactId}`);
    }

    return result;
  }

  // --- SSE Stream Subscription ---

  async *subscribe(
    runId: string,
    afterSeq?: number,
    options?: SubscribeOptions,
  ): AsyncIterable<RuntimeEvent> {
    const deduplicate = options?.deduplicate ?? true;
    const seenSeqs = new Set<number>();
    let maxSeenSeq = typeof afterSeq === 'number' ? afterSeq : -1;

    const url = this.resolveUrl(RUNTIME_ENDPOINTS.runEvents(runId, afterSeq));
    const headers = await this.prepareHeaders({
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });

    const response = await this.fetcher(url, {
      headers,
      method: 'GET',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to subscribe to run ${runId} events (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let eventDataLines: string[] = [];
    let eventIdSeq: number | undefined;

    const processRawEvent = function* (rawData: string, idSeq?: number): Generator<RuntimeEvent> {
      try {
        const parsed = JSON.parse(rawData) as RuntimeEvent;
        if (typeof parsed.seq !== 'number' && typeof idSeq === 'number') {
          parsed.seq = idSeq;
        }
        const seq = parsed.seq;
        if (typeof seq === 'number') {
          if (deduplicate) {
            if (seenSeqs.has(seq) || (typeof afterSeq === 'number' && seq <= afterSeq)) {
              return;
            }
            seenSeqs.add(seq);
          }
          if (seq > maxSeenSeq) {
            maxSeenSeq = seq;
          }
          options?.onSeqReceived?.(seq);
        }
        yield parsed;
      } catch (err) {
        console.warn('[RuntimeClient] Failed to parse SSE event data:', rawData, err);
      }
    };

    try {
      while (true) {
        if (options?.signal?.aborted) {
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r\n|\r|\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim() === '') {
            // Dispatch event when empty line encountered
            if (eventDataLines.length > 0) {
              const rawData = eventDataLines.join('\n');
              const currentIdSeq = eventIdSeq;
              eventDataLines = [];
              eventIdSeq = undefined;
              for (const ev of processRawEvent(rawData, currentIdSeq)) {
                yield ev;
              }
            }
          } else if (line.startsWith('data:')) {
            eventDataLines.push(line.slice(5).trimStart());
          } else if (line.startsWith('id:')) {
            const rawId = line.slice(3).trim();
            const parsedSeq = Number.parseInt(rawId, 10);
            if (!Number.isNaN(parsedSeq)) {
              eventIdSeq = parsedSeq;
            }
          } else if (line.startsWith(':')) {
            // SSE comment / ping, ignore
          }
        }
      }

      // Flush remaining buffer if stream closed without trailing newline
      if (buffer.trim() !== '' && buffer.startsWith('data:')) {
        eventDataLines.push(buffer.slice(5).trimStart());
      }
      if (eventDataLines.length > 0) {
        const rawData = eventDataLines.join('\n');
        const currentIdSeq = eventIdSeq;
        for (const ev of processRawEvent(rawData, currentIdSeq)) {
          yield ev;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // --- Presentation Job SSE Stream (C-62) ---

  /**
   * Streams presentation job events from C-61's SSE route with strict
   * wire validation:
   * - GET `/api/runtime/presentation/jobs/:jobId/events?after_seq=N`
   * - standard `data:` frames, multi-line frames, comments/blank frames,
   *   frames split across chunks
   * - every event must carry `protocol_version: 'runtime.v1'`, the requested
   *   `job_id`, a positive integer `seq` and a non-empty `type`
   * - events with `seq <= afterSeq` and repeat seqs are dropped idempotently;
   *   `onSeqReceived` still reports the highest observed seq (for reconnect)
   * - `AbortSignal` cancels fetch and reader; non-2xx / invalid JSON or shape /
   *   stream errors throw recognizable errors — no synthetic completed event
   */
  async *subscribePresentationJob(
    jobId: string,
    options?: SubscribePresentationJobOptions,
  ): AsyncIterable<PresentationJobEvent> {
    const afterSeq = options?.afterSeq;
    const seenSeqs = new Set<number>();
    let maxSeenSeq = typeof afterSeq === 'number' ? afterSeq : -1;

    const url = this.resolveUrl(RUNTIME_ENDPOINTS.presentationJobEvents(jobId, afterSeq));
    const headers = await this.prepareHeaders({
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });

    const response = await this.fetcher(url, {
      headers,
      method: 'GET',
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to subscribe to presentation job ${jobId} events (${response.status} ${response.statusText}): ${errorText}`,
      );
    }

    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let dataLines: string[] = [];

    const parseEvent = (rawData: string): PresentationJobEvent => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawData);
      } catch {
        throw new Error(
          `[RuntimeClient] Presentation SSE: invalid JSON for job ${jobId}: ${rawData.slice(0, 128)}`,
        );
      }
      const candidate = parsed as Partial<PresentationJobEvent> | null;
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        candidate.protocol_version !== RUNTIME_PROTOCOL_VERSION ||
        candidate.job_id !== jobId ||
        typeof candidate.seq !== 'number' ||
        !Number.isSafeInteger(candidate.seq) ||
        candidate.seq < 1 ||
        typeof candidate.type !== 'string' ||
        candidate.type.length === 0
      ) {
        throw new Error(`[RuntimeClient] Presentation SSE: invalid event shape for job ${jobId}`);
      }
      return candidate as PresentationJobEvent;
    };

    const abort = options?.signal;
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
    };
    abort?.addEventListener('abort', onAbort, { once: true });

    try {
      while (true) {
        if (abort?.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r\n|\r|\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim() === '') {
            if (dataLines.length === 0) continue;
            const event = parseEvent(dataLines.join('\n'));
            dataLines = [];
            // Highest observed seq is always reported (reconnect/resume hint),
            // even for events dropped by after_seq/repeat filtering.
            options?.onSeqReceived?.(event.seq);
            if (typeof afterSeq === 'number' && event.seq <= afterSeq) continue;
            if (seenSeqs.has(event.seq)) continue;
            seenSeqs.add(event.seq);
            if (event.seq > maxSeenSeq) maxSeenSeq = event.seq;
            yield event;
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          } else if (line.startsWith(':')) {
            // SSE comment / heartbeat, ignore
          }
          // `id:` / `event:` / `retry:` frames are not part of the frozen wire
          // shape — the event payload itself carries the authoritative fields.
        }
      }

      // Flush a trailing partial event (stream closed without a blank line).
      if (buffer.trim() !== '' && buffer.startsWith('data:')) {
        dataLines.push(buffer.slice(5).trimStart());
      }
      if (dataLines.length > 0) {
        const event = parseEvent(dataLines.join('\n'));
        options?.onSeqReceived?.(event.seq);
        if (typeof afterSeq === 'number' && event.seq <= afterSeq) return;
        if (seenSeqs.has(event.seq)) return;
        yield event;
      }
    } finally {
      abort?.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
  }
}

export const runtimeClient = new RuntimeClientImpl();
