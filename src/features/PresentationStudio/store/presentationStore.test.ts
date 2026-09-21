import { describe, expect, it, vi } from 'vitest';

import type {
  ArtifactSnapshot,
  ExportResult,
  PresentationJob,
  PresentationJobInput,
} from '../../../../packages/runtime-contracts/src/index';
import { createPresentationDemoClient } from '../demo/presentationDemoClient';
import { createPresentationStudioStore, type PresentationClient } from './presentationStore';

const queuedJob = (override: Partial<PresentationJob> = {}): PresentationJob => ({
  createdAt: '2026-08-30T10:00:00.000Z',
  jobId: 'job-a',
  state: 'queued',
  updatedAt: '2026-08-30T10:00:00.000Z',
  ...override,
});

const input = (): PresentationJobInput => ({
  notebookId: 'studio',
  sourceVersionIds: ['src-1'],
  title: 'Q3 Report',
});

const readyArtifact = (override: Partial<ArtifactSnapshot> = {}): ArtifactSnapshot => ({
  artifactId: 'art-1',
  createdAt: '2026-08-30T10:01:00.000Z',
  mimeType: 'image/svg+xml',
  name: 'Slide 1.svg',
  sizeBytes: 123,
  status: 'ready',
  type: 'svg',
  updatedAt: '2026-08-30T10:01:00.000Z',
  uri: 'data:image/svg+xml,test',
  ...override,
});

const makeClient = (handlers: Partial<PresentationClient> = {}): PresentationClient => ({
  createPresentationJob: vi.fn(async () => queuedJob()),
  getPresentationJob: vi.fn(async () => queuedJob()),
  cancelPresentationJob: vi.fn(),
  retryPresentationJob: vi.fn(),
  getArtifact: vi.fn(),
  exportArtifact: vi.fn(),
  ...handlers,
});

