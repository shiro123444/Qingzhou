import { isAbsolute, relative, resolve, sep } from 'node:path';

import type {
  PresentationRunner,
  PresentationRunnerResult,
} from '../../../../packages/cordis-kernel/src/presentation';
import type { PresentationQualityReport, PresentationWorkerArtifact } from './worker';

export interface PresentationToolchain {
  convert: (
    workspacePath: string,
    signal?: AbortSignal,
  ) => Promise<readonly PresentationWorkerArtifact[]>;
  qualityCheck: (workspacePath: string, signal?: AbortSignal) => Promise<PresentationQualityReport>;
}

export interface PresentationToolchainOptions {
  allowedRunnerIds: readonly string[];
  convertScriptPath: string;
  maxOutputBytes?: number;
  pptMasterRoot: string;
  providerCommand: readonly string[];
  qualityArgs?: readonly string[];
  qualityScriptPath: string;
  runner: PresentationRunner;
  runnerId: string;
  timeoutMs?: number;
  workspaceRoot: string;
}

export type PresentationToolchainErrorCode =
  | 'PRESENTATION_QUALITY_FAILED'
  | 'PRESENTATION_RUNNER_NOT_ALLOWED'
  | 'PRESENTATION_WORKER_CANCELLED'
  | 'PRESENTATION_WORKER_FAILED'
  | 'PROVIDER_UNAVAILABLE';

export class PresentationToolchainError extends Error {
  constructor(
    public readonly code: PresentationToolchainErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'PresentationToolchainError';
  }
}

