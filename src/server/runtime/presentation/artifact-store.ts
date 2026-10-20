import type {
  ArtifactSnapshot,
  ArtifactStatus,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { ArtifactInput, ArtifactStore, StoredArtifact } from '../artifacts/contracts';

export type { ArtifactInput, StoredArtifact } from '../artifacts/contracts';
export type PresentationArtifactStore = ArtifactStore;

export type PresentationArtifactStoreErrorCode =
  | 'ARTIFACT_BYTES_UNAVAILABLE'
  | 'ARTIFACT_CONFLICT'
  | 'ARTIFACT_STORE_UNAVAILABLE'
  | 'ARTIFACT_DUPLICATE'
  | 'ARTIFACT_INVALID'
  | 'ARTIFACT_NOT_FOUND'
  | 'ARTIFACT_SCOPE_MISMATCH';

export class PresentationArtifactStoreError extends Error {
  constructor(
    public readonly code: PresentationArtifactStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PresentationArtifactStoreError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const cloneWireValue = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((item) => cloneWireValue(item)) as T;
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const clone: Record<string, unknown> = Object.create(prototype) as Record<string, unknown>;
      for (const [key, nested] of Object.entries(value)) clone[key] = cloneWireValue(nested);
      return clone as T;
    }
  }
  return value;
};

const cloneArtifact = (artifact: StoredArtifact): StoredArtifact => ({
  ...artifact,
  ...(artifact.bytes ? { bytes: new Uint8Array(artifact.bytes) } : {}),
  metadata: artifact.metadata ? cloneWireValue(artifact.metadata) : undefined,
});

const scopeKey = (scope: RuntimeScope): string => {
  if (!isRecord(scope) || !nonEmpty(scope.userId) || !nonEmpty(scope.sessionId)) {
    throw new PresentationArtifactStoreError(
      'ARTIFACT_SCOPE_MISMATCH',
      'A non-empty userId and sessionId are required',
    );
  }
  return `${scope.userId}\u0000${scope.sessionId}`;
};

const invalid = (message: string): PresentationArtifactStoreError =>
  new PresentationArtifactStoreError('ARTIFACT_INVALID', message);

/** In-memory C-49 / R3-A artifact seam; supports slide-level artifacts and stable metadata. */
export class InMemoryPresentationArtifactStore implements PresentationArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly artifactScopes = new Map<string, string>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async put(scope: RuntimeScope, artifact: ArtifactInput): Promise<ArtifactSnapshot> {
    const key = scopeKey(scope);
    if (!isRecord(artifact)) throw invalid('artifact must be an object');
    if (!nonEmpty(artifact.artifactId)) throw invalid('artifactId must be non-empty');
    if (!nonEmpty(artifact.type)) throw invalid('type must be non-empty');
    if (!nonEmpty(artifact.mimeType)) throw invalid('mimeType must be non-empty');
    if (!nonEmpty(artifact.name)) throw invalid('name must be non-empty');
    const status: ArtifactStatus = artifact.status ?? 'ready';
    if (
      artifact.bytes !== undefined &&
      (!(artifact.bytes instanceof Uint8Array) || artifact.bytes.byteLength === 0)
    ) {
      throw invalid('bytes must be a non-empty Uint8Array if provided');
    }
    if (this.artifactScopes.has(artifact.artifactId)) {
      throw new PresentationArtifactStoreError(
        'ARTIFACT_DUPLICATE',
        `Artifact already exists: ${artifact.artifactId}`,
      );
    }
    const timestamp = this.now();
    const uri = nonEmpty(artifact.uri)
      ? artifact.uri
      : `/api/runtime/presentation/artifacts/${encodeURIComponent(artifact.artifactId)}`;
    const metadata = cloneWireValue({
      ...artifact.metadata,
      ...(artifact.metadata?.jobId ? { jobId: artifact.metadata.jobId } : {}),
      ...(artifact.metadata?.slideId ? { slideId: artifact.metadata.slideId } : {}),
      mimeType: artifact.mimeType,
      status,
      type: artifact.type,
      uri,
    });
    const bytes = artifact.bytes ? new Uint8Array(artifact.bytes) : undefined;
    const stored: StoredArtifact = {
      artifactId: artifact.artifactId,
      ...(bytes ? { bytes } : {}),
      createdAt: artifact.createdAt ?? timestamp,
      metadata,
      mimeType: artifact.mimeType,
      name: artifact.name,
      sizeBytes: bytes ? bytes.byteLength : (artifact.sizeBytes ?? 0),
      status,
      type: artifact.type,
      updatedAt: artifact.updatedAt ?? timestamp,
      uri,
    };
    this.artifacts.set(`${key}\u0000${artifact.artifactId}`, stored);
    this.artifactScopes.set(artifact.artifactId, key);
    return this.snapshot(stored);
  }

  async get(scope: RuntimeScope, artifactId: string): Promise<StoredArtifact | null> {
    const key = scopeKey(scope);
    if (!nonEmpty(artifactId))
      throw new PresentationArtifactStoreError('ARTIFACT_NOT_FOUND', 'artifactId is required');
    const stored = this.artifacts.get(`${key}\u0000${artifactId}`);
    if (!stored && this.artifactScopes.has(artifactId)) {
      throw new PresentationArtifactStoreError(
        'ARTIFACT_SCOPE_MISMATCH',
        `Artifact belongs to another scope: ${artifactId}`,
      );
    }
    return stored ? cloneArtifact(stored) : null;
  }

  async listByJob(scope: RuntimeScope, jobId: string): Promise<readonly StoredArtifact[]> {
    const key = scopeKey(scope);
    if (!nonEmpty(jobId)) return [];
    const results: StoredArtifact[] = [];
    for (const [k, stored] of this.artifacts.entries()) {
      if (k.startsWith(`${key}\u0000`)) {
        const matchesJobId =
          stored.metadata?.jobId === jobId ||
          stored.artifactId.startsWith(`${jobId}:`) ||
          stored.artifactId.startsWith(`${jobId}-`);
        if (matchesJobId) {
          results.push(cloneArtifact(stored));
        }
      }
    }
    return results;
  }

  async remove(scope: RuntimeScope, artifactId: string): Promise<void> {
    const key = scopeKey(scope);
    if (!nonEmpty(artifactId)) return;
    const storageKey = `${key}\u0000${artifactId}`;
    if (!this.artifacts.has(storageKey)) {
      if (this.artifactScopes.has(artifactId)) {
        throw new PresentationArtifactStoreError(
          'ARTIFACT_SCOPE_MISMATCH',
          `Artifact belongs to another scope: ${artifactId}`,
        );
      }
      return;
    }
    this.artifacts.delete(storageKey);
    this.artifactScopes.delete(artifactId);
  }

  private snapshot(stored: StoredArtifact): ArtifactSnapshot {
    const { bytes: _bytes, ...snapshot } = cloneArtifact(stored);
    return snapshot;
  }
}
