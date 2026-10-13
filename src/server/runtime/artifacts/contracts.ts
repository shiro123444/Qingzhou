import type {
  ArtifactSnapshot,
  ArtifactStatus,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';

/** Account-owned immutable resources shared by capability plugins. */
export interface ArtifactInput {
  artifactId: string;
  bytes?: Uint8Array;
  createdAt?: string;
  metadata?: Record<string, unknown>;
  mimeType: string;
  name: string;
  sizeBytes?: number;
  status?: ArtifactStatus;
  type: string;
  updatedAt?: string;
  uri?: string;
}

export interface StoredArtifact extends ArtifactSnapshot {
  readonly bytes?: Uint8Array;
}

export interface ArtifactStore {
  get: (scope: RuntimeScope, artifactId: string) => Promise<StoredArtifact | null>;
  list?: (scope: RuntimeScope) => Promise<ArtifactSnapshot[]>;
  listByJob?: (scope: RuntimeScope, jobId: string) => Promise<readonly StoredArtifact[]>;
  put: (scope: RuntimeScope, artifact: ArtifactInput) => Promise<ArtifactSnapshot>;
  remove: (scope: RuntimeScope, artifactId: string) => Promise<void>;
}
