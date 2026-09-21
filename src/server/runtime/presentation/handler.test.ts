import { describe, expect, it, vi } from 'vitest';

import type {
  PresentationFactoryScope,
  PresentationJob,
  PresentationPort,
  PresentationRouteMatch,
} from './handler';
import { handlePresentationRequest, matchPresentationRoute } from './handler';

const request = (path: string, init: RequestInit = {}): Request =>
  new Request(`https://example.test/api/runtime/presentation${path}`, init);

const scope = { userId: 'user-1', serverDB: 'db-1' };

const job = {
  jobId: 'job-1',
  state: 'completed',
  artifactIds: ['artifact-1'],
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:01.000Z',
} as PresentationJob;

const artifact = {
  artifactId: 'artifact-1',
  type: 'pptx',
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  status: 'ready',
  createdAt: '2026-08-27T00:00:01.000Z',
} as const;

const createPort = (): {
  port: PresentationPort;
  createJob: ReturnType<typeof vi.fn>;
  getJob: ReturnType<typeof vi.fn>;
  cancelJob: ReturnType<typeof vi.fn>;
  retryJob: ReturnType<typeof vi.fn>;
  getArtifact: ReturnType<typeof vi.fn>;
  exportArtifact: ReturnType<typeof vi.fn>;
} => {
  const createJob = vi.fn(async () => job);
  const getJob = vi.fn(async () => job);
  const cancelJob = vi.fn(async () => ({ ...job, state: 'cancelled' as const }));
  const retryJob = vi.fn(async () => ({ ...job, state: 'running' as const }));
  const getArtifact = vi.fn(async () => artifact);
  const exportArtifact = vi.fn(async () => ({ artifactId: 'export-1', format: 'pptx' as const }));
  return {
    port: { createJob, getJob, cancelJob, retryJob, getArtifact, exportArtifact },
    createJob,
    getJob,
    cancelJob,
    retryJob,
    getArtifact,
    exportArtifact,
  };
};

const post = (path: string, body: unknown): Request =>
  request(path, { method: 'POST', body: JSON.stringify(body) });

