import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

import type { RunError } from './run';

export type ArtifactStatus = 'pending' | 'ready' | 'failed';

export interface ArtifactSnapshot {
  readonly artifactId: string;
  readonly createdAt: string;
  readonly metadata?: Record<string, unknown>;
  readonly mimeType?: string;
  readonly name?: string;
  readonly sizeBytes?: number;
  readonly status: ArtifactStatus;
  readonly type: string;
  readonly updatedAt?: string;
  readonly uri?: string;
}

export interface PresentationJobInput {
  readonly aspectRatio?: string;
  readonly language?: string;
  readonly notebookId: string;
  readonly options?: Record<string, unknown>;
  readonly prompt?: string;
  readonly slideCount?: number;
  readonly sourceVersionIds: string[];
  readonly template?: string;
  readonly title: string;
}

export type PresentationJobState =
  'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled';

export interface PresentationJob {
  readonly artifactIds?: string[];
  readonly createdAt: string;
  readonly error?: RunError;
  readonly jobId: string;
  readonly state: PresentationJobState;
  readonly updatedAt: string;
}

export type PresentationExportFormat = 'pptx' | 'svg' | 'pdf' | 'quality-report';

export interface ExportResult {
  readonly artifactId: string;
  readonly format: PresentationExportFormat;
  readonly mimeType?: string;
  readonly uri?: string;
}

export interface PresentationPort {
  cancelJob: (jobId: string) => Promise<PresentationJob>;
  createJob: (input: PresentationJobInput) => Promise<PresentationJob>;
  exportArtifact: (artifactId: string, format: PresentationExportFormat) => Promise<ExportResult>;
  getArtifact: (artifactId: string) => Promise<ArtifactSnapshot | null>;
  getJob: (jobId: string) => Promise<PresentationJob | null>;
  retryJob: (jobId: string) => Promise<PresentationJob>;
}

/** Server-only extension for adapters that can retrieve artifact bytes. */
export interface PresentationBinaryPort extends PresentationPort {
  readArtifactBytes: (artifactId: string) => Promise<Uint8Array | null>;
}

export interface PresentationRunnerArtifact {
  readonly bytes: Uint8Array;
  readonly mimeType?: string;
  readonly name?: string;
  readonly path: string;
  readonly type?: string;
}

export interface PresentationRunnerResult {
  readonly artifacts?: readonly PresentationRunnerArtifact[];
  readonly exitCode: number;
  readonly outputBytes?: number;
  readonly stderr?: string;
  readonly stdout?: string;
}

export interface PresentationRunnerInputArtifact {
  readonly artifactId: string;
  readonly bytes: Uint8Array;
  readonly path: string;
}

export type PresentationRunnerOperation = 'create' | 'export';

export interface PresentationRunnerRequest {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly inputArtifact?: PresentationRunnerInputArtifact;
  readonly jobId: string;
  readonly maxOutputBytes: number;
  readonly operation: PresentationRunnerOperation;
  readonly provider: string;
  readonly shell: false;
  readonly timeoutMs: number;
}

export interface PresentationRunnerProcess {
  /** The injected runner must terminate its process group here. */
  cancel: () => void | Promise<void>;
  readonly result: Promise<PresentationRunnerResult>;
}

export interface PresentationRunner {
  readonly id: string;
  spawn: (request: PresentationRunnerRequest) => PresentationRunnerProcess;
}

export interface PresentationWorkspace {
  cleanup: () => void | Promise<void>;
  readonly path: string;
}

export type PresentationWorkspaceFactory = (
  jobId: string,
) => PresentationWorkspace | Promise<PresentationWorkspace>;

export interface PresentationCommandContext {
  readonly artifactId?: string;
  readonly format?: PresentationExportFormat;
  readonly input?: PresentationJobInput;
  readonly jobId: string;
  readonly operation: PresentationRunnerOperation;
  readonly workspacePath: string;
}

