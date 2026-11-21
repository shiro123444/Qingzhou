import path from 'node:path';

import { strToU8, zipSync } from 'fflate';
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
    const toolchain = new PptMasterToolchain({
      ...options(runner),
      qualityArgs: ['--canonical-authoring', '--stage', 'final', '--json'],
    });
    await expect(toolchain.qualityCheck('/tmp/workspaces/job-1')).resolves.toEqual({
      passed: true,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          path.resolve('/opt/ppt-master/svg_quality_checker.py'),
          path.resolve('/tmp/workspaces/job-1'),
          '--canonical-authoring',
          '--stage',
          'final',
          '--json',
        ],
        shell: false,
      }),
    );
  });
  it('maps conversion artifacts and rejects unsafe configuration', async () => {
    const { runner, spawn } = makeRunner({
      exitCode: 0,
      artifacts: [
        {
          path: 'deck.pptx',
          bytes: zipSync({
            'ppt/slides/slide1.xml': strToU8(
              '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
            ),
          }),
          name: 'deck.pptx',
        },
      ],
    });
    const toolchain = new PptMasterToolchain(options(runner));
    await expect(toolchain.convert('/tmp/workspaces/job-1')).resolves.toMatchObject([
      { type: 'pptx', name: 'deck.pptx' },
    ]);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          path.resolve('/opt/ppt-master/svg_to_pptx.py'),
          path.resolve('/tmp/workspaces/job-1'),
          '--output',
          'exports/presentation.pptx',
          '--animation',
          'fade',
          '--no-image-optimize',
        ],
        shell: false,
      }),
    );
    await toolchain.convert('/tmp/workspaces/job-1', undefined, true);
    expect(spawn).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: expect.arrayContaining(['--native-charts-and-tables']) }),
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
    const overflow = makeRunner({
      exitCode: 1,
      stdout: '[ERROR] 003.svg - Failed\n [ERROR] <text> private title exceeds data-pptx-bounds',
    });
    await expect(
      new PptMasterToolchain(options(overflow.runner)).qualityCheck('/tmp/workspaces/job-1'),
    ).rejects.toMatchObject({ message: 'PowerPoint 导出前检查发现第 3 页有文字超出排版区域。' });
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
