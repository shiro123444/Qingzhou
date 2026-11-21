// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { FileCapabilityCapsuleStore } from './capability-memory';
import { importPptMasterDesignLibrary } from './ppt-master-library';

it('imports owned methods and normalized slots without copying prototype facts or claiming successful trials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ppt-library-test-'));
  try {
    const base = path.join(root, 'skills/ppt-master/templates');
    const styles = path.join(base, 'styles/editorial/templates');
    const layouts = path.join(base, 'layouts/presentation_core/templates');
    await mkdir(styles, { recursive: true });
    await mkdir(layouts, { recursive: true });
    await writeFile(
      path.join(base, 'styles/styles_index.json'),
      JSON.stringify({
        editorial: { summary: 'Editorial presentation', keywords: ['presentation'] },
      }),
    );
    await writeFile(
      path.join(base, 'layouts/layouts_index.json'),
      JSON.stringify({
        presentation_core: { summary: 'Presentation layouts', canvas_format: 'ppt169' },
      }),
    );
    const spec = path.join(styles, 'design_spec.md');
    const visualDirectory = path.join(root, 'skills/ppt-master/references/visual-styles');
    await mkdir(visualDirectory, { recursive: true });
    await writeFile(
      path.join(visualDirectory, 'swiss-minimal.md'),
      'Strictly flat. No shadows. Omit ornament. Square corners. Modular grid.',
    );
    await writeFile(
      spec,
      '---\nstyle_id: editorial\nkind: style\n---\n\n# Editorial\n\nKeep one focal point.\n\n- **Preferred Visual Style**: swiss-minimal',
    );
    await writeFile(path.join(layouts, 'design_spec.md'), '# Brand-neutral structure');
    await writeFile(
      path.join(layouts, '01_process.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" data-pptx-layout="process_timeline"><rect id="source-accent" x="60" y="140" width="4" height="300" fill="#CBD5E1" data-pptx-layer="layout"/><rect id="source-panel" x="128" y="144" width="1024" height="432" fill="#F4F6F8" data-pptx-layer="layout"/><g data-pptx-placeholder="body" data-pptx-bounds="128 144 1024 432"><text>Invented result 99%</text></g></svg>',
    );
    const memory = new FileCapabilityCapsuleStore(path.join(root, 'memory'));
    const scope = { userId: 'alice', sessionId: 'one' };
    const first = await importPptMasterDesignLibrary({ root, memory, scope });
    expect(first).toHaveLength(2);
    expect(first.find((item) => item.kind === 'style')?.designReference?.style).toEqual({
      id: 'swiss-minimal',
      flat: true,
      sparseDecoration: true,
      squareCorners: true,
      grid: true,
    });
    const layout = first.find((item) => item.kind === 'layout')!;
    expect(layout.layout?.regions[0].box).toEqual({ x: 0.1, y: 0.2, width: 0.8, height: 0.6 });
    expect(layout.designReference?.accents).toEqual([
      {
        id: 'source-accent',
        box: { x: 60 / 1280, y: 140 / 720, width: 4 / 1280, height: 300 / 720 },
        fill: '#CBD5E1',
      },
    ]);
    expect(JSON.stringify(first)).not.toContain('99%');
    const composed = await memory.compose(
      scope,
      first.map((item) => item.id),
      true,
    );
    expect(composed.observedCapabilityIds).toHaveLength(2);
    expect(await memory.candidates({ userId: 'bob', sessionId: 'two' }, 'presentation')).toEqual(
      [],
    );
    await expect(memory.compose(scope, [first[0].id], false)).rejects.toThrow('verified');
    await writeFile(spec, (await readFile(spec, 'utf8')) + '\n\nAvoid decorative circles.');
    const second = await importPptMasterDesignLibrary({ root, memory, scope });
    expect(second[0].id).not.toBe(first[0].id);
    await expect(memory.compose(scope, [first[0].id], true)).rejects.toThrow('verified');
    await memory.bindReferenceWorkspace(scope, {
      workspaceId: 'presentation_core',
      templateId: 'real-template',
      versionId: 'observed-version',
      observedPages: [1],
      sourceHash: 'b'.repeat(64),
    });
    const linked = await importPptMasterDesignLibrary({ root, memory, scope });
    expect(linked.find((item) => item.kind === 'layout')?.source).toMatchObject({
      templateId: 'real-template',
      versionId: 'observed-version',
      evidencePages: [1],
    });
    await writeFile(
      spec,
      '---\nstyle_id: editorial\nkind: style\n---\n## V. Visual System Defaults\n- **Preferred Visual Style**: custom\nA strict-grid manual. No drop shadow. Zero corner radius.\n| background | #0E1B2E | Dark field |\n## VI. Image Language\nNo source image facts.',
    );
    const custom = await importPptMasterDesignLibrary({ root, memory, scope });
    expect(custom.find((c) => c.kind === 'style')?.designReference?.style).toMatchObject({
      id: 'custom',
      flat: true,
      grid: true,
      squareCorners: true,
      background: 'dark',
    });
    const isolated = await importPptMasterDesignLibrary({
      root,
      memory,
      scope: { userId: 'bob', sessionId: 'two' },
    });
    expect(isolated.find((item) => item.kind === 'layout')?.source.templateId).toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
