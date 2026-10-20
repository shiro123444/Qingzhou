/**
 * C-40: explicit production provider command seam.
 *
 * This module only assembles and validates argv. It never starts a process and
 * never discovers a provider implicitly. A caller injects the returned command
 * builder into a PresentationRunner; the runner remains responsible for
 * invoking it with `shell: false`.
 */

import path from 'node:path';

import type {
  PresentationArgsBuilder,
  PresentationCommandContext,
  PresentationExportFormat,
  PresentationRunnerOperation,
} from '../../../../packages/cordis-kernel/src/presentation';
import { PresentationError } from '../../../../packages/cordis-kernel/src/presentation';

export interface ProductionPresentationProviderOptions {
  /** Explicit runner allow-list; omitted means only `runnerId` is allowed. */
  readonly allowedRunnerIds?: readonly string[];
  /** Optional operation-specific argv mapper. */
  readonly buildArgs?: PresentationArgsBuilder;
  /** Executable argv, e.g. `['node', '/opt/ppt-master/cli.mjs']`. */
  readonly command?: readonly string[];
  /** Static argv inserted between command and operation-specific arguments. */
  readonly commandArgs?: readonly string[];
  /**
   * Generated images one job may request. A deck whose content plan needs more raster
   * visuals than this cannot be satisfied, so the value is deployable configuration.
   */
  readonly imageBudget?: number;
  /** Provider identifier used by the PresentationPort and audit records. */
  readonly provider?: string;
  /** Runner identifier checked against `allowedRunnerIds`. */
  readonly runnerId?: string;
}

export interface ProductionPresentationProvider {
  readonly allowedRunnerIds: readonly string[];
  readonly available: boolean;
  readonly buildArgs: PresentationArgsBuilder;
  /** Return a fresh argv array; this method never invokes the provider. */
  buildArgv: (context: PresentationCommandContext) => readonly string[];
  readonly command: readonly string[];
  readonly commandArgs: readonly string[];
  readonly provider?: string;
  readonly runnerId?: string;
}

export type ProductionProviderReadinessState = 'configured' | 'unavailable';

/**
 * Safe, side-effect-free provider readiness projection. It deliberately does
 * not include command/commandArgs/buildArgs so callers cannot expose secrets
 * or a complete executable argv through a health check.
 */
export interface ProductionProviderReadiness {
  readonly available: boolean;
  readonly code?: 'PROVIDER_UNAVAILABLE';
  readonly commandAvailable: boolean;
  readonly provider?: string;
  readonly runnerId?: string;
  readonly state: ProductionProviderReadinessState;
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const unavailable = (reason: string): PresentationError =>
  new PresentationError('PROVIDER_UNAVAILABLE', reason);

const invalid = (message: string, path: string): PresentationError =>
  new PresentationError('PRESENTATION_INVALID', message, { path });

const validateArgv = (value: unknown, path: string, allowEmpty = false): readonly string[] => {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((argument) => !nonEmptyString(argument))
  ) {
    throw invalid(`${path} must be a non-empty string array`, path);
  }
  return [...value];
};

const workspaceInputPath = (workspacePath: string, filename: 'input.json' | 'input.pptx'): string =>
  path.resolve(workspacePath, filename);

/** Default command mapping shared by create/export production adapters. */
export const defaultProductionBuildArgs: PresentationArgsBuilder = (context) => {
  const common = [
    context.operation,
    '--job-id',
    context.jobId,
    '--workspace',
    context.workspacePath,
  ];

  if (context.operation === 'create') {
    // The input payload is written by the next runner/adapter seam. Passing a
    // path keeps secrets and large JSON out of argv while retaining a stable,
    // workspace-scoped location.
    return [...common, '--input-file', workspaceInputPath(context.workspacePath, 'input.json')];
  }

  return [
    ...common,
    '--input-file',
    workspaceInputPath(context.workspacePath, 'input.pptx'),
    '--artifact-id',
    context.artifactId ?? '',
    '--format',
    context.format ?? '',
  ];
};

