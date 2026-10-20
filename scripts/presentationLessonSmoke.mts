/** Real export regression for teacher-led stages. --live additionally exercises the configured planning model. */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { strFromU8, unzipSync } from 'fflate';
import sharp from 'sharp';

import { type LessonPlan, lessonStages } from '../src/types/presentationLesson';
import { assertPresentationPublishable } from '../src/server/runtime/presentation/content-quality';
import {
  bindLessonPlan,
  compileLessonInput,
  proposeLesson,
} from '../src/server/runtime/presentation/lesson';
import { createProductionMultimodalChatPort } from '../src/server/runtime/presentation/production-multimodal-chat-config';
import { createResilientMultimodalChatPort } from '../src/server/runtime/presentation/multimodal-chat-fallback';
import { createPresentationChatFetch } from '../src/server/runtime/presentation/resilient-fetch';
import { renderSemanticBlocks } from '../src/server/runtime/presentation/semantic-blocks';
import { InMemoryPresentationPlanWorker } from '../src/server/runtime/presentation/worker';

const pptRoot = process.env.CORDIS_PPT_MASTER_ROOT ?? process.argv[2];
if (!pptRoot) throw new Error('Set CORDIS_PPT_MASTER_ROOT or pass the ppt-master directory');
const base = path.resolve('.data/presentation-lesson-replays');
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, 'lesson-'));
const brief = {
  intention: '先让学生预测，再解释方向；公式由教师补充板书，不让AI替我提前给答案。',
  audience: '已有导数基础的本科生',
  priorKnowledge: '一元导数与函数图像',
  learningGoal: '解释下降方向并预测学习率的影响',
  durationMinutes: 12,
};
const rows = [
  [
    'observe',
    '从这个起点往哪里走？',
    'question',
    '观察等高线，先画出你的方向。',
    '先等待两种不同回答，再追问理由。',
    ['负梯度方向'],
    'none',
  ],
  [
    'explain',
    '方向来自局部变化',
    'explanation',
    '用已有的导数知识解释你的判断。',
    '连接一元导数与方向导数，不承诺一步到达最优。',
    [],
    'none',
  ],
  [
    'formalize',
    '把方向写成更新规则',
    'boardwork',
    '解释每个符号，推导由教师现场完成。',
    '在右侧板书一元特例；不要直接读出完整推导。',
    [],
    'right-third',
  ],
  [
    'predict',
    '步子变大，会发生什么？',
    'question',
    '比较不同步长，先预测再验证。',
    '记录单调、震荡和发散三种预测，暂不公布结果。',
    ['震荡收敛', '发散'],
    'none',
  ],
  [
    'experiment',
    '用计算检验我们的预测',
    'experiment',
    '观察计算轨迹，解释你预测与结果的差异。',
    '强调这是二次函数的计算示例，不是一般收敛定理。',
    [],
    'none',
  ],
  [
    'transfer',
    '换一个起点，你能解释下一步吗？',
    'question',
    '独立写出下一步，并说明依据。',
    '参考答案只在教师提示中：下一点为负二分之一。请先收集学生理由。',
    ['负二分之一'],
    'none',
  ],
] as const;
const lesson: LessonPlan = {
  schemaVersion: 1,
  brief,
  beats: rows.map(([id, title, kind, action, cue, withheld, board]) => ({
    id,
    title,
    objective: `完成“${title}”对应的理解与解释`,
    teacherCue: cue,
    studentAction: action,
    checkForUnderstanding: '能否用自己的话给出理由，而不仅报出数值',
    durationMinutes: 2,
    locked: true,
    frames: [
      {
        id: `frame-${id}`,
        title,
        kind,
        visibleContent: [],
        visualCue:
          id === 'formalize' ? '更新公式，右侧留白' : '确定性数学示意，不使用生成图片代替数值结果',
        withheldContent: [...withheld],
        boardSpace: board,
      },
    ],
  })),
};
const input = compileLessonInput({
  title: '梯度下降：从预测到解释（教学验证样例）',
  notebookId: 'lesson-smoke',
  sourceVersionIds: [],
  options: { lessonPlan: lesson },
});
await writeFile(path.join(root, 'input.json'), JSON.stringify(input, null, 2));
console.log(
  JSON.stringify({ event: 'started', root, liveProposal: process.argv.includes('--live') }),
);
if (process.argv.includes('--live')) {
  const chat = createResilientMultimodalChatPort(
    createProductionMultimodalChatPort({
      env: { ...process.env },
      fetcher: createPresentationChatFetch(globalThis.fetch),
    }),
  );
  const proposal = await proposeLesson(
    chat,
    {
      brief,
      topic: input.title,
      material:
        '内容范围：一元 f(x)=x²，x0=2；对比学习率0.1、0.8、1.1。公式、数值与图使用确定性渲染，避免全课都堆满要点；至少一处板书留白。',
    },
    { scope: { userId: 'local-lesson-validation', sessionId: path.basename(root) } },
  );
  await writeFile(path.join(root, 'model-proposal.json'), JSON.stringify(proposal, null, 2));
  console.log(
    JSON.stringify({
      event: 'model-proposal',
      beats: proposal.beats.length,
      stages: lessonStages(proposal).length,
      teacherApproved: false,
    }),
  );
}
const text = (value: string, x: number, y: number, size = 26) =>
  `<text x="${x}" y="${y}" font-family="Arial, Microsoft YaHei" font-size="${size}" fill="#172554">${value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</text>`;
