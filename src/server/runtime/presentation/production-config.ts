/**
 * C-75: explicit, server-owned production provider configuration loader.
 *
 * The loader accepts an injected environment-like record only. It never reads
 * process.env, request headers, a database, or a runner. Command details stay
 * in the returned internal options for the next seam; readiness projections
 * must be obtained through C-73 instead of serializing these options.
 */

import { PresentationError } from '../../../../packages/cordis-kernel/src/presentation';
import type { ProductionPresentationProviderOptions } from './production-command';
import { createProductionPresentationProvider } from './production-command';

export type ProductionPresentationEnv = Readonly<Record<string, string | undefined>>;

export const PRODUCTION_PRESENTATION_ENV_KEYS = {
  allowedRunnerIds: 'LOBE_PRESENTATION_ALLOWED_RUNNER_IDS_JSON',
  command: 'LOBE_PRESENTATION_COMMAND_JSON',
  commandArgs: 'LOBE_PRESENTATION_COMMAND_ARGS_JSON',
  imageBudget: 'LOBE_PRESENTATION_IMAGE_BUDGET',
  provider: 'LOBE_PRESENTATION_PROVIDER',
  runnerId: 'LOBE_PRESENTATION_RUNNER_ID',
} as const;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const invalid = (message: string, path: string): PresentationError =>
  new PresentationError('PRESENTATION_INVALID', message, { path });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readEnv = (env: unknown, key: string): string | undefined => {
  if (!isRecord(env)) throw invalid('env must be an object', 'env');
  const value = env[key];
  if (value === undefined) return;
  if (typeof value !== 'string') throw invalid(`${key} must be a string`, key);
  return value;
};

const readOptionalIdentifier = (
  env: unknown,
  key: string,
  options: { readonly emptyIsMissing?: boolean } = {},
): string | undefined => {
  const value = readEnv(env, key);
  if (value === undefined) return;
  if (!nonEmptyString(value)) {
    if (options.emptyIsMissing) return;
    throw invalid(`${key} must be a non-empty string`, key);
  }
  return value.trim();
};

const parseOptionalCount = (env: unknown, key: string): number | undefined => {
  const raw = readEnv(env, key);
  if (raw === undefined || raw.trim() === '') return;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw invalid(`${key} must be a non-negative integer`, key);
  return value;
};

const parseStringArray = (env: unknown, key: string): readonly string[] | undefined => {
  const raw = readEnv(env, key);
  if (raw === undefined) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid(`${key} must be valid JSON`, key);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((value) => !nonEmptyString(value))
  ) {
    throw invalid(`${key} must be a non-empty JSON string array`, key);
  }
  return Object.freeze(parsed.map((value) => (value as string).trim()));
};

const freezeOptions = (
  options: ProductionPresentationProviderOptions,
): ProductionPresentationProviderOptions => {
  const frozen = {
    ...options,
    ...(options.command ? { command: Object.freeze([...options.command]) } : {}),
    ...(options.commandArgs ? { commandArgs: Object.freeze([...options.commandArgs]) } : {}),
    ...(options.allowedRunnerIds
      ? { allowedRunnerIds: Object.freeze([...options.allowedRunnerIds]) }
      : {}),
  };
  return Object.freeze(frozen);
};

/**
 * Converts explicit deployment environment values to provider options.
 * Missing provider/command is intentionally returned as a partial options
 * object: createProductionPresentationProvider and C-73 will report it as
 * PROVIDER_UNAVAILABLE without inventing a runnable provider.
 */
export const loadProductionPresentationProviderOptions = (
  env: ProductionPresentationEnv = {},
): ProductionPresentationProviderOptions => {
  const provider = readOptionalIdentifier(env, PRODUCTION_PRESENTATION_ENV_KEYS.provider, {
    emptyIsMissing: true,
  });
  const command = parseStringArray(env, PRODUCTION_PRESENTATION_ENV_KEYS.command);
  const commandArgs = parseStringArray(env, PRODUCTION_PRESENTATION_ENV_KEYS.commandArgs);
  const runnerId = readOptionalIdentifier(env, PRODUCTION_PRESENTATION_ENV_KEYS.runnerId);
  const allowedRunnerIds = parseStringArray(env, PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds);
  const imageBudget = parseOptionalCount(env, PRODUCTION_PRESENTATION_ENV_KEYS.imageBudget);

  const options = {
    ...(provider ? { provider } : {}),
    ...(command ? { command } : {}),
    ...(commandArgs ? { commandArgs } : {}),
    ...(runnerId ? { runnerId } : {}),
    ...(allowedRunnerIds ? { allowedRunnerIds } : {}),
    ...(imageBudget === undefined ? {} : { imageBudget }),
  } satisfies ProductionPresentationProviderOptions;

  // Reuse C-40 validation whenever the required provider/command pair exists;
  // this also preserves PRESENTATION_RUNNER_NOT_ALLOWED semantics.
  if (provider && command) createProductionPresentationProvider(options);

  return freezeOptions(options);
};

/** Short alias for callers that refer to the result as provider options. */
export const loadProductionProviderOptions = loadProductionPresentationProviderOptions;