describe('presentation HTTP seam', () => {
  it('matches the presentation operations including destructive routes', () => {
    const cases: Array<[string, string, PresentationRouteMatch]> = [
      ['/jobs', 'POST', { operation: 'create' }],
      ['/jobs/job-1', 'GET', { operation: 'get', id: 'job-1' }],
      ['/jobs/job-1', 'DELETE', { operation: 'deleteJob', id: 'job-1' }],
      ['/jobs/job-1/cancel', 'POST', { operation: 'cancel', id: 'job-1' }],
      ['/jobs/job-1/retry', 'POST', { operation: 'retry', id: 'job-1' }],
      ['/artifacts/artifact-1', 'GET', { operation: 'getArtifact', id: 'artifact-1' }],
      ['/artifacts/export', 'POST', { operation: 'exportArtifact' }],
      ['/artifacts/artifact-1/export', 'POST', { operation: 'exportArtifact', id: 'artifact-1' }],
      ['/templates/template-1', 'DELETE', { operation: 'deleteTemplate', id: 'template-1' }],
    ];

    for (const [path, method, expected] of cases) {
      expect(matchPresentationRoute(request(path, { method }))).toEqual(expected);
    }
  });

  it('creates a job with the submitted PresentationJobInput', async () => {
    const { port, createJob } = createPort();
    const input = {
      notebookId: 'notebook-1',
      sourceVersionIds: ['version-1'],
      title: 'A deck',
      slideCount: 3,
    };

    const response = await handlePresentationRequest(
      post('/jobs', input),
      scope,
      { operation: 'create' },
      async () => port,
    );

    expect(response).toMatchObject({ status: 200, body: job });
    expect(createJob).toHaveBeenCalledWith(input);
  });

  it('gets a job by path id', async () => {
    const { port, getJob } = createPort();
    const response = await handlePresentationRequest(
      request('/jobs/job-1'),
      scope,
      { operation: 'get', id: 'job-1' },
      async () => port,
    );

    expect(response).toMatchObject({ status: 200, body: job });
    expect(getJob).toHaveBeenCalledWith('job-1');
  });

  it('deletes jobs and templates only through explicit DELETE operations', async () => {
    const { port } = createPort();
    const deleteJob = vi.fn().mockResolvedValue(undefined);
    const deleteTemplate = vi.fn().mockResolvedValue(undefined);
    const extended = Object.assign(port, {
      deleteJob,
      deleteTemplate,
      listTemplates: vi.fn().mockResolvedValue([]),
    });

    const deletedJob = await handlePresentationRequest(
      request('/jobs/job-1', { method: 'DELETE' }),
      scope,
      { operation: 'deleteJob', id: 'job-1' },
      async () => extended,
    );
    const deletedTemplate = await handlePresentationRequest(
      request('/templates/template-1', { method: 'DELETE' }),
      scope,
      { operation: 'deleteTemplate', id: 'template-1' },
      async () => extended,
    );

    expect(deletedJob).toMatchObject({
      body: { deleted: true, jobId: 'job-1' },
      status: 200,
    });
    expect(deletedTemplate).toMatchObject({
      body: { deleted: true, templateId: 'template-1' },
      status: 200,
    });
    expect(deleteJob).toHaveBeenCalledWith('job-1');
    expect(deleteTemplate).toHaveBeenCalledWith('template-1');
  });

  it('cancels a job and returns the port state', async () => {
    const { port, cancelJob } = createPort();
    const response = await handlePresentationRequest(
      post('/jobs/job-1/cancel', {}),
      scope,
      { operation: 'cancel', id: 'job-1' },
      async () => port,
    );

    expect(response).toMatchObject({ status: 200, body: { jobId: 'job-1', state: 'cancelled' } });
    expect(cancelJob).toHaveBeenCalledWith('job-1');
  });

  it('retries a job and returns the port state', async () => {
    const { port, retryJob } = createPort();
    const response = await handlePresentationRequest(
      post('/jobs/job-1/retry', {}),
      scope,
      { operation: 'retry', id: 'job-1' },
      async () => port,
    );

    expect(response).toMatchObject({ status: 200, body: { jobId: 'job-1', state: 'running' } });
    expect(retryJob).toHaveBeenCalledWith('job-1');
  });

  it('gets a real artifact snapshot without manufacturing ready state', async () => {
    const { port, getArtifact } = createPort();
    const response = await handlePresentationRequest(
      request('/artifacts/artifact-1'),
      scope,
      { operation: 'getArtifact', id: 'artifact-1' },
      async () => port,
    );

    expect(response).toMatchObject({ status: 200, body: artifact });
    expect(getArtifact).toHaveBeenCalledWith('artifact-1');
  });

  it('exports an artifact using the requested format', async () => {
    const { port, exportArtifact } = createPort();
    const response = await handlePresentationRequest(
      post('/artifacts/artifact-1/export', { format: 'pptx' }),
      scope,
      { operation: 'exportArtifact', id: 'artifact-1' },
      async () => port,
    );

    expect(response).toMatchObject({
      status: 200,
      body: { artifactId: 'export-1', format: 'pptx' },
    });
    expect(exportArtifact).toHaveBeenCalledWith('artifact-1', 'pptx');
  });

  it('also accepts export format from the query string', async () => {
    const { port, exportArtifact } = createPort();
    const response = await handlePresentationRequest(
      request('/artifacts/artifact-1/export?format=svg', { method: 'POST' }),
      scope,
      { operation: 'exportArtifact', id: 'artifact-1' },
      async () => port,
    );

    expect(response).toMatchObject({ status: 200 });
    expect(exportArtifact).toHaveBeenCalledWith('artifact-1', 'svg');
  });

  it('exports an artifact from the C-15-L collection endpoint body', async () => {
    const { port, exportArtifact } = createPort();
    const response = await handlePresentationRequest(
      post('/artifacts/export', { artifactId: 'artifact-1', format: 'pptx' }),
      scope,
      { operation: 'exportArtifact' },
      async () => port,
    );

    expect(response).toMatchObject({
      status: 200,
      body: { artifactId: 'export-1', format: 'pptx' },
    });
    expect(exportArtifact).toHaveBeenCalledWith('artifact-1', 'pptx');
  });

  it('maps missing jobs and artifacts to stable not-found errors', async () => {
    const { port, getJob, getArtifact } = createPort();
    getJob.mockResolvedValueOnce(null);
    getArtifact.mockResolvedValueOnce(null);

    const missingJob = await handlePresentationRequest(
      request('/jobs/missing'),
      scope,
      { operation: 'get', id: 'missing' },
      async () => port,
    );
    const missingArtifact = await handlePresentationRequest(
      request('/artifacts/missing'),
      scope,
      { operation: 'getArtifact', id: 'missing' },
      async () => port,
    );

    expect(missingJob).toMatchObject({
      status: 404,
      body: { error: { code: 'PRESENTATION_NOT_FOUND' } },
    });
    expect(missingArtifact).toMatchObject({
      status: 404,
      body: { error: { code: 'PRESENTATION_NOT_FOUND' } },
    });
  });

  it('preserves PROVIDER_UNAVAILABLE from an unconfigured factory', async () => {
    const response = await handlePresentationRequest(
      request('/jobs/job-1'),
      scope,
      { operation: 'get', id: 'job-1' },
      async () => {
        throw Object.assign(new Error('no provider'), { code: 'PROVIDER_UNAVAILABLE' });
      },
    );

    expect(response).toMatchObject({
      status: 503,
      body: { error: { code: 'PROVIDER_UNAVAILABLE', message: 'no provider' } },
    });
  });

  it('preserves PPTX_INVALID from the injected PresentationPort', async () => {
    const { port, exportArtifact } = createPort();
    exportArtifact.mockRejectedValueOnce(
      Object.assign(new Error('invalid OOXML'), { code: 'PPTX_INVALID', path: 'artifact' }),
    );

    const response = await handlePresentationRequest(
      post('/artifacts/artifact-1/export', { format: 'pptx' }),
      scope,
      { operation: 'exportArtifact', id: 'artifact-1' },
      async () => port,
    );

    expect(response).toMatchObject({
      status: 502,
      body: { error: { code: 'PPTX_INVALID', path: 'artifact' } },
    });
  });

  it('rejects malformed JSON and invalid export format at the HTTP boundary', async () => {
    const { port, createJob, exportArtifact } = createPort();
    const factory = async () => port;
    const malformed = await handlePresentationRequest(
      request('/jobs', { method: 'POST', body: '{' }),
      scope,
      { operation: 'create' },
      factory,
    );
    const invalidFormat = await handlePresentationRequest(
      post('/artifacts/artifact-1/export', { format: 'docx' }),
      scope,
      { operation: 'exportArtifact', id: 'artifact-1' },
      factory,
    );

    expect(malformed).toMatchObject({
      status: 400,
      body: { error: { code: 'PRESENTATION_INVALID', path: '$' } },
    });
    expect(invalidFormat).toMatchObject({
      status: 400,
      body: { error: { code: 'PRESENTATION_INVALID', path: 'format' } },
    });
    expect(createJob).not.toHaveBeenCalled();
    expect(exportArtifact).not.toHaveBeenCalled();
  });

  it('passes the authenticated user and database scope to each factory call', async () => {
    const { port } = createPort();
    const scopes: PresentationFactoryScope[] = [];
    const factory = vi.fn(async (value: PresentationFactoryScope) => {
      scopes.push(value);
      return port;
    });

    await handlePresentationRequest(
      request('/jobs/job-1'),
      { userId: 'user-a', serverDB: 'db-a' },
      { operation: 'get', id: 'job-1' },
      factory,
    );
    await handlePresentationRequest(
      request('/jobs/job-2'),
      { userId: 'user-b', serverDB: 'db-b' },
      { operation: 'get', id: 'job-2' },
      factory,
    );

    expect(scopes.map(({ userId, serverDB }) => ({ userId, serverDB }))).toEqual([
      { userId: 'user-a', serverDB: 'db-a' },
      { userId: 'user-b', serverDB: 'db-b' },
    ]);
  });

  it('returns failed job state exactly as provided by the port', async () => {
    const failedJob = {
      ...job,
      state: 'failed' as const,
      error: { code: 'PPTX_INVALID', message: 'bad artifact' },
    };
    const { port } = createPort();
    port.createJob = vi.fn(async () => failedJob);

    const response = await handlePresentationRequest(
      post('/jobs', {
        notebookId: 'notebook-1',
        sourceVersionIds: ['version-1'],
        title: 'A deck',
      }),
      scope,
      { operation: 'create' },
      async () => port,
    );

    expect(response).toMatchObject({ status: 200, body: failedJob });
    expect(response).not.toMatchObject({ body: { state: 'ready' } });
  });
});
