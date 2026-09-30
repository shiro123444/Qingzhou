/** Analyze the real source without impersonating a teacher or confirming any production memory. */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { FilePresentationTemplateLibrary } from '../src/server/runtime/presentation/templates/library';
import {
  FileTeachingMemory,
  TeachingLearning,
  scanTeachingSequence,
} from '../src/server/runtime/presentation/teaching-memory';
import { createProductionMultimodalChatPort } from '../src/server/runtime/presentation/production-multimodal-chat-config';
import { createResilientMultimodalChatPort } from '../src/server/runtime/presentation/multimodal-chat-fallback';
import { createPresentationChatFetch } from '../src/server/runtime/presentation/resilient-fetch';
import { FilePresentationStorage } from '../src/server/runtime/presentation/file-storage';
import { presentationAccountScope } from '../src/server/runtime/presentation/account-workspace';

const sourcePath = process.argv.find((arg) => arg.endsWith('.pptx'));
if (!sourcePath)
  throw new Error('Pass the source PPTX path; optionally --live for model inference');
const base = path.resolve('.data/presentation-teaching-replays');
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, 'sequence-'));
const bytes = new Uint8Array(await readFile(sourcePath));
const pages = scanTeachingSequence(bytes);
await writeFile(path.join(root, 'observations.json'), JSON.stringify(pages, null, 2));
const report: Record<string, unknown> = {
  root,
  sourcePath,
  pages: pages.length,
  notesPages: pages.filter((p) => p.notes.replace(/[\s\d]/gu, '')).length,
  timingPages: pages.filter((p) => p.cues.includes('timing present true')).length,
  repeatedTextPages: pages
    .filter((p) => p.cues.includes('Repeated text cluster'))
    .map((p) => p.page),
  teacherConfirmed: false,
  analysis: 'OOXML structure and notes, not rendered image interpretation',
};
if (process.argv.includes('--live')) {
  const scope = { userId: 'isolated-teaching-smoke', sessionId: 'source-analysis' };
  const library = new FilePresentationTemplateLibrary({ root: path.join(root, 'templates') });
  const template = await library.importPptx(scope, { name: path.basename(sourcePath), bytes });
  const chat = createResilientMultimodalChatPort(
    createProductionMultimodalChatPort({
      env: { ...process.env },
      fetcher: createPresentationChatFetch(globalThis.fetch),
    }),
  );
  const store = new FilePresentationStorage(path.join(root, 'artifacts'));
  const learning = new TeachingLearning(
    new FileTeachingMemory(path.join(root, 'memory')),
    library,
    chat,
    { store },
  );
  const windowArg = process.argv
    .find((arg) => arg.startsWith('--window='))
    ?.slice('--window='.length)
    .split('-')
    .map(Number);
  const records = await learning.analyze(scope, {
    templateId: template.templateId,
    versionId: template.versionId,
    visual: process.argv.includes('--visual'),
    ...(process.argv.find((arg) => arg.startsWith('--pages='))
      ? {
          pages: process.argv
            .find((arg) => arg.startsWith('--pages='))!
            .slice('--pages='.length)
            .split(',')
            .map(Number),
        }
      : {}),
    ...(windowArg ? { window: { start: windowArg[0], end: windowArg[1] } } : {}),
  });
  await writeFile(path.join(root, 'proposals.json'), JSON.stringify(records, null, 2));
  report.proposals = records.length;
  if (process.argv.includes('--visual')) {
    report.analysis =
      'Native static final-state screenshots plus OOXML build structure; not animation playback';
    const screenshots = [
      ...new Map(
        records
          .flatMap((record) => record.source.visualPages ?? [])
          .map((page) => [page.page, page]),
      ).values(),
    ];
    report.visualPages = screenshots.map((page) => page.page);
    for (const page of screenshots) {
      const artifact = await store.get(presentationAccountScope(scope.userId), page.ref);
      if (!artifact?.bytes) throw new Error('Persisted visual evidence is missing');
      await writeFile(path.join(root, `page-${page.page}.jpg`), artifact.bytes);
    }
  }
  report.confirmedSearchCount = (await learning.memory.search(scope, '')).length;
}
await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
