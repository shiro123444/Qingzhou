import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { presentationAccountScope } from './account-workspace';
import { FileCapabilityCapsuleStore } from './capability-memory';
import { FilePresentationStorage } from './file-storage';
import { createLocalCorpusSeeder } from './local-corpus';
import { FilePresentationTemplateLibrary } from './templates';
import { compileTemplateDesignProgram } from './templates/design-program';
import type { TemplateVisualProfile } from './templates/visual-types';

it('seeds configured template evidence into the current account without importing jobs or verification claims', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ppt-corpus-seed-'));
  try {
    const sourceScope = presentationAccountScope('corpus-owner');
    const targetScope = presentationAccountScope('alice');
    const library = new FilePresentationTemplateLibrary({ root: path.join(root, 'templates') });
    const store = new FilePresentationStorage(root);
    const memory = new FileCapabilityCapsuleStore(path.join(root, 'memory'));
    const template = await library.learnFromPlan(sourceScope, {
      name: '水彩',
      plan: {
        planId: 'reference',
        aspectRatio: '16:9',
        sourceVersionIds: [],
        title: '水彩',
        slides: [
          {
            slideId: 's1',
            order: 1,
            svg: '<svg viewBox="0 0 960 540"><text x="40" y="80">参考</text></svg>',
          },
        ],
      },
    });
    const analysis = {
      families: [
        {
          id: 'watercolor',
          name: '绿色水彩',
          pages: [1],
          palette: ['#008866'],
          composition: '左右图文',
          typography: '大标题',
          artwork: '水彩',
          preserve: ['留白'],
        },
      ],
      components: [],
      summary: '水彩',
      guidance: '留白',
    };
    const visual: TemplateVisualProfile = {
      ...analysis,
      schemaVersion: 3,
      templateId: template.templateId,
      versionId: template.versionId,
      designProgram: compileTemplateDesignProgram(analysis),
      model: 'test',
      analyzedAt: '2026-10-14',
      media: [],
      pages: [{ page: 1, ref: 'template-page-owned', width: 960, height: 540, nativeTextCount: 1 }],
      learning: { status: 'ready', iteration: 1, questions: [], guidanceHistory: [] },
    };
    await library.saveVisual(sourceScope, visual);
    await store.put(sourceScope, {
      artifactId: 'template-page-owned',
      type: 'image',
      name: 'page.jpg',
      mimeType: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3]),
    });
    const seed = createLocalCorpusSeeder({ sourceUserId: 'corpus-owner', library, store, memory });
    await Promise.all([seed(targetScope), seed(targetScope)]);
    await seed(targetScope);
    expect(await library.getVisual(targetScope, template)).toEqual(
      expect.objectContaining({ templateId: template.templateId }),
    );
    expect((await store.get(targetScope, 'template-page-owned'))?.bytes).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(await store.listJobs(targetScope)).toEqual([]);
    expect(await memory.search(targetScope, '水彩')).toEqual([]);
    expect((await memory.search(targetScope, '水彩', 6, true)).length).toBeGreaterThan(0);
    expect(await library.list(presentationAccountScope('bob'))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
