import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ArtifactSnapshot,
  PresentationJob,
  PresentationJobInput,
  PresentationPlan,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { ArtifactInput, PresentationArtifactStore, StoredArtifact } from './artifact-store';
import { type PresentationJobEvent, PresentationJobEventJournal } from './job-event-journal';
import type { PresentationRevisionAssetResult } from './revision-assets';

export interface StoredPresentationJob {
  draftCheckpoint?: { fingerprint: string; slides: PresentationPlan['slides'] };
  initialAssetsComplete?: boolean;
  input: PresentationJobInput;
  job: PresentationJob;
  plan?: PresentationPlan;
  preparedAssets?: Record<string, PresentationRevisionAssetResult>;
  revisionCheckpoint?: { requestId: string; completedSlideIds: string[] };
}

export interface PresentationJobRepository {
  getJob: (scope: RuntimeScope, jobId: string) => Promise<StoredPresentationJob | null>;
  listJobs?: (scope: RuntimeScope) => Promise<PresentationJob[]>;
  removeJob?: (scope: RuntimeScope, jobId: string) => Promise<void>;
  saveJob: (scope: RuntimeScope, record: StoredPresentationJob) => Promise<void>;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Durable storage for the single Node host; the directory must be on a persistent volume. */
export class FilePresentationStorage
  implements PresentationArtifactStore, PresentationJobRepository
{
  constructor(private readonly root: string) {}

  private directory(scope: RuntimeScope, kind: string): string {
    if (!scope.userId?.trim() || !scope.sessionId?.trim()) {
      throw Object.assign(new Error('Authenticated presentation scope is required'), {
        code: 'ARTIFACT_SCOPE_MISMATCH',
      });
    }
    return path.join(this.root, hash(JSON.stringify([scope.userId, scope.sessionId])), kind);
  }

  private path(scope: RuntimeScope, kind: string, id: string): string {
    if (!id?.trim())
      throw Object.assign(new Error('A resource id is required'), { code: 'ARTIFACT_INVALID' });
    return path.join(this.directory(scope, kind), `${hash(id)}.json`);
  }

  private async read<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  private async write(scope: RuntimeScope, kind: string, id: string, data: unknown): Promise<void> {
    await mkdir(this.directory(scope, kind), { recursive: true, mode: 0o700 });
    const path = this.path(scope, kind, id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
  }

  async listJobs(scope: RuntimeScope): Promise<PresentationJob[]> {
    const directory = this.directory(scope, 'jobs');
    const files = await readdir(directory).catch((error) => {
      if (missing(error)) return [];
      throw error;
    });
    const jobs = await Promise.all(
      files
        .filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
        .map(
          async (file) => (await this.read<StoredPresentationJob>(path.join(directory, file)))?.job,
        ),
    );
    return jobs
      .filter((job): job is PresentationJob => !!job)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getJob(scope: RuntimeScope, jobId: string): Promise<StoredPresentationJob | null> {
    return this.read(this.path(scope, 'jobs', jobId));
  }

  saveJob(scope: RuntimeScope, record: StoredPresentationJob): Promise<void> {
    return this.write(scope, 'jobs', record.job.jobId, record);
  }

  async removeJob(scope: RuntimeScope, jobId: string): Promise<void> {
    await Promise.all([
      unlink(this.path(scope, 'jobs', jobId)).catch((error) => {
        if (!missing(error)) throw error;
      }),
      unlink(path.join(this.directory(scope, 'events'), `${hash(jobId)}.jsonl`)).catch((error) => {
        if (!missing(error)) throw error;
      }),
    ]);
  }

  async get(scope: RuntimeScope, artifactId: string): Promise<StoredArtifact | null> {
    const stored = await this.read<Omit<StoredArtifact, 'bytes'> & { base64?: string }>(
      this.path(scope, 'artifacts', artifactId),
    );
    if (!stored) return null;
    const { base64, ...snapshot } = stored;
    return {
      ...snapshot,
      ...(base64 ? { bytes: new Uint8Array(Buffer.from(base64, 'base64')) } : {}),
    };
  }

  async put(scope: RuntimeScope, input: ArtifactInput): Promise<StoredArtifact> {
    const existing = await this.get(scope, input.artifactId);
    if (existing) {
      if (
        input.bytes &&
        existing.bytes &&
        Buffer.from(input.bytes).equals(Buffer.from(existing.bytes))
      )
        return existing;
      throw Object.assign(new Error('Artifact already exists'), { code: 'ARTIFACT_CONFLICT' });
    }
    const { bytes, ...metadata } = input;
    const now = new Date().toISOString();
    const artifact: StoredArtifact = {
      ...metadata,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      status: input.status ?? 'ready',
      sizeBytes: bytes?.byteLength ?? input.sizeBytes,
      uri:
        input.uri ??
        `/api/runtime/presentation/artifacts/${encodeURIComponent(input.artifactId)}?raw=true`,
    };
    await this.write(scope, 'artifacts', input.artifactId, {
      ...artifact,
      ...(bytes ? { base64: Buffer.from(bytes).toString('base64') } : {}),
    });
    return artifact;
  }

  async list(scope: RuntimeScope): Promise<ArtifactSnapshot[]> {
    const directory = this.directory(scope, 'artifacts');
    const files = await readdir(directory).catch((error) => {
      if (missing(error)) return [];
      throw error;
    });
    const artifacts: ArtifactSnapshot[] = [];
    for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const stored = await this.read<StoredArtifact & { base64?: string }>(
        path.join(directory, file),
      );
      if (stored) {
        const { base64: _bytes, ...snapshot } = stored;
        artifacts.push(snapshot);
      }
    }
    return artifacts.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  async listByJob(scope: RuntimeScope, jobId: string): Promise<readonly StoredArtifact[]> {
    const directory = this.directory(scope, 'artifacts');
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const output: StoredArtifact[] = [];
    for (const file of files.filter((file) => file.endsWith('.json'))) {
      const stored = await this.read<StoredArtifact>(path.join(directory, file));
      if (stored?.metadata?.jobId === jobId) {
        const artifact = await this.get(scope, stored.artifactId);
        if (artifact) output.push(artifact);
      }
    }
    return output;
  }

  async remove(scope: RuntimeScope, artifactId: string): Promise<void> {
    await unlink(this.path(scope, 'artifacts', artifactId)).catch((error) => {
      if (!missing(error)) throw error;
    });
  }

  createJournal(scope: RuntimeScope): PresentationJobEventJournal {
    const directory = this.directory(scope, 'events');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return new DurablePresentationJournal(scope, directory);
  }
}

class DurablePresentationJournal extends PresentationJobEventJournal {
  private readonly loaded = new Set<string>();

  constructor(
    scope: RuntimeScope,
    private readonly directory: string,
  ) {
    super({ scope });
  }

  private load(jobId: string): void {
    if (this.loaded.has(jobId)) return;
    try {
      const lines = readFileSync(path.join(this.directory, `${hash(jobId)}.jsonl`), 'utf8').split(
        '\n',
      );
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        try {
          super.append(jobId, JSON.parse(line));
        } catch (error) {
          if (index < lines.length - 1) throw error;
        }
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    this.loaded.add(jobId);
  }

  override has(jobId: string): boolean {
    this.load(jobId);
    return super.has(jobId);
  }
  override replay(jobId: string, afterSeq?: number): PresentationJobEvent[] {
    this.load(jobId);
    return super.replay(jobId, afterSeq);
  }
  override append(jobId: string, event: PresentationJobEvent): PresentationJobEvent | undefined {
    this.load(jobId);
    const appended = super.append(jobId, event);
    if (appended)
      appendFileSync(
        path.join(this.directory, `${hash(jobId)}.jsonl`),
        `${JSON.stringify(appended)}\n`,
        { mode: 0o600 },
      );
    return appended;
  }
}
