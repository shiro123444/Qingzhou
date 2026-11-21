/** Owner-run local learning. Uses this account's saved provider; never accepts credentials. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { serverDB } from '../packages/database/src/server';
import { presentationAccountScope } from '../src/server/runtime/presentation/account-workspace';
import { FileCapabilityCapsuleStore } from '../src/server/runtime/presentation/capability-memory';
import { FilePresentationStorage } from '../src/server/runtime/presentation/file-storage';
import { importPptMasterDesignLibrary } from '../src/server/runtime/presentation/ppt-master-library';
import { FilePresentationTemplateLibrary } from '../src/server/runtime/presentation/templates';
import { TemplateVisualLearning } from '../src/server/runtime/presentation/templates/visual-learning';
import { createUserChatProvider } from '../src/server/runtime/presentation/user-chat-provider';
import { resolveUserChatProvider } from '../src/server/services/modelProvider';

const [userId, referencePptx, reportPath, pageSelection] = process.argv.slice(2);
const root = process.env.CORDIS_PPT_MASTER_ROOT;
const dataRoot = process.env.CORDIS_PRESENTATION_DATA_DIR;
if (!userId || !root || !dataRoot || !referencePptx || !reportPath)
  throw new Error(
    'Usage: presentationDesignLearn.mts account-user-id reference-preview.pptx report.json; configure PPT root and data directory first',
  );

const scope = presentationAccountScope(userId);
const memory = new FileCapabilityCapsuleStore(path.join(dataRoot, 'capability-memory'));
const library = new FilePresentationTemplateLibrary({ root: path.join(dataRoot, 'templates') });
const store = new FilePresentationStorage(dataRoot);
let references = await importPptMasterDesignLibrary({ root, memory, scope });
console.log(
  JSON.stringify({
    stage: 'references-imported',
    styles: references.filter((item) => item.kind === 'style').length,
    layouts: references.filter((item) => item.kind === 'layout').length,
  }),
);
const name = 'PPT Master · Presentation Core · 本机视觉学习';
const bytes = new Uint8Array(await readFile(referencePptx));
const sourceHash = createHash('sha256').update(bytes).digest('hex');
const existing = (await library.list(scope)).find(
  (item) => item.name === name && item.source.sha256 === sourceHash,
);
const profile = existing
  ? (await library.get(scope, existing.templateId, existing.versionId))!
  : await library.importPptx(scope, { bytes, name });
const accountChat = createUserChatProvider({
  fetcher: fetch,
  resolve: async (account) => {
    const connection = await resolveUserChatProvider(serverDB, account.userId);
    return process.env.CORDIS_PRESENTATION_VISION_MODEL
      ? {
          ...connection,
          model: process.env.CORDIS_PRESENTATION_VISION_MODEL,
          supportsVision: true,
        }
      : connection;
  },
});
const chat = {
  ...accountChat,
  manifest: {
    ...accountChat.manifest,
    model: process.env.CORDIS_PRESENTATION_VISION_MODEL ?? accountChat.manifest.model,
  },
};
const learning = new TemplateVisualLearning({ library, memory, store, chat });
const requestedPages =
  pageSelection === '--all'
    ? profile.layouts.map((_, i) => i + 1)
    : pageSelection
      ? pageSelection.split(',').map(Number)
      : [1, 14, 20];
if (
  requestedPages.some(
    (page) => !Number.isInteger(page) || page < 1 || page > profile.layouts.length,
  )
)
  throw new Error('Requested observation page is outside the reference deck');
let visual = await library.getVisual(scope, profile);
const missingPages = requestedPages.filter(
  (page) => !visual?.pages.some((item) => item.page === page),
);
for (let i = 0; i < missingPages.length; i += 6) {
  const pages = missingPages.slice(i, i + 6);
  console.log(JSON.stringify({ stage: 'visual-learning', templateId: profile.templateId, pages }));
  visual = await learning.analyze(
    {
      templateId: profile.templateId,
      versionId: profile.versionId,
      pages,
      purpose: 'capabilities',
      guidance:
        '这是部署者提供的开源、中性版式原型。学习各页的信息层级、对齐网格、数据关系、原生对象容量与可伸缩留白，区分页面角色和内容密度。灰色占位样式不构成品牌身份，不继承占位文字或示例数据，不复制整页背景。输出可迁移到不同主题和文字长度的布局能力，实际视觉语言由独立Style决定。',
    },
    { scope },
  );
  if (visual.learning.status !== 'ready') break;
}
if (!visual) throw new Error('No completed visual observation');
if (visual.learning.status !== 'ready') {
  await writeFile(
    reportPath,
    JSON.stringify(
      { state: visual.learning.status, questions: visual.learning.questions },
      null,
      2,
    ),
  );
  throw new Error('Template learning requires an explicit answer; see the saved report');
}
const observed = await memory.learn(scope, visual);
// This owner-run entry point imports the presentation_core preview built by
// template_preview_pptx.py. Bind only pages actually rendered and observed.
await memory.bindReferenceWorkspace(scope, {
  workspaceId: 'presentation_core',
  templateId: profile.templateId,
  versionId: profile.versionId,
  observedPages: visual.pages.map((page) => page.page),
  sourceHash,
});
references = await importPptMasterDesignLibrary({ root, memory, scope });
const report = {
  state: 'ready',
  sourceRoot: root,
  templateId: profile.templateId,
  versionId: profile.versionId,
  coverage: visual.learning.coverage,
  model: visual.model,
  imported: references.map(({ id, name, kind, source }) => ({ id, name, kind, source })),
  observed: observed.map(({ id, name, kind, source }) => ({ id, name, kind, source })),
};
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    stage: 'ready',
    coverage: visual.learning.coverage,
    observedCapabilities: observed.length,
    reportPath,
  }),
);
process.exit(0);
