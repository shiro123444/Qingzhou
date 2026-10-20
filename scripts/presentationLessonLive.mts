/** Opt-in real model → isolated stage compiler → renderer → actual PPTX. No live classroom or account mutation. */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { strFromU8, unzipSync } from 'fflate';

import { lessonPlanSchema } from '../src/types/presentationLesson';
import { createPresentationContentCompiler } from '../src/server/runtime/presentation/content-intent';
import { assertPresentationPublishable } from '../src/server/runtime/presentation/content-quality';
import { bindLessonPlan, compileLessonInput } from '../src/server/runtime/presentation/lesson';
import { createMultimodalPresentationPlanner } from '../src/server/runtime/presentation/multimodal-planner-glm';
import { createResilientMultimodalChatPort } from '../src/server/runtime/presentation/multimodal-chat-fallback';
import { createProductionMultimodalChatPort } from '../src/server/runtime/presentation/production-multimodal-chat-config';
import { createPresentationChatFetch } from '../src/server/runtime/presentation/resilient-fetch';
import { InMemoryPresentationPlanWorker } from '../src/server/runtime/presentation/worker';

const fixture = process.argv[2];
if (!fixture || !process.env.CORDIS_PPT_MASTER_ROOT)
  throw new Error('Pass an isolated lesson input.json and configure CORDIS_PPT_MASTER_ROOT');
const source = JSON.parse(await readFile(fixture, 'utf8'));
const lesson = lessonPlanSchema.parse(source.options.lessonPlan);
lesson.beats = [lesson.beats[0], lesson.beats[2]];
lesson.beats[0].frames[0].visualCue = '只显示标题，其他区域留白。没有图、没有公式，不补充答案。';
lesson.beats[1].frames[0].visualCue =
  '左侧只呈现精确公式 x_{k+1}=x_k-\\alpha_k\\nabla f(x_k)，通过formula矢量渲染，不画图。右侧1/3留给教师板书。不要额外解释符号或添加页脚。';
const base = path.resolve('.data/presentation-lesson-replays');
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, 'live-'));
const scope = { userId: 'local-lesson-validation', sessionId: path.basename(root) };
const provider = createResilientMultimodalChatPort(
  createProductionMultimodalChatPort({
    env: { ...process.env },
    fetcher: createPresentationChatFetch(globalThis.fetch),
  }),
);
let calls = 0;
const chat = {
  ...provider,
  chat: async (...args: Parameters<typeof provider.chat>) => {
    console.log(JSON.stringify({ event: 'model-start', call: ++calls }));
    const result = await provider.chat(...args);
    await writeFile(path.join(root, `response-${calls}.json`), JSON.stringify(result));
    console.log(JSON.stringify({ event: 'model-done', call: calls }));
    return result;
  },
};
const input = compileLessonInput({
  ...source,
  template: undefined,
  title: '教师主导讲解 · 真实模型集成验证',
  options: { lessonPlan: lesson },
});
console.log(JSON.stringify({ event: 'started', root }));
const compiled = await createPresentationContentCompiler(chat).compile(input, { scope });
if (
  compiled.slides.some((slide) =>
    slide.visuals?.some((visual) =>
      ['illustration', 'photograph', 'scientific-illustration'].includes(visual.kind),
    ),
  )
)
  throw new Error('The model invented a raster asset for a title/formula-only test');
input.options = { ...input.options, contentIntents: compiled };
await writeFile(path.join(root, 'input.json'), JSON.stringify(input, null, 2));
const rawPlan = await createMultimodalPresentationPlanner({ chatPort: chat }).plan(input, {
  scope,
});
const plan = bindLessonPlan(rawPlan, input);
assertPresentationPublishable(plan);
await writeFile(path.join(root, 'plan.json'), JSON.stringify(plan, null, 2));
const scripts = path.join(process.env.CORDIS_PPT_MASTER_ROOT, 'skills/ppt-master/scripts');
const run = promisify(execFile);
const result = await new InMemoryPresentationPlanWorker().run(plan, {
  jobId: 'live-lesson',
  workspace: {
    path: root,
    write: async (name, content) => {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    },
  },
  qualityCheck: async () => {
    await run('python3', [path.join(scripts, 'svg_quality_checker.py'), root], {
      timeout: 120_000,
    });
    return { passed: true };
  },
  convert: async () => {
    await run(
      'python3',
      [
        path.join(scripts, 'svg_to_pptx.py'),
        root,
        '--output',
        path.join(root, 'lesson.pptx'),
        '--animation',
        'none',
      ],
      { timeout: 120_000 },
    );
    return [
      {
        type: 'pptx',
        name: 'lesson.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        bytes: await readFile(path.join(root, 'lesson.pptx')),
      },
    ];
  },
});
for (const artifact of result.artifacts.filter(
  (item) => item.metadata?.artifactRole === 'student-handout',
))
  await writeFile(path.join(root, artifact.name), artifact.bytes);
const files = unzipSync(await readFile(path.join(root, 'lesson.pptx')));
if (strFromU8(files['ppt/slides/slide1.xml']).includes('负梯度方向'))
  throw new Error('Answer leaked into exported question');
if (!strFromU8(files['ppt/slides/slide2.xml']).includes('a:custGeom'))
  throw new Error('Formula was not exported as vectors');
const report = {
  root,
  calls,
  stages: plan.slides.length,
  model: chat.manifest.model,
  passed: true,
  scope: 'real model generation of question and boardwork stages; not classroom effectiveness',
};
await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
