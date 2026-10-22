import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  PresentationJobInput,
  PresentationRunner,
  PresentationRunnerProcess,
  PresentationRunnerRequest,
  PresentationRunnerResult,
  PresentationWorkspace,
} from './index';
import { PptMasterAdapter, serializePresentationInput } from './index';

const input: PresentationJobInput = {
  notebookId: 'notebook-1',
  sourceVersionIds: ['version-1'],
  title: 'Runtime presentation',
};

const bytesFor = (value: string): Uint8Array => new TextEncoder().encode(value);

const put16 = (target: number[], value: number): void => {
  target.push(value & 0xff, (value >>> 8) & 0xff);
};

const put32 = (target: number[], value: number): void => {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
};

const minimalPptx = (): Uint8Array => {
  const name = bytesFor('[Content_Types].xml');
  const local: number[] = [0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  put32(local, 0);
  put32(local, 0);
  put16(local, name.length);
  put16(local, 0);
  local.push(...name);

  const central: number[] = [
    0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ];
  put32(central, 0);
  put32(central, 0);
  put16(central, name.length);
  put16(central, 0);
  put16(central, 0);
  put16(central, 0);
  put16(central, 0);
  put32(central, 0);
  put32(central, 0);
  central.push(...name);

  const end: number[] = [0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0];
  put16(end, 1);
  put16(end, 1);
  put32(end, central.length);
  put32(end, local.length);
  put16(end, 0);

  return new Uint8Array([...local, ...central, ...end]);
};

const validPptx = minimalPptx();

const resultFor = (
  bytes: Uint8Array = validPptx,
  path = 'output.pptx',
): PresentationRunnerResult => ({
  exitCode: 0,
  outputBytes: bytes.byteLength,
  artifacts: [
    {
      path,
      bytes,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
  ],
});

interface MockRunnerBundle {
  processes: PresentationRunnerProcess[];
  requests: PresentationRunnerRequest[];
  runner: PresentationRunner;
  workspaces: PresentationWorkspace[];
}

const mockRunner = (
  results: readonly PresentationRunnerResult[] = [resultFor()],
): MockRunnerBundle => {
  const requests: PresentationRunnerRequest[] = [];
  const processes: PresentationRunnerProcess[] = [];
  const workspaces: PresentationWorkspace[] = [];
  let resultIndex = 0;

  const runner: PresentationRunner = {
    id: 'ppt-master',
    spawn: vi.fn((request) => {
      requests.push(request);
      const result = results[resultIndex++] ?? results.at(-1) ?? resultFor();
      const process: PresentationRunnerProcess = {
        result: Promise.resolve(result),
        cancel: vi.fn(),
      };
      processes.push(process);
      return process;
    }),
  };

  return { runner, requests, processes, workspaces };
};

const adapterFor = (bundle: MockRunnerBundle, timeoutMs = 100): PptMasterAdapter => {
  let nextJob = 0;
  return new PptMasterAdapter({
    provider: 'ppt-master',
    runner: bundle.runner,
    allowedRunnerIds: ['ppt-master'],
    timeoutMs,
    maxOutputBytes: 1024,
    idFactory: () => `job-${++nextJob}`,
    workspaceFactory: async (jobId) => {
      const workspace: PresentationWorkspace = {
        path: nodePath.join(tmpdir(), 'herdr-presentation', jobId),
        cleanup: vi.fn(),
      };
      bundle.workspaces.push(workspace);
      return workspace;
    },
  });
};

describe('@lobechat/cordis-kernel PptMasterAdapter', () => {
  it('passes stable UTF-8 input.json to create runners without putting JSON in argv', async () => {
    const bundle = mockRunner();
    const adapter = adapterFor(bundle);
    const reordered: PresentationJobInput = {
      sourceVersionIds: ['version-1'],
      title: 'Runtime presentation',
      notebookId: 'notebook-1',
      options: { z: 2, a: 1 },
    };

    await adapter.createJob(reordered);
    const request = bundle.requests[0]!;
    expect(request.inputArtifact?.path).toBe(
      nodePath.join(bundle.workspaces[0]!.path, 'input.json'),
    );
    expect(new TextDecoder().decode(request.inputArtifact?.bytes)).toBe(
      '{"notebookId":"notebook-1","options":{"a":1,"z":2},"sourceVersionIds":["version-1"],"title":"Runtime presentation"}',
    );
    expect(request.args).not.toContain('--input-json');
    expect(request.args).not.toContain(expect.stringContaining('Runtime presentation'));
    expect(request.shell).toBe(false);
    expect(request.inputArtifact?.bytes).toEqual(serializePresentationInput(reordered));
  });

  it('rejects createJob with PROVIDER_UNAVAILABLE when runner/provider is absent', async () => {
    const adapter = new PptMasterAdapter({ idFactory: () => 'job-unconfigured' });

    await expect(adapter.createJob(input)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    await expect(adapter.getJob('job-unconfigured')).resolves.toMatchObject({ state: 'failed' });
  });

  it('creates a completed job only after a valid PPTX artifact is returned', async () => {
    const bundle = mockRunner();
    const adapter = adapterFor(bundle);

    const job = await adapter.createJob(input);

    expect(job).toMatchObject({ jobId: 'job-1', state: 'completed', artifactIds: ['job-1:0'] });
    expect(await adapter.getArtifact('job-1:0')).toMatchObject({
      artifactId: 'job-1:0',
      status: 'ready',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    expect(bundle.requests[0]).toMatchObject({
      cwd: bundle.workspaces[0]!.path,
      shell: false,
      timeoutMs: 100,
      maxOutputBytes: 1024,
    });
    expect(Array.isArray(bundle.requests[0]?.args)).toBe(true);
    expect(bundle.workspaces[0]?.cleanup).toHaveBeenCalledOnce();
  });

  it('keeps provider SVG previews alongside the PPTX artifact', async () => {
    const bundle = mockRunner([
      {
        ...resultFor(),
        artifacts: [
          resultFor().artifacts![0]!,
          { path: 'preview/slide_01.svg', bytes: bytesFor('<svg/>'), type: 'svg' },
        ],
      },
    ]);
    const adapter = adapterFor(bundle);

    const job = await adapter.createJob(input);

    expect(job).toMatchObject({ state: 'completed', artifactIds: ['job-1:0', 'job-1:1'] });
    await expect(adapter.getArtifact('job-1:1')).resolves.toMatchObject({
      type: 'svg',
      mimeType: 'image/svg+xml',
      status: 'ready',
      uri: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
    });
  });

  it('exposes artifact bytes through a defensive-copy server-only seam', async () => {
    const bundle = mockRunner();
    const adapter = adapterFor(bundle);
    await adapter.createJob(input);

    const bytes = await adapter.readArtifactBytes('job-1:0');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toEqual(validPptx);
    if (bytes) bytes[0] = 0xff;
    await expect(adapter.readArtifactBytes('job-1:0')).resolves.toEqual(validPptx);
    await expect(adapter.readArtifactBytes('missing')).resolves.toBeNull();
  });

  it('uses an independent workspace and argument array for every job', async () => {
    const bundle = mockRunner([resultFor(), resultFor()]);
    const adapter = adapterFor(bundle);

    await adapter.createJob(input);
    await adapter.createJob({ ...input, title: 'Second presentation' });

    expect(new Set(bundle.requests.map(({ cwd }) => cwd)).size).toBe(2);
    expect(bundle.requests.every(({ shell, args }) => shell === false && Array.isArray(args))).toBe(
      true,
    );
  });

  it('fails honestly when the runner returns invalid PPTX bytes', async () => {
    const bundle = mockRunner([resultFor(bytesFor('not a zip'), 'output.pptx')]);
    const adapter = adapterFor(bundle);

    const job = await adapter.createJob(input);

    expect(job).toMatchObject({ state: 'failed', error: { code: 'PPTX_INVALID' } });
    expect(job.artifactIds).toBeUndefined();
  });

  it('preserves a non-zero runner result as a failed job', async () => {
    const bundle = mockRunner([{ exitCode: 7, stderr: 'runner failed', outputBytes: 12 }]);
    const adapter = adapterFor(bundle);

    const job = await adapter.createJob(input);

    expect(job).toMatchObject({
      state: 'failed',
      error: { code: 'PPT_MASTER_FAILED', message: 'runner failed' },
    });
  });

  it('rejects a runner that is not in the allow-list', async () => {
    const bundle = mockRunner();
    bundle.runner = { ...bundle.runner, id: 'untrusted-runner' };
    const adapter = new PptMasterAdapter({
      provider: 'ppt-master',
      runner: bundle.runner,
      allowedRunnerIds: ['ppt-master'],
      idFactory: () => 'job-untrusted',
      workspaceFactory: async (jobId) => ({ path: `/tmp/${jobId}`, cleanup: vi.fn() }),
    });

    await expect(adapter.createJob(input)).rejects.toMatchObject({
      code: 'PRESENTATION_RUNNER_NOT_ALLOWED',
    });
    expect(bundle.runner.spawn).not.toHaveBeenCalled();
  });

  it('times out, cancels the process, and marks the job failed', async () => {
    let release!: (result: PresentationRunnerResult) => void;
    const process: PresentationRunnerProcess = {
      result: new Promise((resolve) => {
        release = resolve;
      }),
      cancel: vi.fn(),
    };
    const bundle = mockRunner();
    bundle.runner = { ...bundle.runner, spawn: vi.fn(() => process) };
    const adapter = adapterFor(bundle, 5);

    const jobPromise = adapter.createJob(input);
    const job = await jobPromise;
    release({ exitCode: 0, artifacts: [] });

    expect(job).toMatchObject({ state: 'failed', error: { code: 'PRESENTATION_TIMEOUT' } });
    expect(process.cancel).toHaveBeenCalledOnce();
  });

  it('enforces the output byte limit before accepting artifacts', async () => {
    const bundle = mockRunner([{ ...resultFor(), outputBytes: 2048 }]);
    const adapter = adapterFor(bundle);

    const job = await adapter.createJob(input);

    expect(job).toMatchObject({ state: 'failed', error: { code: 'PRESENTATION_OUTPUT_LIMIT' } });
  });

  it('cancels a running job through the runner process handle', async () => {
    let release!: (result: PresentationRunnerResult) => void;
    const process: PresentationRunnerProcess = {
      result: new Promise((resolve) => {
        release = resolve;
      }),
      cancel: vi.fn(),
    };
    const bundle = mockRunner();
    bundle.runner = { ...bundle.runner, spawn: vi.fn(() => process) };
    const adapter = adapterFor(bundle);
    const jobPromise = adapter.createJob(input);

    await Promise.resolve();
    const cancelled = await adapter.cancelJob('job-1');
    release({ exitCode: 0, artifacts: [resultFor().artifacts![0]!] });

    expect(cancelled).toMatchObject({ jobId: 'job-1', state: 'cancelled' });
    await expect(jobPromise).resolves.toMatchObject({ state: 'cancelled' });
    expect(process.cancel).toHaveBeenCalledOnce();
  });

  it('retries a failed job and replaces failure with a real completed result', async () => {
    const bundle = mockRunner([
      resultFor(bytesFor('invalid'), 'output.pptx'),
      resultFor(validPptx, 'retry-output.pptx'),
    ]);
    const adapter = adapterFor(bundle);

    await expect(adapter.createJob(input)).resolves.toMatchObject({ state: 'failed' });
    const retried = await adapter.retryJob('job-1');

    expect(retried).toMatchObject({ state: 'completed', artifactIds: ['job-1:0'] });
    expect(bundle.requests).toHaveLength(2);
  });

  it('makes terminal cancel/retry operations idempotent', async () => {
    const bundle = mockRunner();
    const adapter = adapterFor(bundle);
    await adapter.createJob(input);

    await expect(adapter.cancelJob('job-1')).resolves.toMatchObject({ state: 'completed' });
    await expect(adapter.retryJob('job-1')).resolves.toMatchObject({ state: 'completed' });
  });

  it('exports a validated PPTX artifact through a fresh runner workspace', async () => {
    const bundle = mockRunner([resultFor(), resultFor(validPptx, 'exported.pptx')]);
    const adapter = adapterFor(bundle);
    await adapter.createJob(input);

    const exported = await adapter.exportArtifact('job-1:0', 'pptx');

    expect(exported).toMatchObject({
      artifactId: 'job-1:0:export:pptx',
      format: 'pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    expect(await adapter.getArtifact(exported.artifactId)).toMatchObject({ status: 'ready' });
    expect(bundle.workspaces).toHaveLength(2);
    expect(bundle.requests[1]?.args).toContain('pptx');
  });

  it('rejects an invalid PPTX export instead of returning fake ready state', async () => {
    const bundle = mockRunner([resultFor(), resultFor(bytesFor('invalid'), 'exported.pptx')]);
    const adapter = adapterFor(bundle);
    await adapter.createJob(input);

    await expect(adapter.exportArtifact('job-1:0', 'pptx')).rejects.toMatchObject({
      code: 'PPTX_INVALID',
    });
    await expect(adapter.getArtifact('job-1:0:export:pptx')).resolves.toBeNull();
  });

  it('returns missing jobs/artifacts as null and rejects unknown operations', async () => {
    const adapter = new PptMasterAdapter();

    await expect(adapter.getJob('missing')).resolves.toBeNull();
    await expect(adapter.getArtifact('missing')).resolves.toBeNull();
    await expect(adapter.cancelJob('missing')).rejects.toMatchObject({
      code: 'PRESENTATION_NOT_FOUND',
    });
    await expect(adapter.exportArtifact('missing', 'svg')).rejects.toMatchObject({
      code: 'PRESENTATION_NOT_FOUND',
    });
  });
});
