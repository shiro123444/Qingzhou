import { describe, expect, it, vi } from 'vitest';

import type {
  ArtifactSnapshot,
  ExportResult,
  PluginDescriptor,
  PresentationJob,
  PresentationJobInput,
  RunSnapshot,
  RuntimeEvent,
  StartRunInput,
} from '../../../packages/runtime-contracts/src/index';
import { RuntimeClientImpl } from './client';

describe('RuntimeClient', () => {
  it('startRun posts to /api/runtime/v1/runs and returns RunSnapshot', async () => {
    const mockSnapshot: RunSnapshot = {
      createdAt: '2026-08-26T00:00:00Z',
      profileId: 'agent-1',
      runId: 'run-123',
      sessionId: 'session-1',
      state: 'queued',
      updatedAt: '2026-08-26T00:00:00Z',
    };

    const mockFetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockSnapshot), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });
    const input: StartRunInput = {
      profileId: 'agent-1',
      sessionId: 'session-1',
      userMessage: 'hello cordis',
    };

    const result = await client.startRun(input);

    expect(mockFetcher).toHaveBeenCalledWith(
      '/api/runtime/v1/runs',
      expect.objectContaining({
        body: JSON.stringify(input),
        method: 'POST',
      }),
    );
    expect(result).toEqual(mockSnapshot);
  });

  it('getRun returns snapshot or null on 404', async () => {
    const mockSnapshot: RunSnapshot = {
      createdAt: '2026-08-26T00:00:00Z',
      runId: 'run-123',
      sessionId: 'session-1',
      state: 'running',
      updatedAt: '2026-08-26T00:00:01Z',
    };

    const mockFetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockSnapshot), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });

    const found = await client.getRun('run-123');
    expect(found).toEqual(mockSnapshot);

    const notFound = await client.getRun('run-unknown');
    expect(notFound).toBeNull();
  });

  it('cancelRun posts to /api/runtime/v1/runs/:id/cancel', async () => {
    const mockFetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const client = new RuntimeClientImpl({ fetcher: mockFetcher });

    await client.cancelRun('run-456');

    expect(mockFetcher).toHaveBeenCalledWith(
      '/api/runtime/v1/runs/run-456/cancel',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('listPlugins and mountPlugin interact with plugin endpoints', async () => {
    const mockPlugins: PluginDescriptor[] = [
      { id: 'general-chat', kind: 'agent-strategy', version: '1.0.0' },
    ];
    const mockFetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockPlugins), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: 'active' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });

    const plugins = await client.listPlugins();
    expect(plugins).toEqual(mockPlugins);

    const state = await client.mountPlugin('general-chat', { enabled: true });
    expect(state).toBe('active');
  });

  it('subscribe supports after_seq and streams RuntimeEvents', async () => {
    const events: RuntimeEvent[] = [
      {
        data: { text: 'chunk 1' },
        protocol_version: 'runtime.v1',
        run_id: 'run-123',
        seq: 1,
        session_id: 'session-1',
        type: 'text_delta',
      },
      {
        data: { state: 'completed' },
        protocol_version: 'runtime.v1',
        run_id: 'run-123',
        seq: 2,
        session_id: 'session-1',
        type: 'run_state',
      },
    ];

    const ssePayload = [
      `id: 1\ndata: ${JSON.stringify(events[0])}\n\n`,
      `id: 2\ndata: ${JSON.stringify(events[1])}\n\n`,
    ].join('');

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ssePayload));
        controller.close();
      },
    });

    const mockFetcher = vi.fn().mockResolvedValue(
      new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
        status: 200,
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });
    const collected: RuntimeEvent[] = [];

    for await (const ev of client.subscribe('run-123', 0)) {
      collected.push(ev);
    }

    expect(mockFetcher).toHaveBeenCalledWith(
      '/api/runtime/v1/runs/run-123/events?after_seq=0',
      expect.objectContaining({
        headers: expect.any(Headers),
        method: 'GET',
      }),
    );
    expect(collected).toEqual(events);
  });

  it('subscribe deduplicates events with identical seq in same stream', async () => {
    const ev1: RuntimeEvent = {
      data: { text: 'first' },
      protocol_version: 'runtime.v1',
      run_id: 'run-dup',
      seq: 10,
      session_id: 'session-1',
      type: 'delta',
    };
    const ev2: RuntimeEvent = {
      data: { text: 'second' },
      protocol_version: 'runtime.v1',
      run_id: 'run-dup',
      seq: 11,
      session_id: 'session-1',
      type: 'delta',
    };

    const ssePayload = [
      `data: ${JSON.stringify(ev1)}\n\n`,
      `data: ${JSON.stringify(ev1)}\n\n`,
      `data: ${JSON.stringify(ev2)}\n\n`,
    ].join('');

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ssePayload));
        controller.close();
      },
    });

    const mockFetcher = vi.fn().mockResolvedValue(
      new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
        status: 200,
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });
    const collected: RuntimeEvent[] = [];

    for await (const ev of client.subscribe('run-dup')) {
      collected.push(ev);
    }

    expect(collected.length).toBe(2);
    expect(collected[0].seq).toBe(10);
    expect(collected[1].seq).toBe(11);
  });

  it('subscribe invokes onSeqReceived for sequence tracking during reconnection', async () => {
    const seqHistory: number[] = [];
    const ev1: RuntimeEvent = {
      data: 'a',
      protocol_version: 'runtime.v1',
      run_id: 'run-rec',
      seq: 5,
      session_id: 's-1',
      type: 'test',
    };
    const ev2: RuntimeEvent = {
      data: 'b',
      protocol_version: 'runtime.v1',
      run_id: 'run-rec',
      seq: 6,
      session_id: 's-1',
      type: 'test',
    };

    const ssePayload = `data: ${JSON.stringify(ev1)}\n\ndata: ${JSON.stringify(ev2)}\n\n`;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ssePayload));
        controller.close();
      },
    });

    const mockFetcher = vi.fn().mockResolvedValue(
      new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
        status: 200,
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });

    for await (const _ of client.subscribe('run-rec', 4, {
      onSeqReceived: (seq) => seqHistory.push(seq),
    })) {
      // consume
    }

    expect(seqHistory).toEqual([5, 6]);
  });

  it('subscribe filters out events less than or equal to afterSeq', async () => {
    const ev1: RuntimeEvent = {
      data: 'old',
      protocol_version: 'runtime.v1',
      run_id: 'run-filter',
      seq: 3,
      session_id: 's-1',
      type: 'test',
    };
    const ev2: RuntimeEvent = {
      data: 'new',
      protocol_version: 'runtime.v1',
      run_id: 'run-filter',
      seq: 4,
      session_id: 's-1',
      type: 'test',
    };

    const ssePayload = `data: ${JSON.stringify(ev1)}\n\ndata: ${JSON.stringify(ev2)}\n\n`;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ssePayload));
        controller.close();
      },
    });

    const mockFetcher = vi.fn().mockResolvedValue(
      new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
        status: 200,
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });
    const collected: RuntimeEvent[] = [];

    for await (const ev of client.subscribe('run-filter', 3)) {
      collected.push(ev);
    }

    expect(collected.length).toBe(1);
    expect(collected[0].seq).toBe(4);
  });

  // --- Presentation Client Seam Tests (C-15-L) ---

  it('createPresentationJob posts to /api/runtime/presentation/jobs and returns PresentationJob', async () => {
    const mockJob: PresentationJob = {
      createdAt: '2026-08-27T00:00:00Z',
      jobId: 'pres-job-1',
      state: 'queued',
      updatedAt: '2026-08-27T00:00:00Z',
    };

    const mockFetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockJob), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });
    const input: PresentationJobInput = {
      notebookId: 'nb-1',
      sourceVersionIds: ['v1', 'v2'],
      title: 'Quarterly Strategy Deck',
    };

    const result = await client.createPresentationJob(input);

    expect(mockFetcher).toHaveBeenCalledWith(
      '/api/runtime/presentation/jobs',
      expect.objectContaining({
        body: JSON.stringify(input),
        method: 'POST',
      }),
    );
    expect(result).toEqual(mockJob);
  });

  it('createPresentationJob faithfully preserves backend error without faking ready state', async () => {
    const mockFetcher = vi.fn().mockResolvedValue(
      new Response('PROVIDER_UNAVAILABLE: PPT Master worker offline', {
        status: 503,
        statusText: 'Service Unavailable',
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });
    const input: PresentationJobInput = {
      notebookId: 'nb-1',
      sourceVersionIds: ['v1'],
      title: 'Failed Job Test',
    };

    await expect(client.createPresentationJob(input)).rejects.toThrow(
      /Failed to create presentation job \(503 Service Unavailable\): PROVIDER_UNAVAILABLE/,
    );
  });

  it('createPresentationJob respects AbortSignal', async () => {
    const controller = new AbortController();
    const mockFetcher = vi.fn().mockImplementation((_url, options) => {
      if (options?.signal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }
      return Promise.resolve(new Response(JSON.stringify({ jobId: 'j-1' }), { status: 200 }));
    });

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });
    controller.abort();

    await expect(
      client.createPresentationJob(
        { notebookId: 'nb-1', sourceVersionIds: ['v1'], title: 'Aborted' },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();

    expect(mockFetcher).toHaveBeenCalledWith(
      '/api/runtime/presentation/jobs',
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  it('getPresentationJob returns PresentationJob on 200 and null on 404', async () => {
    const mockJob: PresentationJob = {
      artifactIds: ['art-1'],
      createdAt: '2026-08-27T00:00:00Z',
      jobId: 'pres-job-2',
      state: 'completed',
      updatedAt: '2026-08-27T00:00:10Z',
    };

    const mockFetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockJob), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });

    const found = await client.getPresentationJob('pres-job-2');
    expect(found).toEqual(mockJob);

    const notFound = await client.getPresentationJob('pres-job-unknown');
    expect(notFound).toBeNull();
  });

  it('getPresentationJob propagates network/server protocol error', async () => {
    const mockFetcher = vi.fn().mockResolvedValue(
      new Response('Internal Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });

    await expect(client.getPresentationJob('pres-job-err')).rejects.toThrow(
      /Failed to get presentation job pres-job-err \(500 Internal Server Error\)/,
    );
  });

  it('deletePresentationJob deletes the selected job endpoint', async () => {
    const mockFetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
    const client = new RuntimeClientImpl({ fetcher: mockFetcher });

    await client.deletePresentationJob('pres job/1');

    expect(mockFetcher).toHaveBeenCalledWith(
      '/api/runtime/presentation/jobs/pres%20job%2F1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('cancelPresentationJob posts to /api/runtime/presentation/jobs/:id/cancel and returns job', async () => {
    const cancelledJob: PresentationJob = {
      createdAt: '2026-08-27T00:00:00Z',
      jobId: 'pres-job-3',
      state: 'cancelled',
      updatedAt: '2026-08-27T00:00:05Z',
    };

    const mockFetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(cancelledJob), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });
    const result = await client.cancelPresentationJob('pres-job-3');

    expect(mockFetcher).toHaveBeenCalledWith(
      '/api/runtime/presentation/jobs/pres-job-3/cancel',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(result).toEqual(cancelledJob);
  });

  it('retryPresentationJob posts to /api/runtime/presentation/jobs/:id/retry and returns job', async () => {
    const retriedJob: PresentationJob = {
      createdAt: '2026-08-27T00:00:00Z',
      jobId: 'pres-job-4',
      state: 'queued',
      updatedAt: '2026-08-27T00:00:06Z',
    };

    const mockFetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(retriedJob), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });
    const result = await client.retryPresentationJob('pres-job-4');

    expect(mockFetcher).toHaveBeenCalledWith(
      '/api/runtime/presentation/jobs/pres-job-4/retry',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(result).toEqual(retriedJob);
  });

  it('getArtifact returns ArtifactSnapshot on 200 and null on 404', async () => {
    const mockArtifact: ArtifactSnapshot = {
      artifactId: 'art-pptx-1',
      createdAt: '2026-08-27T00:00:00Z',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      name: 'Strategy.pptx',
      sizeBytes: 1048576,
      status: 'ready',
      type: 'presentation',
      uri: '/api/runtime/presentation/artifacts/art-pptx-1/download',
    };

    const mockFetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockArtifact), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });

    const found = await client.getArtifact('art-pptx-1');
    expect(found).toEqual(mockArtifact);

    const notFound = await client.getArtifact('art-nonexistent');
    expect(notFound).toBeNull();
  });

  it('getArtifact faithfully preserves backend errors without faking ready status', async () => {
    const mockFetcher = vi.fn().mockResolvedValue(
      new Response('Database query failed', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });

    await expect(client.getArtifact('art-err')).rejects.toThrow(
      /Failed to get artifact art-err \(500 Internal Server Error\)/,
    );
  });

  it('exportArtifact posts to /api/runtime/presentation/artifacts/export and returns ExportResult', async () => {
    const mockExport: ExportResult = {
      artifactId: 'art-pptx-1',
      format: 'pdf',
      mimeType: 'application/pdf',
      uri: '/api/runtime/presentation/artifacts/art-pptx-1/export?format=pdf',
    };

    const mockFetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockExport), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });
    const result = await client.exportArtifact('art-pptx-1', 'pdf');

    expect(mockFetcher).toHaveBeenCalledWith(
      '/api/runtime/presentation/artifacts/export',
      expect.objectContaining({
        body: JSON.stringify({ artifactId: 'art-pptx-1', format: 'pdf' }),
        method: 'POST',
      }),
    );
    expect(result).toEqual(mockExport);
  });

  it('exportArtifact respects AbortSignal and propagates export failures', async () => {
    const mockFetcher = vi.fn().mockResolvedValue(
      new Response('PDF Conversion Failed: LibreOffice timeout', {
        status: 504,
        statusText: 'Gateway Timeout',
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });

    await expect(client.exportArtifact('art-pptx-1', 'pdf')).rejects.toThrow(
      /Failed to export artifact art-pptx-1 \(504 Gateway Timeout\): PDF Conversion Failed/,
    );
  });

  it('exportArtifact rejects empty or whitespace URI from backend', async () => {
    const mockFetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ artifactId: 'art-1', format: 'pdf', uri: '   ' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });
    await expect(client.exportArtifact('art-1', 'pdf')).rejects.toThrow(
      /Export result returned an empty URI for artifact art-1/,
    );
  });

  it('downloadArtifact requests octet-stream and returns real Blob', async () => {
    const binaryData = new Uint8Array([1, 2, 3, 4]);
    const mockFetcher = vi.fn().mockResolvedValue(
      new Response(binaryData, {
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        },
        status: 200,
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });
    const blob = await client.downloadArtifact('art-pptx-1');

    expect(mockFetcher).toHaveBeenCalledWith(
      '/api/runtime/presentation/artifacts/art-pptx-1',
      expect.objectContaining({
        headers: expect.any(Headers),
        method: 'GET',
      }),
    );
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(4);
  });

  it('subscribePresentationJob incrementally resumes stream from afterSeq on reconnect', async () => {
    const sseBody = [
      'data: {"protocol_version":"runtime.v1","job_id":"job-resume","seq":3,"type":"artifactReady","data":{"artifact":{"artifactId":"job-resume:slide:1","status":"ready"}}}\n\n',
      'data: {"protocol_version":"runtime.v1","job_id":"job-resume","seq":4,"type":"completed","data":{"job":{"jobId":"job-resume","state":"completed"}}}\n\n',
    ].join('');

    const mockFetcher = vi.fn().mockResolvedValue(
      new Response(sseBody, {
        headers: { 'Content-Type': 'text/event-stream' },
        status: 200,
      }),
    );

    const client = new RuntimeClientImpl({ fetcher: mockFetcher });
    const receivedSeqs: number[] = [];
    const receivedEvents = [];

    for await (const event of client.subscribePresentationJob('job-resume', {
      afterSeq: 2,
      onSeqReceived: (seq) => receivedSeqs.push(seq),
    })) {
      receivedEvents.push(event);
    }

    expect(mockFetcher).toHaveBeenCalledWith(
      '/api/runtime/presentation/jobs/job-resume/events?after_seq=2',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(receivedSeqs).toEqual([3, 4]);
    expect(receivedEvents).toHaveLength(2);
    expect(receivedEvents[0].seq).toBe(3);
    expect(receivedEvents[1].seq).toBe(4);
  });

  it('listPresentationJobs degrades a body without a jobs array to an empty list', async () => {
    // The studio maps the result straight into its store, so a missing array used to throw
    // `Cannot read properties of undefined (reading 'map')` and surface an internal error.
    for (const body of [{}, { jobs: null }, { jobs: 'nope' }]) {
      const mockFetcher = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      );
      await expect(
        new RuntimeClientImpl({ fetcher: mockFetcher }).listPresentationJobs(),
      ).resolves.toEqual([]);
    }

    const withJobs = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jobs: [{ jobId: 'job-1' }] }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );
    await expect(
      new RuntimeClientImpl({ fetcher: withJobs }).listPresentationJobs(),
    ).resolves.toEqual([{ jobId: 'job-1' }]);
  });
});