describe('PresentationStudioStore', () => {
  it('createJob adds the job, remembers its title and selects it', async () => {
    const client = makeClient({
      createPresentationJob: vi.fn(async () => queuedJob({ jobId: 'job-a' })),
    });
    const store = createPresentationStudioStore(client);

    const jobId = await store.getState().createJob(input());

    expect(jobId).toBe('job-a');
    const state = store.getState();
    expect(state.jobs['job-a'].state).toBe('queued');
    expect(state.jobTitles['job-a']).toBe('Q3 Report');
    expect(state.selectedJobId).toBe('job-a');
  });

  it('createJob preserves the underlying provider error and adds no fabricated job', async () => {
    const client = makeClient({
      createPresentationJob: vi
        .fn()
        .mockRejectedValue(
          new Error('HTTP 503 PROVIDER_UNAVAILABLE: PPT Master is not configured'),
        ),
    });
    const store = createPresentationStudioStore(client);

    const jobId = await store.getState().createJob(input());

    expect(jobId).toBeNull();
    expect(Object.keys(store.getState().jobs)).toHaveLength(0);
    expect(store.getState().clientError?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(store.getState().clientError?.message).toBe('PPT Master is not configured');
  });

  it('refreshJob updates a job in place', async () => {
    const client = makeClient({
      getPresentationJob: vi.fn(async () => queuedJob({ state: 'running' })),
    });
    const store = createPresentationStudioStore(client);
    await store.getState().createJob(input());

    await store.getState().refreshJob('job-a');

    expect(store.getState().jobs['job-a'].state).toBe('running');
  });

  it('refreshJob keeps the last known honest state when the server returns null', async () => {
    const client = makeClient({
      getPresentationJob: vi.fn(async () => null),
    });
    const store = createPresentationStudioStore(client);
    await store.getState().createJob(input());

    await store.getState().refreshJob('job-a');

    expect(store.getState().jobs['job-a'].state).toBe('queued');
    expect(store.getState().clientError).toBeNull();
  });

  it('cancelJob applies the returned cancelled state', async () => {
    const client = makeClient({
      cancelPresentationJob: vi.fn(async () => queuedJob({ state: 'cancelled' })),
    });
    const store = createPresentationStudioStore(client);
    await store.getState().createJob(input());

    await store.getState().cancelJob('job-a');

    expect(store.getState().jobs['job-a'].state).toBe('cancelled');
  });

  it('deletes a work and clears only its local projections after the server confirms', async () => {
    const deletePresentationJob = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ deletePresentationJob });
    const store = createPresentationStudioStore(client);
    store.setState({
      artifacts: {
        'art-a': readyArtifact({ artifactId: 'art-a', metadata: { jobId: 'job-a' } }),
        'art-b': readyArtifact({ artifactId: 'art-b', metadata: { jobId: 'job-b' } }),
      },
      jobOrder: ['job-a', 'job-b'],
      jobs: {
        'job-a': queuedJob({ artifactIds: ['art-a'], jobId: 'job-a' }),
        'job-b': queuedJob({ artifactIds: ['art-b'], jobId: 'job-b' }),
      },
      jobTitles: { 'job-a': 'A', 'job-b': 'B' },
      selectedArtifactId: 'art-a',
      selectedJobId: 'job-a',
    });
    window.sessionStorage.setItem('presentation_studio_active_job_id', 'job-a');

    await expect(store.getState().deleteJob('job-a')).resolves.toBe(true);

    expect(deletePresentationJob).toHaveBeenCalledWith('job-a');
    expect(store.getState().jobOrder).toEqual(['job-b']);
    expect(store.getState().jobs['job-a']).toBeUndefined();
    expect(store.getState().artifacts['art-a']).toBeUndefined();
    expect(store.getState().artifacts['art-b']).toBeDefined();
    expect(store.getState().selectedJobId).toBeNull();
    expect(window.sessionStorage.getItem('presentation_studio_active_job_id')).toBeNull();
  });

  it('retryJob returns the job to queued and clears the previous error', async () => {
    const client = makeClient({
      retryPresentationJob: vi.fn(async () => queuedJob({ state: 'queued' })),
    });
    const store = createPresentationStudioStore(client);
    await store.getState().createJob(input());
    store.setState((s) => ({
      clientError: { code: 'HTTP_503', message: 'boom' },
      jobs: { ...s.jobs, 'job-a': { ...s.jobs['job-a'], state: 'failed' } },
    }));

    await store.getState().retryJob('job-a');

    expect(store.getState().jobs['job-a'].state).toBe('queued');
    expect(store.getState().clientError).toBeNull();
  });

  it('refreshArtifacts fetches missing snapshots and keeps failed ones visible', async () => {
    const failed = readyArtifact({ artifactId: 'art-failed', status: 'failed' });
    const client = makeClient({
      getArtifact: vi.fn(async (artifactId: string) =>
        artifactId === 'art-2' ? readyArtifact({ artifactId: 'art-2' }) : null,
      ),
    });
    const store = createPresentationStudioStore(client);
    store.setState({
      artifacts: { 'art-failed': failed },
      jobs: {
        'job-a': {
          ...queuedJob({ state: 'completed' }),
          artifactIds: ['art-failed', 'art-2'],
        },
      },
      jobOrder: ['job-a'],
      selectedJobId: 'job-a',
    });

    await store.getState().refreshArtifacts('job-a');

    const state = store.getState();
    expect(state.artifacts['art-failed'].status).toBe('failed');
    expect(state.artifacts['art-2'].status).toBe('ready');
  });

  it('exportArtifact stores the wire export result and clears the exporting flag', async () => {
    const result: ExportResult = {
      artifactId: 'art-1',
      format: 'pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      uri: 'https://files.example/art-1.pptx',
    };
    const client = makeClient({
      exportArtifact: vi.fn(async () => result),
    });
    const store = createPresentationStudioStore(client);

    await store.getState().exportArtifact('art-1', 'pptx');

    expect(store.getState().exported).toEqual(result);
    expect(store.getState().exporting).toBeNull();
  });

  it('exportArtifact failure surfaces in clientError and clears the exporting flag', async () => {
    const client = makeClient({
      exportArtifact: vi.fn().mockRejectedValue(new Error('HTTP 410 ARTIFACT_UNAVAILABLE')),
    });
    const store = createPresentationStudioStore(client);

    await store.getState().exportArtifact('art-1', 'pdf');

    expect(store.getState().exporting).toBeNull();
    expect(store.getState().clientError?.code).toBe('ARTIFACT_UNAVAILABLE');
  });

  it('selectJob anchors the artifact selection to the first artifact', () => {
    const store = createPresentationStudioStore(makeClient());
    store.setState({
      artifacts: {
        'art-1': readyArtifact(),
        'art-2': readyArtifact({ artifactId: 'art-2' }),
      },
      jobs: {
        'job-a': { ...queuedJob({ state: 'completed' }), artifactIds: ['art-1', 'art-2'] },
      },
      jobOrder: ['job-a'],
    });

    store.getState().selectJob('job-a');

    expect(store.getState().selectedArtifactId).toBe('art-1');

    store.getState().selectJob(null);
    expect(store.getState().selectedJobId).toBeNull();
    expect(store.getState().selectedArtifactId).toBeNull();
    expect(store.getState().jobOrder).toEqual(['job-a']);
    expect(store.getState().jobs['job-a'].artifactIds).toEqual(['art-1', 'art-2']);
    expect(store.getState().artifacts['art-1']).toEqual(readyArtifact());
    expect(window.sessionStorage.getItem('presentation_studio_active_job_id')).toBeNull();
  });

  it('drives the full create → cancel loop through the demo client seam', async () => {
    const demo = createPresentationDemoClient({ queuedMs: 60000, runningMs: 60000 });
    const store = createPresentationStudioStore(demo);

    const jobId = await store.getState().createJob(input());
    expect(jobId).toBeTruthy();
    expect(store.getState().jobs[jobId!].state).toBe('queued');

    await store.getState().cancelJob(jobId!);

    expect(store.getState().jobs[jobId!].state).toBe('cancelled');
  });
});
