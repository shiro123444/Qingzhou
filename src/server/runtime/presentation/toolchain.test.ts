import { describe, expect, it, vi } from 'vitest';

import type {
  PresentationRunner,
  PresentationRunnerResult,
} from '../../../../packages/cordis-kernel/src/presentation';
import { PptMasterToolchain, PresentationToolchainError } from './toolchain';

const makeRunner = (
  result: PresentationRunnerResult = { exitCode: 0, stdout: '{"passed":true}' },
) => {
  const spawn = vi.fn(() => ({ result: Promise.resolve(result), cancel: vi.fn() }));
  return { runner: { id: 'runner-1', spawn } as PresentationRunner, spawn };
};
const options = (runner: PresentationRunner) => ({
  providerCommand: ['python3'],
  qualityScriptPath: '/opt/ppt-master/svg_quality_checker.py',
  convertScriptPath: '/opt/ppt-master/svg_to_pptx.py',
  runner,
  runnerId: 'runner-1',
  allowedRunnerIds: ['runner-1'],
  workspaceRoot: '/tmp/workspaces',
  pptMasterRoot: '/opt/ppt-master',
});

describe('C-53 ppt-master toolchain', () => {
  it('builds explicit argv and parses quality reports', async () => {
    const { runner, spawn } = makeRunner();
    const toolchain = new PptMasterToolchain(options(runner));
    await expect(toolchain.qualityCheck('/tmp/workspaces/job-1')).resolves.toEqual({
      passed: true,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [' /opt/ppt-master/svg_quality_checker.py'.trim(), '/tmp/workspaces/job-1'],
        shell: false,
      }),
    );
  });
  it('maps conversion artifacts and rejects unsafe configuration', async () => {
    const { runner, spawn } = makeRunner({
      exitCode: 0,
      artifacts: [{ path: 'deck.pptx', bytes: new Uint8Array([1]), name: 'deck.pptx' }],
    });
    const toolchain = new PptMasterToolchain(options(runner));
    await expect(toolchain.convert('/tmp/workspaces/job-1')).resolves.toMatchObject([
      { type: 'pptx', name: 'deck.pptx' },
    ]);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          '/opt/ppt-master/svg_to_pptx.py',
          '/tmp/workspaces/job-1',
          '--output',
          'exports/presentation.pptx',
          '--animation',
          'fade',
        ],
        shell: false,
      }),
    );
    expect(
      () => new PptMasterToolchain({ ...options(runner), qualityScriptPath: '/tmp/evil.py' }),
    ).toThrowError(PresentationToolchainError);
    expect(() => new PptMasterToolchain({ ...options(runner), allowedRunnerIds: [] })).toThrowError(
      expect.objectContaining({ code: 'PRESENTATION_RUNNER_NOT_ALLOWED' }),
    );
  });
  it('maps non-zero, malformed, and cancelled runs', async () => {
    const bad = makeRunner({ exitCode: 1, stderr: 'failed' });
    await expect(
      new PptMasterToolchain(options(bad.runner)).qualityCheck('/tmp/workspaces/job-1'),
    ).rejects.toMatchObject({ code: 'PRESENTATION_QUALITY_FAILED' });
    const malformed = makeRunner({ exitCode: 0, stdout: 'not-json' });
    await expect(
      new PptMasterToolchain(options(malformed.runner)).qualityCheck('/tmp/workspaces/job-1'),
    ).rejects.toMatchObject({ code: 'PRESENTATION_QUALITY_FAILED' });
    const controller = new AbortController();
    controller.abort();
    const { runner } = makeRunner();
    await expect(
      new PptMasterToolchain(options(runner)).convert('/tmp/workspaces/job-1', controller.signal),
    ).rejects.toMatchObject({ code: 'PRESENTATION_WORKER_CANCELLED' });
  });
});
