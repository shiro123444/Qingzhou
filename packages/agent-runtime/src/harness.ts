/** Serializable contracts shared by browser execution, server execution and experiments. */
export type HarnessValue =
  | null
  | boolean
  | number
  | string
  | HarnessValue[]
  | { [key: string]: HarnessValue };
export interface HarnessScope {
  agentId: string;
  userId: string;
}
export interface HarnessPublicationRef {
  decisionId: string;
  generation: number;
}
export interface HarnessRevision {
  id: string;
  material: { [key: string]: HarnessValue };
  schemaVersion: 1 | 2;
  scope: HarnessScope;
}
export interface HarnessRunBinding {
  operationId: string;
  revisionId: string;
  schemaVersion: 1 | 2;
  scope: HarnessScope;
  snapshotId?: string;
  source: 'server' | 'client' | 'probe';
}
export interface PinnedHarness {
  binding: HarnessRunBinding;
  revision: HarnessRevision;
  snapshot?: HarnessRunSnapshot;
}

/** Host-produced provenance, never accepted from a candidate patch. */
export interface HarnessPromptSegment {
  content: string;
  kind: 'author' | 'host' | 'task';
}
/** Complete per-operation material, separate from reusable behavior identity. */
export interface HarnessRunSnapshot {
  id: string;
  material: { [key: string]: HarnessValue };
  operationId: string;
  revisionId: string;
  schemaVersion: 1;
  scope: HarnessScope;
}

export function composeHarnessPrompt(segments: HarnessPromptSegment[], author?: string): string {
  if (
    segments.filter((segment) => segment.kind === 'author').length !== 1 ||
    segments.some(
      (segment) =>
        !['author', 'host', 'task'].includes(segment.kind) || typeof segment.content !== 'string',
    )
  )
    throw new Error('HARNESS_INVALID_PROMPT_SEGMENTS');
  return segments
    .map((segment) => (segment.kind === 'author' ? (author ?? segment.content) : segment.content))
    .filter(Boolean)
    .join('\n\n');
}

/** Both ordinary execution and text probes consume this configuration projection. */
export function resolveHarnessMaterial(pinned: PinnedHarness): HarnessRevision['material'] {
  const { revision, snapshot } = pinned;
  if (revision.schemaVersion === 1) return structuredClone(revision.material);
  if (!snapshot) throw new Error('HARNESS_SNAPSHOT_MISSING');
  const material = structuredClone({ ...revision.material, ...snapshot.material });
  const author = (revision.material.agentConfig as { systemRole?: string }).systemRole ?? '';
  material.agentConfig = {
    ...(material.agentConfig as Record<string, HarnessValue>),
    systemRole: composeHarnessPrompt(
      snapshot.material.promptSegments as unknown as HarnessPromptSegment[],
      author,
    ),
  };
  // Run-specific material cannot override the adopted behavior strategy.
  material.contextPolicy = structuredClone(revision.material.contextPolicy);
  // Preserve run-local activation IDs while selecting the immutable managed bodies.
  const behaviorSkills = revision.material.operationSkillSet as unknown as
    | {
        skills?: { identifier: string; revision?: { bindingId: string }; [key: string]: unknown }[];
      }
    | undefined;
  const runSkills = material.operationSkillSet as unknown as typeof behaviorSkills;
  if (behaviorSkills?.skills && runSkills?.skills) {
    const managed = new Map(
      behaviorSkills.skills
        .filter((skill) => skill.revision)
        .map((skill) => [skill.identifier, skill]),
    );
    runSkills.skills = runSkills.skills.map((skill) => managed.get(skill.identifier) ?? skill);
    // These standalone indexes are served by SkillResolver, avoiding a second, mutable document path.
    const ids = new Set([...managed.values()].map((skill) => skill.revision!.bindingId));
    if (Array.isArray(material.agentDocuments))
      material.agentDocuments = material.agentDocuments.filter(
        (doc) =>
          !doc || typeof doc !== 'object' || Array.isArray(doc) || !ids.has(doc.id as string),
      );
  }
  return material;
}

const secret =
  /^(?:apiKey|api_key|accessToken|refreshToken|authorization|cookie|password|clientSecret|credentials|headers|secretAccessKey|accessKeyId|sessionToken|privateKey|private_key|keyVaults|environmentVariables)$/iu;