export type PresentationArgsBuilder = (context: PresentationCommandContext) => readonly string[];

export interface PptMasterAdapterOptions {
  readonly allowedRunnerIds?: readonly string[];
  readonly buildArgs?: PresentationArgsBuilder;
  readonly idFactory?: () => string;
  readonly maxOutputBytes?: number;
  readonly now?: () => string;
  readonly provider?: string;
  readonly runner?: PresentationRunner;
  readonly timeoutMs?: number;
  readonly workspaceFactory?: PresentationWorkspaceFactory;
}

export type PresentationErrorCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'PRESENTATION_NOT_FOUND'
  | 'PRESENTATION_INVALID'
  | 'PRESENTATION_RUNNER_NOT_ALLOWED'
  | 'PRESENTATION_TIMEOUT'
  | 'PRESENTATION_OUTPUT_LIMIT'
  | 'PRESENTATION_PATH_OUT_OF_SCOPE'
  | 'PPT_MASTER_FAILED'
  | 'PPTX_INVALID'
  | 'PRESENTATION_CANCEL_FAILED';

export interface PresentationErrorDetails {
  readonly artifactId?: string;
  readonly cause?: unknown;
  readonly jobId?: string;
  readonly path?: string;
}

export class PresentationError extends Error {
  public readonly jobId?: string;
  public readonly artifactId?: string;
  public readonly path?: string;
  public readonly cause?: unknown;

  constructor(
    public readonly code: PresentationErrorCode,
    message: string,
    details: PresentationErrorDetails = {},
  ) {
    super(message);
    this.name = 'PresentationError';
    this.jobId = details.jobId;
    this.artifactId = details.artifactId;
    this.path = details.path;
    this.cause = details.cause;
  }
}

interface StoredJob {
  artifactIds?: string[];
  cancelRequested: boolean;
  readonly createdAt: string;
  error?: RunError;
  inFlight?: Promise<PresentationJob>;
  readonly input: PresentationJobInput;
  readonly jobId: string;
  process?: PresentationRunnerProcess;
  state: PresentationJobState;
  updatedAt: string;
  workspace?: PresentationWorkspace;
}

interface StoredArtifact extends ArtifactSnapshot {
  readonly bytes: Uint8Array;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MIME_BY_FORMAT: Readonly<Record<PresentationExportFormat, string>> = {
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'svg': 'image/svg+xml',
  'pdf': 'application/pdf',
  'quality-report': 'application/json',
};

let adapterSequence = 0;

const cloneInput = (input: PresentationJobInput): PresentationJobInput => ({
  ...input,
  sourceVersionIds: [...input.sourceVersionIds],
  options: input.options ? { ...input.options } : undefined,
});

const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeJson(nested)]),
    );
  }
  return value;
};

/** Stable UTF-8 input payload written by the runner before a create spawn. */
export const serializePresentationInput = (input: PresentationJobInput): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(canonicalizeJson(cloneInput(input))));

const cloneJob = (job: StoredJob): PresentationJob => ({
  jobId: job.jobId,
  state: job.state,
  artifactIds: job.artifactIds ? [...job.artifactIds] : undefined,
  error: job.error ? { ...job.error } : undefined,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
});

const cloneArtifact = (artifact: StoredArtifact): ArtifactSnapshot => ({
  artifactId: artifact.artifactId,
  type: artifact.type,
  name: artifact.name,
  mimeType: artifact.mimeType,
  sizeBytes: artifact.sizeBytes,
  status: artifact.status,
  uri: artifact.uri,
  metadata: artifact.metadata ? { ...artifact.metadata } : undefined,
  createdAt: artifact.createdAt,
  updatedAt: artifact.updatedAt,
});

const validateLimit = (value: number | undefined, fallback: number, path: string): number => {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new PresentationError('PRESENTATION_INVALID', `${path} must be a positive integer`, {
      path,
    });
  }
  return limit;
};