const inside = (candidate: string, root: string): boolean => {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const canonical = (path: string, root: string, label: string): string => {
  if (typeof path !== 'string' || !path.trim())
    throw new PresentationToolchainError('PROVIDER_UNAVAILABLE', `${label} is required`);
  const value = resolve(path);
  const base = resolve(root);
  if (!inside(value, base))
    throw new PresentationToolchainError(
      'PROVIDER_UNAVAILABLE',
      `${label} is outside allowed root`,
    );
  return value;
};

export class PptMasterToolchain implements PresentationToolchain {
  private readonly options: PresentationToolchainOptions;
  private readonly qualityScriptPath: string;
  private readonly convertScriptPath: string;
  private readonly workspaceRoot: string;
  private readonly pptMasterRoot: string;

  constructor(options: PresentationToolchainOptions) {
    if (
      !options ||
      !Array.isArray(options.providerCommand) ||
      options.providerCommand.length === 0 ||
      options.providerCommand.some((part) => typeof part !== 'string' || !part.trim())
    ) {
      throw new PresentationToolchainError('PROVIDER_UNAVAILABLE', 'providerCommand is required');
    }
    if (!options.runner || options.runner.id !== options.runnerId)
      throw new PresentationToolchainError(
        'PROVIDER_UNAVAILABLE',
        'runnerId does not match runner',
      );
    if (!options.allowedRunnerIds.includes(options.runnerId))
      throw new PresentationToolchainError(
        'PRESENTATION_RUNNER_NOT_ALLOWED',
        `Runner is not allow-listed: ${options.runnerId}`,
      );
    this.pptMasterRoot = resolve(options.pptMasterRoot);
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.qualityScriptPath = canonical(
      options.qualityScriptPath,
      this.pptMasterRoot,
      'qualityScriptPath',
    );
    this.convertScriptPath = canonical(
      options.convertScriptPath,
      this.pptMasterRoot,
      'convertScriptPath',
    );
    this.options = options;
  }

  qualityCheck(workspacePath: string, signal?: AbortSignal): Promise<PresentationQualityReport> {
    return this.run('quality', workspacePath, signal).then((result) => {
      if (result.exitCode !== 0)
        throw new PresentationToolchainError(
          'PRESENTATION_QUALITY_FAILED',
          'Quality checker failed',
        );
      try {
        const output = result.stdout?.trim();
        if (!output) return { passed: true };
        const parsed = JSON.parse(output) as PresentationQualityReport;
        if (typeof parsed.passed !== 'boolean') return { details: { output }, passed: true };
        return parsed;
      } catch (error) {
        // ppt-master's checker reports human-readable diagnostics and uses its
        // exit code as the authoritative quality gate.
        const output = result.stdout?.trim() ?? '';
        if (output.includes('[SCAN]') || output.includes('[SUMMARY]')) {
          return { details: { output }, passed: true };
        }
        throw new PresentationToolchainError(
          'PRESENTATION_QUALITY_FAILED',
          'Quality report is invalid',
          error,
        );
      }
    });
  }

  async convert(
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<readonly PresentationWorkerArtifact[]> {
    const result = await this.run('convert', workspacePath, signal);
    if (result.exitCode !== 0)
      throw new PresentationToolchainError(
        'PRESENTATION_WORKER_FAILED',
        'Conversion command failed',
      );
    const artifacts = result.artifacts ?? [];
    if (!artifacts.length)
      throw new PresentationToolchainError(
        'PRESENTATION_WORKER_FAILED',
        'Conversion returned no artifacts',
      );
    return artifacts.map((artifact, index) => {
      if (!(artifact.bytes instanceof Uint8Array) || artifact.bytes.byteLength === 0)
        throw new PresentationToolchainError(
          'PRESENTATION_WORKER_FAILED',
          'Conversion returned invalid bytes',
        );
      return {
        artifactId: `${workspacePath}:${index}`,
        bytes: new Uint8Array(artifact.bytes),
        mimeType:
          artifact.mimeType ??
          (artifact.type === 'svg' || artifact.path.toLowerCase().endsWith('.svg')
            ? 'image/svg+xml'
            : 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
        name: artifact.name ?? `artifact-${index}.pptx`,
        type: artifact.type ?? 'pptx',
      };
    });
  }

  private async run(
    kind: 'quality' | 'convert',
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<PresentationRunnerResult> {
    if (signal?.aborted)
      throw new PresentationToolchainError(
        'PRESENTATION_WORKER_CANCELLED',
        'Toolchain was cancelled',
      );
    const workspace = canonical(workspacePath, this.workspaceRoot, 'workspacePath');
    const script = kind === 'quality' ? this.qualityScriptPath : this.convertScriptPath;
    const process = this.options.runner.spawn({
      operation: kind === 'quality' ? 'create' : 'export',
      provider: this.options.providerCommand[0]!,
      args: [
        ...this.options.providerCommand.slice(1),
        script,
        workspace,
        ...(kind === 'quality' ? (this.options.qualityArgs ?? []) : []),
        // The converter's default auto mode cycles effects across the whole
        // deck. A fixed effect keeps untouched slides stable after page edits.
        ...(kind === 'convert'
          ? ['--output', 'exports/presentation.pptx', '--animation', 'fade']
          : []),
      ],
      cwd: workspace,
      jobId: `toolchain:${kind}`,
      timeoutMs: this.options.timeoutMs ?? 30_000,
      maxOutputBytes: this.options.maxOutputBytes ?? 10 * 1024 * 1024,
      shell: false,
    });
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      void process.cancel();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await process.result;
      if (cancelled || signal?.aborted)
        throw new PresentationToolchainError(
          'PRESENTATION_WORKER_CANCELLED',
          'Toolchain was cancelled',
        );
      return result;
    } catch (error) {
      if (cancelled || signal?.aborted)
        throw new PresentationToolchainError(
          'PRESENTATION_WORKER_CANCELLED',
          'Toolchain was cancelled',
        );
      if (error instanceof PresentationToolchainError) throw error;
      throw new PresentationToolchainError(
        kind === 'quality' ? 'PRESENTATION_QUALITY_FAILED' : 'PRESENTATION_WORKER_FAILED',
        'Toolchain runner failed',
        error,
      );
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