/** Only JSON data enters a revision; runtime handles and credential values stay with the host. */
export function harnessData(value: unknown, redactCredentials = false): HarnessValue {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('HARNESS_NON_SERIALIZABLE');
    return value.toISOString();
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value))
    return value.map((item) => (item === undefined ? null : harnessData(item, redactCredentials)));
  if (
    typeof value === 'object' &&
    value &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    const result: Record<string, HarnessValue> = {};
    for (const key of Object.keys(value).sort()) {
      if (redactCredentials && secret.test(key)) continue;
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined && typeof item !== 'function')
        Object.defineProperty(result, key, {
          value: harnessData(item, key === 'properties' ? false : redactCredentials),
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    return result;
  }
  throw new Error('HARNESS_NON_SERIALIZABLE');
}
export async function harnessDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(harnessData(value)));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export async function createHarnessRevision(
  scope: HarnessScope,
  material: Record<string, unknown>,
  schemaVersion: HarnessRevision['schemaVersion'] = 1,
): Promise<HarnessRevision> {
  if (!scope.userId?.trim() || !scope.agentId?.trim()) throw new Error('HARNESS_SCOPE_REQUIRED');
  const safe = Object.fromEntries(
    Object.entries(material).map(([key, value]) => [
      key,
      harnessData(value, ['agentConfig', 'modelRuntimeConfig', 'resolvedConfig'].includes(key)),
    ]),
  );
  const body = {
    schemaVersion,
    scope: { ...scope },
    material: harnessData(safe) as HarnessRevision['material'],
  };
  return freeze({ ...body, id: `harness-${await harnessDigest(body)}` });
}
export function bindHarness(
  revision: HarnessRevision,
  operationId: string,
  source: HarnessRunBinding['source'],
): PinnedHarness {
  if (revision.schemaVersion !== 1) throw new Error('HARNESS_SNAPSHOT_REQUIRED');
  if (!operationId.trim()) throw new Error('HARNESS_OPERATION_REQUIRED');
  return freeze({
    revision,
    binding: {
      schemaVersion: 1,
      revisionId: revision.id,
      operationId,
      scope: { ...revision.scope },
      source,
    },
  });
}

/** A v2 binding always includes a separately hashed, operation-specific snapshot. */
export async function bindHarnessRun(
  revision: HarnessRevision,
  operationId: string,
  material: Record<string, unknown>,
  source: HarnessRunBinding['source'] = 'server',
): Promise<PinnedHarness> {
  if (revision.schemaVersion !== 2 || !operationId.trim())
    throw new Error('HARNESS_BINDING_MISMATCH');
  const safe = Object.fromEntries(
    Object.entries(material).map(([key, value]) => [
      key,
      harnessData(value, key !== 'toolCatalog'),
    ]),
  );
  const body = {
    schemaVersion: 1 as const,
    scope: { ...revision.scope },
    operationId,
    revisionId: revision.id,
    material: safe,
  };
  const snapshot = { ...body, id: `harness-run-${await harnessDigest(body)}` };
  return freeze({
    revision,
    snapshot,
    binding: {
      schemaVersion: 2,
      revisionId: revision.id,
      snapshotId: snapshot.id,
      operationId,
      scope: { ...revision.scope },
      source,
    },
  });
}

export async function verifyHarnessRevision(
  revision: HarnessRevision,
  scope: HarnessScope,
): Promise<void> {
  if (
    ![1, 2].includes(revision.schemaVersion) ||
    revision.scope.userId !== scope.userId ||
    revision.scope.agentId !== scope.agentId
  )
    throw new Error('HARNESS_BINDING_MISMATCH');
  const expected = await createHarnessRevision(scope, revision.material, revision.schemaVersion);
  if (
    expected.id !== revision.id ||
    (await harnessDigest(expected.material)) !== (await harnessDigest(revision.material))
  )
    throw new Error('HARNESS_REVISION_CORRUPT');
}
export async function verifyHarness(
  pinned: PinnedHarness,
  scope: HarnessScope,
  operationId: string,
): Promise<void> {
  const { revision, binding } = pinned;
  if (
    binding.schemaVersion !== revision.schemaVersion ||
    binding.operationId !== operationId ||
    [revision.scope, binding.scope].some(
      (s) => s.userId !== scope.userId || s.agentId !== scope.agentId,
    ) ||
    binding.revisionId !== revision.id
  )
    throw new Error('HARNESS_BINDING_MISMATCH');
  await verifyHarnessRevision(revision, scope);
  if (revision.schemaVersion === 1) {
    if (pinned.snapshot || binding.snapshotId) throw new Error('HARNESS_BINDING_MISMATCH');
    return;
  }
  const { snapshot } = pinned;
  if (!snapshot) throw new Error('HARNESS_SNAPSHOT_MISSING');
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.operationId !== operationId ||
    snapshot.revisionId !== revision.id ||
    snapshot.scope.userId !== scope.userId ||
    snapshot.scope.agentId !== scope.agentId ||
    binding.snapshotId !== snapshot.id
  )
    throw new Error('HARNESS_BINDING_MISMATCH');
  const expected = await bindHarnessRun(revision, operationId, snapshot.material, binding.source);
  if (
    expected.snapshot!.id !== snapshot.id ||
    (await harnessDigest(expected.snapshot!.material)) !== (await harnessDigest(snapshot.material))
  )
    throw new Error('HARNESS_SNAPSHOT_CORRUPT');
  resolveHarnessMaterial(pinned);
}