const requireText = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PresentationError('PRESENTATION_INVALID', `${path} must be non-empty`, { path });
  }
  return value;
};

const validateInput = (input: PresentationJobInput): PresentationJobInput => {
  requireText(input.notebookId, 'notebookId');
  requireText(input.title, 'title');
  if (!Array.isArray(input.sourceVersionIds)) {
    throw new PresentationError('PRESENTATION_INVALID', 'sourceVersionIds must be an array', {
      path: 'sourceVersionIds',
    });
  }
  input.sourceVersionIds.forEach((value, index) =>
    requireText(value, `sourceVersionIds[${index}]`),
  );
  if (
    input.slideCount !== undefined &&
    (!Number.isInteger(input.slideCount) || input.slideCount < 1)
  ) {
    throw new PresentationError('PRESENTATION_INVALID', 'slideCount must be a positive integer', {
      path: 'slideCount',
    });
  }
  return cloneInput(input);
};

const defaultArgs: PresentationArgsBuilder = (context) => {
  if (context.operation === 'create') {
    return [
      'generate',
      '--job-id',
      context.jobId,
      '--workspace',
      context.workspacePath,
      '--input-file',
      join(context.workspacePath, 'input.json'),
    ];
  }
  return [
    'export',
    '--job-id',
    context.jobId,
    '--workspace',
    context.workspacePath,
    '--input-file',
    join(context.workspacePath, 'input.pptx'),
    '--artifact-id',
    context.artifactId ?? '',
    '--format',
    context.format ?? '',
  ];
};

const defaultWorkspaceFactory: PresentationWorkspaceFactory = async (jobId) => {
  const safeJobId = jobId.replaceAll(/[^\w-]/g, '_');
  const path = await mkdtemp(join(tmpdir(), `lobehub-presentation-${safeJobId}-`));
  return {
    path,
    cleanup: () => rm(path, { force: true, recursive: true }),
  };
};

const toBytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const outputBytesOf = (result: PresentationRunnerResult): number => {
  const reportedBytes =
    result.outputBytes ?? toBytes(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  const artifactBytes = (result.artifacts ?? []).reduce(
    (total, artifact) => total + artifact.bytes.byteLength,
    0,
  );
  return Math.max(reportedBytes, artifactBytes);
};

const isPresentationFormat = (value: unknown): value is PresentationExportFormat =>
  value === 'pptx' || value === 'svg' || value === 'pdf' || value === 'quality-report';

const isProviderError = (error: unknown): error is PresentationError =>
  error instanceof PresentationError &&
  (error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'PRESENTATION_RUNNER_NOT_ALLOWED');

const asRunError = (error: unknown): RunError => {
  if (error instanceof PresentationError) {
    return {
      code: error.code,
      message: error.message,
      details: {
        jobId: error.jobId,
        artifactId: error.artifactId,
        path: error.path,
        cause: error.cause instanceof Error ? error.cause.message : error.cause,
      },
    };
  }
  if (error instanceof Error) return { code: 'PPT_MASTER_FAILED', message: error.message };
  return { code: 'PPT_MASTER_FAILED', message: String(error) };
};

const read16 = (bytes: Uint8Array, offset: number): number =>
  bytes[offset]! | (bytes[offset + 1]! << 8);

const signatureAt = (bytes: Uint8Array, offset: number, signature: readonly number[]): boolean =>
  signature.every((value, index) => bytes[offset + index] === value);

const isPptxZip = (bytes: Uint8Array): boolean => {
  let hasZipRecord = false;
  let hasContentTypes = false;
  const decoder = new TextDecoder();

  for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
    if (signatureAt(bytes, offset, [0x50, 0x4b, 0x03, 0x04])) {
      hasZipRecord = true;
      if (offset + 30 > bytes.length) continue;
      const nameLength = read16(bytes, offset + 26);
      const extraLength = read16(bytes, offset + 28);
      const nameStart = offset + 30;
      if (nameStart + nameLength + extraLength > bytes.length) continue;
      if (
        decoder.decode(bytes.slice(nameStart, nameStart + nameLength)) === '[Content_Types].xml'
      ) {
        hasContentTypes = true;
      }
    }

    if (signatureAt(bytes, offset, [0x50, 0x4b, 0x01, 0x02])) {
      hasZipRecord = true;
      if (offset + 46 > bytes.length) continue;
      const nameLength = read16(bytes, offset + 28);
      const extraLength = read16(bytes, offset + 30);
      const commentLength = read16(bytes, offset + 32);
      const nameStart = offset + 46;
      if (nameStart + nameLength + extraLength + commentLength > bytes.length) continue;
      if (
        decoder.decode(bytes.slice(nameStart, nameStart + nameLength)) === '[Content_Types].xml'
      ) {
        hasContentTypes = true;
      }
    }

    if (signatureAt(bytes, offset, [0x50, 0x4b, 0x05, 0x06])) hasZipRecord = true;
  }

  return hasZipRecord && hasContentTypes;
};

