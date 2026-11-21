import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { presentationStylePresets } from '../packages/runtime-contracts/src/presentation-style-presets';
import { FileCapabilityCapsuleStore } from '../src/server/runtime/presentation/capability-memory';
import { createDeckVisualSystem } from '../src/server/runtime/presentation/deck-visual-system';
import { compileLearnedNativeLayout } from '../src/server/runtime/presentation/learned-native-layout';
import { importPptMasterDesignLibrary } from '../src/server/runtime/presentation/ppt-master-library';

// Regenerate the six gallery slides using the production layout compiler and
// indexed upstream layout observations. Both pages have identical copy in each style.
const root = process.argv[2] || process.env.PPT_MASTER_ROOT;
if (!root) throw new Error('Pass the path to a PPT Master checkout');
const cache = await mkdtemp(path.join(tmpdir(), 'qingzhou-gallery-'));
try {
  const capsules = await importPptMasterDesignLibrary({
    root,
    memory: new FileCapabilityCapsuleStore(cache),
    scope: { sessionId: 'gallery', userId: 'gallery' },
  });
  const out = fileURLToPath(new URL('../public/images/presentation-styles/', import.meta.url));
  await mkdir(out, { recursive: true });
  const title = '夜读城市';
  const subtitle = '社区图书馆的夜间开放计划';
  const edition = '2026 秋季  /  公共文化研究';
  const heading = '把阅读带进夜生活';
  const points = [
    '延长开放：每周四、周五延长开放至晚上九点。',
    '共享书单：读者每月推荐一本书，在馆内分享阅读笔记。',
  ];
  for (const preset of presentationStylePresets) {
    const system = createDeckVisualSystem({
      notebookId: 'gallery',
      sourceVersionIds: [],
      title,
      options: { styleWorkspaceId: preset.id },
    })!;
    const style = capsules.find((c) => c.source.workspaceId === preset.id)!;
    for (const page of ['cover', 'content'] as const) {
      const cover = page === 'cover';
      const layoutId = cover ? preset.coverLayout : preset.textLayout;
      const layout = capsules.find((c) => c.source.workspaceId === layoutId)!;
      const result = compileLearnedNativeLayout({
        title: cover ? title : heading,
        approvedContent: cover ? [edition, title, subtitle] : points,
        role: page,
        rawBlocks: [],
        capsules: [style, layout],
        system,
        pageNumber: cover ? 1 : 2,
        totalPages: 2,
        svg: cover
          ? `<svg xmlns="http://www.w3.org/2000/svg"><text x="64" y="88" font-size="18">${edition}</text><text x="64" y="172" font-size="54">${title}</text><text x="64" y="284" font-size="26">${subtitle}</text></svg>`
          : '<svg xmlns="http://www.w3.org/2000/svg"/>',
        onSkip: (reason) => {
          throw new Error(`${preset.id}/${page}: ${reason}`);
        },
      });
      if (!result) throw new Error(`Could not compile ${preset.id}/${page}`);
      await writeFile(path.join(out, `${preset.id}-${page}.svg`), result.svg);
    }
  }
} finally {
  await rm(cache, { recursive: true, force: true });
}
