import { createHash } from 'node:crypto';

import { PresentationError } from '../../../../packages/cordis-kernel/src/presentation';

export const PRESENTATION_AGENT_MODELS_ENV = 'CORDIS_PRESENTATION_AGENT_MODELS';

export const PRESENTATION_AGENT_ROLES = Object.freeze([
  'content',
  'planning',
  'design',
  'assets',
  'review',
  'reference',
  'diagnosis',
] as const);

export type PresentationAgentRole = (typeof PRESENTATION_AGENT_ROLES)[number];

/** Selects an account-owned provider and model, never deployment credentials. */
export interface PresentationAgentModelSelection {
  readonly model: string;
  readonly provider?: string;
}

export type PresentationAgentModelConfig = Readonly<
  Partial<Record<PresentationAgentRole, PresentationAgentModelSelection>>
>;

const invalid = (path: string) =>
  new PresentationError('PRESENTATION_INVALID', 'PPT agent model configuration is invalid', {
    path,
  });

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const identifier = (value: unknown, path: string): string => {
  if (typeof value !== 'string') throw invalid(path);
  const normalized = value.trim();
  // Provider catalogs use namespaced, dated and vendor-specific IDs. Accept
  // their punctuation without allowing control characters or internal spaces.
  if (!normalized || /[\s\p{Cc}\p{Cf}]/u.test(normalized)) throw invalid(path);
  return normalized;
};

const normalize = (value: unknown): PresentationAgentModelConfig => {
  if (!isPlainRecord(value)) throw invalid(PRESENTATION_AGENT_MODELS_ENV);
  const roles: readonly string[] = PRESENTATION_AGENT_ROLES;
  if (Object.keys(value).some((role) => !roles.includes(role)))
    throw invalid(`${PRESENTATION_AGENT_MODELS_ENV}.role`);
  const config: Partial<Record<PresentationAgentRole, PresentationAgentModelSelection>> = {};
  for (const role of PRESENTATION_AGENT_ROLES) {
    if (!Object.hasOwn(value, role)) continue;
    const path = `${PRESENTATION_AGENT_MODELS_ENV}.${role}`;
    const selection = value[role];
    if (!isPlainRecord(selection)) throw invalid(path);
    if (Object.keys(selection).some((key) => key !== 'model' && key !== 'provider'))
      throw invalid(`${path}.fields`);
    const model = identifier(selection.model, `${path}.model`);
    config[role] = Object.freeze({
      ...(Object.hasOwn(selection, 'provider')
        ? { provider: identifier(selection.provider, `${path}.provider`) }
        : {}),
      model,
    });
  }
  return Object.freeze(config);
};

/** Pure explicit configuration loader: no environment reads, I/O or credentials. */
export function loadPresentationAgentModelConfig(
  env: Readonly<Record<string, string | undefined>> = {},
): PresentationAgentModelConfig {
  if (!isPlainRecord(env)) throw invalid('env');
  const raw = env[PRESENTATION_AGENT_MODELS_ENV];
  if (raw === undefined) return Object.freeze({});
  if (typeof raw !== 'string' || !raw.trim()) throw invalid(PRESENTATION_AGENT_MODELS_ENV);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON parser errors can contain the supplied configuration. Never retain
    // their text/cause: this contract accepts model selection, not secrets.
    throw invalid(PRESENTATION_AGENT_MODELS_ENV);
  }
  return normalize(parsed);
}

/** Stable across JSON key order, with changed routes invalidating stage caches. */
export function fingerprintPresentationAgentModelConfig(
  config: PresentationAgentModelConfig,
): string {
  return createHash('sha256')
    .update(JSON.stringify(normalize(config)))
    .digest('hex');
}