const mimeForArtifact = (
  format: PresentationExportFormat,
  artifact: PresentationRunnerArtifact,
): string => artifact.mimeType ?? MIME_BY_FORMAT[format];

export class PptMasterAdapter implements PresentationBinaryPort {
  private readonly jobs = new Map<string, StoredJob>();
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly provider?: string;
  private readonly runner?: PresentationRunner;
  private readonly allowedRunnerIds: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly workspaceFactory: PresentationWorkspaceFactory;
  private readonly buildArgs: PresentationArgsBuilder;

  constructor(options: PptMasterAdapterOptions = {}) {
    this.provider = options.provider ?? (options.runner ? options.runner.id : undefined);
    this.runner = options.runner;
    this.allowedRunnerIds = options.allowedRunnerIds ?? (options.runner ? [options.runner.id] : []);
    this.timeoutMs = validateLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.maxOutputBytes = validateLimit(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => `job-${Date.now()}-${++adapterSequence}`);
    this.workspaceFactory = options.workspaceFactory ?? defaultWorkspaceFactory;
    this.buildArgs = options.buildArgs ?? defaultArgs;
  }

  async createJob(input: PresentationJobInput): Promise<PresentationJob> {
    const normalizedInput = validateInput(input);
    const jobId = requireText(this.idFactory(), 'jobId');
    if (this.jobs.has(jobId)) {
      throw new PresentationError('PRESENTATION_INVALID', `Job already exists: ${jobId}`, {
        jobId,
      });
    }
    const timestamp = this.now();
    const job: StoredJob = {
      jobId,
      state: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      input: normalizedInput,
      cancelRequested: false,
    };
    this.jobs.set(jobId, job);
    return this.startJob(job);
  }

  async getJob(jobId: string): Promise<PresentationJob | null> {
    const job = this.jobs.get(jobId);
    return job ? cloneJob(job) : null;
  }

  async cancelJob(jobId: string): Promise<PresentationJob> {
    const job = this.requireJob(jobId);
    if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
      return cloneJob(job);
    }