const validateContext = (context: PresentationCommandContext): void => {
  if (!context || typeof context !== 'object') throw invalid('context is required', 'context');
  if (context.operation !== 'create' && context.operation !== 'export') {
    throw invalid('operation must be create or export', 'operation');
  }
  if (!nonEmptyString(context.jobId)) throw invalid('jobId must be non-empty', 'jobId');
  if (!nonEmptyString(context.workspacePath)) {
    throw invalid('workspacePath must be non-empty', 'workspacePath');
  }
  if (context.operation === 'create' && !context.input) {
    throw invalid('input is required for create', 'input');
  }
  if (context.operation === 'export') {
    if (!nonEmptyString(context.artifactId)) {
      throw invalid('artifactId is required for export', 'artifactId');
    }
    if (!nonEmptyString(context.format)) {
      throw invalid('format is required for export', 'format');
    }
  }
};

const unavailableProvider = (
  provider?: string,
  runnerId?: string,
): ProductionPresentationProvider => {
  const error = (): never => {
    throw unavailable(
      provider
        ? `Provider "${provider}" has no production command configured`
        : 'Presentation provider is not configured',
    );
  };
  return {
    available: false,
    ...(provider ? { provider } : {}),
    command: [],
    commandArgs: [],
    ...(runnerId ? { runnerId } : {}),
    allowedRunnerIds: [],
    buildArgs: error,
    buildArgv: error,
  };
};

/**
 * Assemble an explicit provider command seam. Missing provider/command config
 * returns an unavailable seam whose use fails with PROVIDER_UNAVAILABLE;
 * malformed configured values fail immediately with stable validation codes.
 */
export const createProductionPresentationProvider = (
  options: ProductionPresentationProviderOptions = {},
): ProductionPresentationProvider => {
  if (!options || typeof options !== 'object') return unavailableProvider();
  if (!nonEmptyString(options.provider) || !options.command) {
    return unavailableProvider(options.provider, options.runnerId);
  }

  const command = validateArgv(options.command, 'command');
  const commandArgs = options.commandArgs
    ? validateArgv(options.commandArgs, 'commandArgs', true)
    : ([] as readonly string[]);
  const runnerId = options.runnerId ?? options.provider;
  if (!nonEmptyString(runnerId)) throw invalid('runnerId must be non-empty', 'runnerId');

  const allowedRunnerIds = options.allowedRunnerIds ? [...options.allowedRunnerIds] : [runnerId];
  if (allowedRunnerIds.some((id) => !nonEmptyString(id))) {
    throw invalid('allowedRunnerIds must be a string array', 'allowedRunnerIds');
  }
  if (!allowedRunnerIds.includes(runnerId)) {
    throw new PresentationError(
      'PRESENTATION_RUNNER_NOT_ALLOWED',
      `Runner is not allow-listed: ${runnerId}`,
      { path: 'runnerId' },
    );
  }

  const buildArgs = options.buildArgs ?? defaultProductionBuildArgs;
  const buildArgv = (context: PresentationCommandContext): readonly string[] => {
    validateContext(context);
    const args = validateArgv(buildArgs(context), 'buildArgs');
    return [...command, ...commandArgs, ...args];
  };

  return {
    available: true,
    provider: options.provider,
    command,
    commandArgs,
    runnerId,
    allowedRunnerIds,
    buildArgs,
    buildArgv,
  };
};

/**
 * Resolve provider readiness without invoking buildArgs or starting a runner.
 * Configuration errors from the existing provider factory are intentionally
 * preserved as PRESENTATION_INVALID (or its existing runner error code).
 */
export const resolveProviderReadiness = (
  options: ProductionPresentationProviderOptions = {},
): ProductionProviderReadiness => {
  const provider = createProductionPresentationProvider(options);
  const available = provider.available;
  return {
    available,
    commandAvailable: available,
    ...(provider.provider ? { provider: provider.provider } : {}),
    ...(provider.runnerId ? { runnerId: provider.runnerId } : {}),
    state: available ? 'configured' : 'unavailable',
    ...(available ? {} : { code: 'PROVIDER_UNAVAILABLE' }),
  };
};

/** Alias for callers that prefer an inspection verb for health checks. */
export const inspectProviderReadiness = resolveProviderReadiness;

/** Type guard useful to production bootstrap code before runner injection. */
export const isProductionPresentationProviderConfigured = (
  provider: ProductionPresentationProvider,
): boolean => provider.available;

export type ProductionPresentationOperation = PresentationRunnerOperation;
export type ProductionPresentationFormat = PresentationExportFormat;