const contour = (reveal: boolean) =>
  [
    ...[80, 140, 210].map(
      (r) =>
        `<ellipse cx="450" cy="315" rx="${r}" ry="${r * 0.58}" fill="none" stroke="#93b5d0" stroke-width="2"/>`,
    ),
    '<circle cx="590" cy="235" r="7" fill="#e07c31"/>',
    text('起点', 610, 225, 20),
    reveal
      ? '<path d="M590 235 L520 275 M520 275 L538 273 M520 275 L526 258" fill="none" stroke="#2563eb" stroke-width="4"/>' +
        text('负梯度方向', 620, 310, 24)
      : '',
  ].join('');
const points = (rate: number): [number, number][] => {
  let x = 2;
  return Array.from({ length: 7 }, (_, k) => {
    const point: [number, number] = [k, x];
    x -= rate * 2 * x;
    return point;
  });
};
const slides = [];
for (const [index, { frame }] of lessonStages(lesson).entries()) {
  let body = '';
  const blocks: unknown[] = [];
  if (index < 2) body = contour(index === 1);
  if (index === 2) {
    body = '<g data-content-id="update"/>' + text('右侧由教师现场板书', 48, 360, 24);
    blocks.push({
      id: 'update',
      kind: 'formula',
      latex: 'x_{k+1}=x_k-\\alpha_k\\nabla f(x_k)',
      display: true,
      fontSize: 28,
      color: '#172554',
      rect: { x: 40, y: 180, width: 550, height: 90 },
    });
  }
  if (index === 3)
    body =
      text('同一函数、同一起点', 80, 180) +
      text('学习率：0.1 / 0.8 / 1.1', 80, 245) +
      text('先预测，再看下一页的计算结果。', 80, 330);
  if (index === 4) {
    body = '<g data-content-id="trajectory"/>';
    blocks.push({
      id: 'trajectory',
      kind: 'scientific-diagram',
      title: '一元二次函数的迭代点',
      provenance: {
        kind: 'illustrative',
        reference: '计算示例：f(x)=x²，x0=2，x(k+1)=(1-2α)x(k)，k=0..6',
      },
      rect: { x: 65, y: 115, width: 820, height: 355 },
      spec: {
        type: 'plot',
        xRange: [0, 6],
        yRange: [-6, 6],
        xLabel: 'k',
        yLabel: 'x',
        series: [0.1, 0.8, 1.1].map((rate, i) => ({
          label: `alpha=${rate}`,
          points: points(rate),
          color: ['#2563eb', '#e07c31', '#9f1239'][i],
        })),
      },
    });
  }
  if (index === 5) {
    body = '<g data-content-id="transfer"/>' + text('下一点在哪里？为什么？', 120, 330, 30);
    blocks.push({
      id: 'transfer',
      kind: 'formula',
      latex: 'f(x)=x^2,\\quad x_0=-1,\\quad\\alpha=\\frac{1}{4}',
      display: true,
      fontSize: 30,
      color: '#172554',
      rect: { x: 90, y: 160, width: 780, height: 85 },
    });
  }
  const rendered = await renderSemanticBlocks(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="#ffffff"/>${text(frame.title, 40, 60, 30)}${body}${text('教学功能验证样例 · 数学图为计算或示意，非实验观测', 40, 516, 16)}</svg>`,
    blocks,
  );
  slides.push({
    slideId: `slide-${index + 1}`,
    order: index + 1,
    svg: rendered.svg,
    metadata: { contentBlocks: rendered.blocks },
  });
}
const plan = bindLessonPlan(
  {
    planId: 'lesson-smoke',
    title: input.title,
    aspectRatio: '16:9',
    sourceVersionIds: [],
    designSpec: { contentPolicyVersion: 1 },
    slides,
  },
  input,
);
assertPresentationPublishable(plan);
const scripts = path.join(pptRoot, 'skills/ppt-master/scripts');
const run = promisify(execFile);
const worker = new InMemoryPresentationPlanWorker();
const result = await worker.run(plan, {
  jobId: 'lesson-smoke',
  workspace: {
    path: root,
    write: async (name, content) => {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    },
  },
  qualityCheck: async (directory) => {
    await run('python3', [path.join(scripts, 'svg_quality_checker.py'), directory], {
      timeout: 120_000,
    });
    return { passed: true };
  },
  convert: async (directory) => {
    await run(
      'python3',
      [
        path.join(scripts, 'svg_to_pptx.py'),
        directory,
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
for (const [index, slide] of plan.slides.entries())
  await sharp(Buffer.from(slide.svg))
    .png()
    .toFile(path.join(root, `stage-${index + 1}.png`));
const archive = unzipSync(await readFile(path.join(root, 'lesson.pptx')));
const slideXml = Object.keys(archive).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
if (slideXml.length !== 6) throw new Error('Export stage count changed');
if (strFromU8(archive['ppt/slides/slide1.xml']).includes('负梯度方向'))
  throw new Error('Question export leaked the answer');
if (!strFromU8(archive['ppt/slides/slide3.xml']).includes('a:custGeom'))
  throw new Error('Formula vectors missing');
if (
  !Object.keys(archive).some(
    (name) =>
      name.startsWith('ppt/notesSlides/notesSlide') &&
      strFromU8(archive[name]).includes('先等待两种'),
  )
)
  throw new Error('Teacher cues lost');
await writeFile(path.join(root, 'plan.json'), JSON.stringify(plan, null, 2));
const report = {
  root,
  stages: 6,
  teacherNotesPreserved: true,
  questionAnswerWithheld: true,
  vectorFormulaPreserved: true,
  computedTrajectories: [0.1, 0.8, 1.1].map((rate) => ({ rate, points: points(rate) })),
  exportMode: 'manual-static-stages',
  livePlanning: process.argv.includes('--live'),
  rendering: 'deterministic regression fixture, not model-generated layout',
};
await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