    job.cancelRequested = true;
    job.state = 'cancelled';
    job.error = undefined;
    job.updatedAt = this.now();
    const process = job.process;
    if (process) {
      try {
        await process.cancel();
      } catch (cause) {
        job.state = 'failed';
        job.error = asRunError(
          new PresentationError('PRESENTATION_CANCEL_FAILED', 'Unable to cancel runner process', {
            jobId,
            cause,
          }),
        );
        job.updatedAt = this.now();
        throw new PresentationError(
          'PRESENTATION_CANCEL_FAILED',
          'Unable to cancel runner process',
          {
            jobId,
            cause,
          },
        );
      }
    }
    return cloneJob(job);
  }

  async retryJob(jobId: string): Promise<PresentationJob> {
    const job = this.requireJob(jobId);
    if (job.inFlight) {
      const pending = job.inFlight;
      if (!job.cancelRequested) return pending;
      try {
        await pending;
      } catch {
        // A cancelled provider task may reject after the cancellation has been recorded.
      }
    }
    if (job.inFlight) return job.inFlight;
    if (job.state === 'completed') return cloneJob(job);

    for (const artifactId of job.artifactIds ?? []) this.artifacts.delete(artifactId);
    job.artifactIds = undefined;
    job.error = undefined;
    job.cancelRequested = false;
    job.state = 'queued';
    job.updatedAt = this.now();
    return this.startJob(job);
  }

  async getArtifact(artifactId: string): Promise<ArtifactSnapshot | null> {
    const artifact = this.artifacts.get(artifactId);
    return artifact ? cloneArtifact(artifact) : null;
  }

  async readArtifactBytes(artifactId: string): Promise<Uint8Array | null> {
    const artifact = this.artifacts.get(artifactId);
    return artifact ? new Uint8Array(artifact.bytes) : null;
  }

  async exportArtifact(
    artifactId: string,
    format: PresentationExportFormat,
  ): Promise<ExportResult> {
    if (!isPresentationFormat(format)) {
      throw new PresentationError(
        'PRESENTATION_INVALID',
        `Unknown export format: ${String(format)}`,
        {
          artifactId,
          path: 'format',
        },
      );
    }
    const source = this.artifacts.get(artifactId);
    if (!source) throw this.notFound('artifact', artifactId);
    const runner = this.requireRunner();
    const operationId = `${artifactId}:export:${format}`;
    const workspace = await this.workspaceFactory(operationId);

    try {
      const args = this.commandArgs({
        operation: 'export',
        jobId: operationId,
        artifactId,
        format,
        workspacePath: workspace.path,
      });
      const process = runner.spawn({
        operation: 'export',
        jobId: operationId,
        provider: this.provider!,
        args,
        cwd: workspace.path,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        shell: false,
        inputArtifact: {
          artifactId,
          path: join(workspace.path, 'input.pptx'),
          bytes: new Uint8Array(source.bytes),
        },
      });
      const result = await this.awaitProcess(process, operationId);
      this.assertRunnerResult(result, operationId);
      const output = result.artifacts?.[0];
      if (!output || output.bytes.byteLength === 0) {
        throw new PresentationError('PRESENTATION_INVALID', 'Runner returned no export artifact', {
          jobId: operationId,
          artifactId,
        });
      }
      this.assertArtifactPath(workspace.path, output.path, operationId, artifactId);
      if (format === 'pptx' && !isPptxZip(output.bytes)) {
        throw new PresentationError('PPTX_INVALID', 'Export is not a valid OOXML PPTX ZIP', {
          jobId: operationId,
          artifactId,
        });
      }

      const exportedId = operationId;
      const stored = this.storeArtifact(exportedId, format, output, this.now());
      return {
        artifactId: exportedId,
        format,
        mimeType: stored.mimeType,
        uri: stored.uri,
      };
    } finally {
      await this.cleanup(workspace);
    }
  }

  async dispose(): Promise<void> {
    const activeJobs = [...this.jobs.values()].filter(
      (job) => job.state === 'queued' || job.state === 'running',
    );
    await Promise.all(activeJobs.map((job) => this.cancelJob(job.jobId).catch(() => undefined)));
    await Promise.all(
      [...this.jobs.values()]
        .map((job) => job.workspace)
        .filter((workspace): workspace is PresentationWorkspace => workspace !== undefined)
        .map((workspace) => this.cleanup(workspace)),
    );
  }

  private startJob(job: StoredJob): Promise<PresentationJob> {
    if (job.inFlight) return job.inFlight;
    const task = this.executeJob(job).finally(() => {
      if (job.inFlight === task) job.inFlight = undefined;
    });
    job.inFlight = task;
    return task;
  }

  private async executeJob(job: StoredJob): Promise<PresentationJob> {
    if (job.cancelRequested) return cloneJob(job);
    job.state = 'running';
    job.updatedAt = this.now();
    let workspace: PresentationWorkspace | undefined;

    try {
      const runner = this.requireRunner();
      workspace = await this.workspaceFactory(job.jobId);
      if (!workspace) {
        throw new PresentationError(
          'PROVIDER_UNAVAILABLE',
          'Workspace factory returned no workspace',
          {
            jobId: job.jobId,
          },
        );
      }
      job.workspace = workspace;
      if (job.cancelRequested) return cloneJob(job);

      const args = this.commandArgs({
        operation: 'create',
        jobId: job.jobId,
        input: job.input,
        workspacePath: workspace.path,
      });
      const process = runner.spawn({
        operation: 'create',
        jobId: job.jobId,
        provider: this.provider!,
        args,
        cwd: workspace.path,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        shell: false,
        inputArtifact: {
          artifactId: `${job.jobId}:input`,
          path: join(workspace.path, 'input.json'),
          bytes: serializePresentationInput(job.input),
        },
      });
      job.process = process;
      const result = await this.awaitProcess(process, job.jobId);
      if (job.cancelRequested) return cloneJob(job);
      this.assertRunnerResult(result, job.jobId);

      const output = this.findPptxArtifact(result.artifacts, job.jobId);
      const outputs = [
        output,
        ...(result.artifacts ?? []).filter((artifact) => artifact !== output),
      ];
      const createdAt = this.now();
      const artifactIds: string[] = [];
      const workspacePath = workspace.path;
      outputs.forEach((artifact, index) => {
        const artifactId = `${job.jobId}:${index}`;
        this.assertArtifactPath(workspacePath, artifact.path, job.jobId, artifactId);
        const format = isPptxZip(artifact.bytes)
          ? 'pptx'
          : artifact.type === 'svg' || artifact.path.toLowerCase().endsWith('.svg')
            ? 'svg'
            : undefined;
        if (!format) return;
        this.storeArtifact(artifactId, format, artifact, createdAt);
        artifactIds.push(artifactId);
      });
      if (artifactIds.length === 0) {
        throw new PresentationError('PPTX_INVALID', 'Runner did not return a valid PPTX artifact', {
          jobId: job.jobId,
        });
      }
      job.artifactIds = artifactIds;
      job.state = 'completed';
      job.error = undefined;
      job.updatedAt = this.now();
      return cloneJob(job);
    } catch (error) {
      if (job.cancelRequested) {
        job.state = 'cancelled';
        job.error = undefined;
      } else {
        job.state = 'failed';
        job.error = asRunError(error);
        if (isProviderError(error)) throw error;
      }
      job.updatedAt = this.now();
      return cloneJob(job);
    } finally {
      job.process = undefined;
      if (job.workspace === workspace) job.workspace = undefined;
      if (workspace) await this.cleanup(workspace);
    }
  }

  private requireRunner(): PresentationRunner {
    if (!this.provider || !this.runner) {
      throw new PresentationError('PROVIDER_UNAVAILABLE', 'PPT Master provider is not configured');
    }
    if (!this.allowedRunnerIds.includes(this.runner.id)) {
      throw new PresentationError(
        'PRESENTATION_RUNNER_NOT_ALLOWED',
        `Runner is not allow-listed: ${this.runner.id}`,
      );
    }
    return this.runner;
  }

  private commandArgs(context: PresentationCommandContext): readonly string[] {
    const args = this.buildArgs(context);
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
      throw new PresentationError(
        'PRESENTATION_INVALID',
        'Runner arguments must be a string array',
        {
          path: 'args',
          jobId: context.jobId,
        },
      );
    }
    return [...args];
  }

  private async awaitProcess(
    process: PresentationRunnerProcess,
    jobId: string,
  ): Promise<PresentationRunnerResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const result = await new Promise<PresentationRunnerResult>((resolveResult, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new PresentationError('PRESENTATION_TIMEOUT', 'PPT Master runner timed out', { jobId }),
          );
        }, this.timeoutMs);
        process.result.then(resolveResult, reject);
      });
      return result;
    } catch (error) {
      if (timedOut) {
        try {
          await process.cancel();
        } catch (cause) {
          throw new PresentationError(
            'PRESENTATION_CANCEL_FAILED',
            'Timed-out runner could not be cancelled',
            { jobId, cause },
          );
        }
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private assertRunnerResult(result: PresentationRunnerResult, jobId: string): void {
    if (outputBytesOf(result) > this.maxOutputBytes) {
      throw new PresentationError(
        'PRESENTATION_OUTPUT_LIMIT',
        `Runner output exceeds ${this.maxOutputBytes} bytes`,
        { jobId },
      );
    }
    if (result.exitCode !== 0) {
      throw new PresentationError(
        'PPT_MASTER_FAILED',
        result.stderr?.trim() || `PPT Master exited with code ${result.exitCode}`,
        { jobId },
      );
    }
  }

  private findPptxArtifact(
    artifacts: readonly PresentationRunnerArtifact[] | undefined,
    jobId: string,
  ): PresentationRunnerArtifact {
    const output = artifacts?.find((artifact) => isPptxZip(artifact.bytes));
    if (!output) {
      throw new PresentationError('PPTX_INVALID', 'Runner did not return a valid OOXML PPTX ZIP', {
        jobId,
      });
    }
    return output;
  }

  private assertArtifactPath(
    workspacePath: string,
    artifactPath: string,
    jobId: string,
    artifactId: string,
  ): string {
    const root = resolve(workspacePath);
    const candidate = resolve(root, artifactPath);
    const pathFromRoot = relative(root, candidate);
    if (!artifactPath || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
      throw new PresentationError(
        'PRESENTATION_PATH_OUT_OF_SCOPE',
        `Artifact path is outside the job workspace: ${artifactPath}`,
        { jobId, artifactId, path: artifactPath },
      );
    }
    return candidate;
  }

  private storeArtifact(
    artifactId: string,
    format: string,
    output: PresentationRunnerArtifact,
    timestamp: string,
  ): StoredArtifact {
    const stored: StoredArtifact = {
      artifactId,
      type: format,
      name: output.name ?? basename(output.path),
      mimeType: output.mimeType ?? MIME_BY_FORMAT[format as PresentationExportFormat],
      sizeBytes: output.bytes.byteLength,
      status: 'ready',
      // SVG previews are rendered directly by the browser. The kernel keeps
      // the bytes in memory and exposes a data URI so the preview does not
      // depend on an unimplemented `memory://` transport endpoint. PPTX
      // downloads continue through the authenticated export route.
      uri:
        format === 'svg'
          ? `data:image/svg+xml;base64,${Buffer.from(output.bytes).toString('base64')}`
          : `memory://presentation/${encodeURIComponent(artifactId)}`,
      metadata: { sourcePath: output.path },
      createdAt: timestamp,
      updatedAt: timestamp,
      bytes: new Uint8Array(output.bytes),
    };
    this.artifacts.set(artifactId, stored);
    return stored;
  }

  private async cleanup(workspace: PresentationWorkspace): Promise<void> {
    try {
      await workspace.cleanup();
    } catch {
      // Cleanup must not turn a real job result into a fabricated provider success.
    }
  }

  private requireJob(jobId: string): StoredJob {
    const job = this.jobs.get(jobId);
    if (!job) throw this.notFound('job', jobId);
    return job;
  }

  private notFound(kind: string, id: string): PresentationError {
    return new PresentationError('PRESENTATION_NOT_FOUND', `${kind} does not exist: ${id}`, {
      artifactId: kind === 'artifact' ? id : undefined,
      jobId: kind === 'job' ? id : undefined,
    });
  }
}

export { PresentationError as PptMasterAdapterError };
