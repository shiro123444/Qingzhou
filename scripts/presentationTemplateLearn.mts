/** Local, resumable corpus learning. Credentials come only from the caller's environment. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { presentationAccountScope } from '../src/server/runtime/presentation/account-workspace';
import { FileCapabilityCapsuleStore } from '../src/server/runtime/presentation/capability-memory';
import { FilePresentationStorage } from '../src/server/runtime/presentation/file-storage';
import { createFallbackMultimodalChatPort } from '../src/server/runtime/presentation/multimodal-chat-fallback';
import { createProductionMultimodalChatPort } from '../src/server/runtime/presentation/production-multimodal-chat-config';
import { createPresentationChatFetch } from '../src/server/runtime/presentation/resilient-fetch';
import { FilePresentationTemplateLibrary } from '../src/server/runtime/presentation/templates';
import { renderPowerPointTemplatePages } from '../src/server/runtime/presentation/templates/powerpoint-renderer';
import { TemplateVisualLearning } from '../src/server/runtime/presentation/templates/visual-learning';

const [manifestPath, dataPath, userId, filter = ''] = process.argv.slice(2);
const importOnly = filter === '--import-only';
const failedOnly = filter === '--failed-only';
const nameFilter = importOnly ? (process.argv[6] ?? '') : failedOnly || filter === '--deep' ? '' : filter;
const deep = process.argv.includes('--deep');
if (!manifestPath || !dataPath || !userId)
  throw new Error(
    'Usage: bun --env-file=.env.presentation.local scripts/presentationTemplateLearn.mts manifest.json data-root account-user-id [name-filter]',
  );
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  records: Array<{ path: string; name: string; source: string }>;
  errors: unknown[];
};
const root = path.resolve(dataPath);
await mkdir(root, { recursive: true });
const scope = presentationAccountScope(userId);
const store = new FilePresentationStorage(root);
const library = new FilePresentationTemplateLibrary({ root: path.join(root, 'templates') });
const memory = new FileCapabilityCapsuleStore(path.join(root, 'capability-memory'));
const run = promisify(execFile);
const primary = createProductionMultimodalChatPort({
  env: { ...process.env },
  fetcher: createPresentationChatFetch(globalThis.fetch),
});
const fallback = process.env.PRESENTATION_VISION_FALLBACK_MODEL
  ? createProductionMultimodalChatPort({
      env: { ...process.env, ANTHROPIC_MODEL: process.env.PRESENTATION_VISION_FALLBACK_MODEL },
      fetcher: createPresentationChatFetch(globalThis.fetch),
    })
  : undefined;
const provider = createFallbackMultimodalChatPort(primary, fallback, {
  primaryCooldownMs: 5 * 60_000,
});
let chatCalls = 0;
const chat = {
  ...provider,
  chat: async (...args: Parameters<typeof provider.chat>) => {
    const call = ++chatCalls;
    const started = Date.now();
    console.log(JSON.stringify({ event: 'vision-start', call, model: provider.manifest.model }));
    const result = await provider.chat(...args);
    const audit = path.join(root, 'learning-audit');
    await mkdir(audit, { recursive: true });
    await writeFile(path.join(audit, `${Date.now()}-${call}.json`), JSON.stringify(result));
    console.log(
      JSON.stringify({
        event: 'vision-done',
        call,
        model: result.model,
        seconds: Math.round((Date.now() - started) / 1000),
      }),
    );
    return result;
  },
};
const progressPath = path.join(
  root,
  importOnly ? 'template-corpus-intake.json' : 'template-corpus-progress.json',
);
const progress = await readFile(progressPath, 'utf8')
  .then(JSON.parse)
  .catch((error) => {
    if (error.code === 'ENOENT') return { records: {}, intakeErrors: manifest.errors };
    throw error;
  });
let checkpointWrites = Promise.resolve();
const saveProgress = () => {
  const snapshot = JSON.stringify(progress, null, 2);
  checkpointWrites = checkpointWrites.then(async () => {
    const temporary = `${progressPath}.tmp`;
    await writeFile(temporary, snapshot);
    await rename(temporary, progressPath);
  });
  return checkpointWrites;
};
const renderer = async (bytes: Uint8Array, pages: number[], signal?: AbortSignal) => {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const directory = path.join(root, 'render-cache', `${digest.slice(0, 16)}-hidden-v2`);
  await mkdir(directory, { recursive: true });
  const pdf = path.join(directory, 'source.pdf');
  if (!(await readFile(pdf).catch(() => null))) {
    const file = path.join(directory, 'source.pptx');
    await writeFile(file, bytes);
    await run(
      process.env.PRESENTATION_OFFICE_COMMAND ??
        (process.platform === 'win32'
          ? 'C:/Program Files/LibreOffice/program/soffice.com'
          : 'libreoffice'),
      [
        `-env:UserInstallation=${pathToFileURL(path.join(directory, 'profile')).href}`,
        '--headless',
        '--convert-to',
        'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}',
        '--outdir',
        directory,
        file,
      ],
      { signal, timeout: 120000, maxBuffer: 1024 * 1024 },
    );
  }
  const rendered = [];
  if (!(await readFile(pdf).catch(() => null)) && process.platform === 'win32') {
    const native = await renderPowerPointTemplatePages(bytes, pages, signal);
    for (const item of native)
      await writeFile(path.join(directory, `page-${item.page}.jpg`), item.bytes);
    return native;
  }
  for (const page of pages) {
    const target = path.join(directory, `page-${page}`);
    const filename = `${target}.jpg`;
    let image = await readFile(filename).catch(() => null);
    if (!image) {
      try {
        await run(
        'pdftoppm',
        [
          '-f',
          String(page),
          '-l',
          String(page),
          '-scale-to',
          '1400',
          '-singlefile',
          '-jpeg',
          '-jpegopt',
          'quality=86',
          pdf,
          target,
        ],
        { signal, timeout: 120000 },
        );
        image = await readFile(filename);
      } catch (error) {
        if (signal?.aborted || process.platform !== 'win32') throw error;
        // LibreOffice can omit a hidden slide. Native page numbering remains authoritative.
        const native = await renderPowerPointTemplatePages(bytes, [page], signal);
        image = Buffer.from(native[0].bytes);
        await writeFile(filename, image);
      }
    }
    rendered.push({ page, bytes: image });
  }
  return rendered;
};
const learning = new TemplateVisualLearning({ chat, library, memory, renderer, store });
async function learnRecord(record: (typeof manifest.records)[number]) {
  console.log(JSON.stringify({ event: 'template-start', source: record.source }));
  try {
    const template = await library.importLocalPptx(scope, {
      path: record.path,
      name: record.name.slice(0, 120),
    });
    if (importOnly) {
      progress.records[record.source] = {
        templateId: template.templateId,
        versionId: template.versionId,
        state: 'imported',
        pages: template.layouts.length,
      };
      await saveProgress();
      console.log(
        JSON.stringify({
          event: 'template-imported',
          source: record.source,
          pages: template.layouts.length,
        }),
      );
      return;
    }
    let visual = await library.getVisual(scope, template);
    const representativePages = deep
      ? undefined
      : (await learning.render(template, { scope })).map(({ page }) => page);
    const answered = new Set<string>();
    while (
      (deep
        ? (visual?.learning.coverage?.observedPages.length ?? 0) < template.layouts.length
        : representativePages!.some(
            (page) => !visual?.pages.some((observed) => observed.page === page),
          )) ||
      visual?.learning.status === 'needs_input'
    ) {
      const question = visual?.learning.questions[0];
      if (question && answered.has(question.id))
        throw new Error(`Design clarification did not resolve: ${question.id}`);
      if (question) answered.add(question.id);
      const observed = new Set(visual?.pages.map(({ page }) => page));
      const pages = (representativePages ?? template.layouts.map((_, index) => index + 1))
        .filter((page) => !observed.has(page))
        .slice(0, 6);
      visual = await learning.analyze(
        {
          ...template,
          purpose: 'capabilities',
          ...(question ? { questionId: question.id } : { pages }),
          guidance:
            '用户要求自主学习与组合设计能力：保留水墨、科技等所有已观察到的不同视觉族，不强行选一种。标题与正文均用可编辑文本，本机可用的近似字体表达书法气质，笔触装饰可独立生成；无需保留原始标题图像。原有活动照片、数字、校名、人物和标识不作为新任务事实；包含旧名称的整块素材不直接复用，标记重绘。只有无旧文字的背景、边框、装饰或可迁移插画可复用。只学习可见静态设计，本次不需要音频语义或动态播放，媒体保留元数据与静态画面即可。普通配色、构图和主次风格可自主决定，将不可靠的区域标记重绘而不阻塞其他能力学习。不要为上述已确定的事项重复提问。',
        },
        { scope },
      );
      console.log(
        JSON.stringify({
          event: 'template-progress',
          source: record.source,
          observed: visual.learning.coverage?.observedPages.length,
          total: template.layouts.length,
          state: visual.learning.status,
        }),
      );
      progress.records[record.source] = {
        templateId: template.templateId,
        versionId: template.versionId,
        state: visual.learning.status,
        coverage: visual.learning.coverage,
        questions: visual.learning.questions,
      };
      await saveProgress();
    }
    progress.records[record.source] = {
      templateId: template.templateId,
      versionId: template.versionId,
      state: visual?.learning.status,
      coverage: visual?.learning.coverage,
      questions: visual?.learning.questions,
    };
  } catch (error) {
    progress.records[record.source] = {
      state: 'failed',
      error: error instanceof Error ? error.message : 'Learning failed',
    };
    console.log(
      JSON.stringify({
        event: 'template-failed',
        source: record.source,
        error: progress.records[record.source].error,
      }),
    );
  }
  await saveProgress();
}
const selectedRecords = manifest.records.filter(
  (record) => (!nameFilter || record.name.includes(nameFilter)) &&
    (!failedOnly || progress.records[record.source]?.state === 'failed'),
);
let nextRecord = 0;
const concurrency = Math.max(
  1,
  Math.min(3, Number(process.env.PRESENTATION_CORPUS_CONCURRENCY) || 1),
);
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (;;) {
      const record = selectedRecords[nextRecord++];
      if (!record) return;
      await learnRecord(record);
    }
  }),
);
console.log(
  JSON.stringify({
    event: 'corpus-completed',
    records: Object.keys(progress.records).length,
    failed: Object.values(progress.records).filter((record: any) => record.state === 'failed')
      .length,
  }),
);
