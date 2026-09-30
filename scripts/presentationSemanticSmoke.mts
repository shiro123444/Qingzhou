/** Offline end-to-end smoke: real math/diagram SVG → the configured ppt-master converter. */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { strFromU8, unzipSync } from 'fflate';
import sharp from 'sharp';

import {
  assertPresentationPublishable,
  inspectPresentationContent,
} from '../src/server/runtime/presentation/content-quality';
import { renderSemanticBlocks } from '../src/server/runtime/presentation/semantic-blocks';

const pptMasterRoot = process.argv[2];
if (!pptMasterRoot)
  throw new Error('Usage: bun scripts/presentationSemanticSmoke.mts /absolute/path/to/ppt-master');
const root = await mkdtemp(path.join(tmpdir(), 'qingzhou-semantic-smoke-'));
await mkdir(path.join(root, 'svg_output'));
await mkdir(path.join(root, 'notes'));
const frame = (title: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="#ffffff"/><rect width="960" height="8" fill="#2563eb"/><text x="48" y="65" font-size="30" font-family="Arial, Microsoft YaHei" fill="#172554">${title}</text>${body}</svg>`;
const formula = {
  id: 'update',
  kind: 'formula',
  latex: 'x_{k+1}=x_k-\\alpha_k\\nabla f(x_k)',
  display: true,
  color: '#172554',
  fontSize: 32,
  rect: { x: 60, y: 110, width: 840, height: 90 },
};
const first = await renderSemanticBlocks(
  frame(
    '梯度下降：沿负梯度更新参数',
    '<g data-content-id="update"/><text x="80" y="260" font-size="26" fill="#334155">学习率控制步长，梯度决定局部下降方向。</text><g data-content-id="flow"/>',
  ),
  [
    formula,
    {
      id: 'flow',
      kind: 'scientific-diagram',
      title: '梯度下降迭代',
      provenance: { kind: 'illustrative' },
      rect: { x: 80, y: 310, width: 800, height: 190 },
      spec: {
        type: 'graph',
        nodes: [
          { id: 'current', label: '当前参数', x: 0, y: 0.4 },
          { id: 'gradient', label: '计算梯度', x: 0.5, y: 0.4 },
          { id: 'next', label: '更新参数', x: 1, y: 0.4 },
        ],
        edges: [
          { from: 'current', to: 'gradient' },
          { from: 'gradient', to: 'next' },
        ],
      },
    },
  ],
);
const second = await renderSemanticBlocks(
  frame(
    '凸函数：用可计算曲线表达几何关系',
    '<g data-content-id="quadratic"/><g data-content-id="curve"/>',
  ),
  [
    {
      ...formula,
      id: 'quadratic',
      latex: 'f(x)=x^2,\\quad f^{\\prime\\prime}(x)=2>0',
      rect: { x: 60, y: 85, width: 840, height: 80 },
    },
    {
      id: 'curve',
      kind: 'scientific-diagram',
      title: '二次函数曲线',
      provenance: { kind: 'illustrative' },
      rect: { x: 80, y: 175, width: 800, height: 330 },
      spec: {
        type: 'plot',
        xRange: [-2, 2],
        yRange: [0, 4],
        xLabel: 'x',
        yLabel: 'f(x)',
        series: [{ label: 'quadratic', polynomial: [0, 0, 1], color: '#2563eb' }],
      },
    },
  ],
);
const rendered = [first, second];
if (process.argv[3]) {
  const bytes = await readFile(process.argv[3]);
  const image = await sharp(bytes).png().toBuffer();
  rendered.push(
    await renderSemanticBlocks(
      frame(
        '混合科研表达：生成插图、公式与精确曲线',
        `<g data-content-id="update"/><image href="data:image/png;base64,${image.toString('base64')}" x="50" y="210" width="400" height="270" preserveAspectRatio="xMidYMid meet"/><text x="55" y="507" font-size="16" fill="#334155">AI生成定性示意 · 非实测数据</text><g data-content-id="curve"/>`,
      ),
      [
        { ...formula, rect: { x: 60, y: 95, width: 840, height: 85 } },
        {
          ...second.blocks.find((b) => b.kind === 'scientific-diagram')!,
          rect: { x: 490, y: 210, width: 420, height: 300 },
        },
      ],
    ),
  );
}
const plan = {
  aspectRatio: '16:9',
  planId: 'semantic-smoke',
  title: '数学与科研图渲染验收',
  sourceVersionIds: [],
  designSpec: { contentPolicyVersion: 1 },
  slides: rendered.map((slide, index) => ({
    slideId: `slide-${index + 1}`,
    order: index + 1,
    svg: slide.svg,
  })),
};
assertPresentationPublishable(plan);
for (const [index, slide] of rendered.entries()) {
  const name = String(index + 1).padStart(3, '0');
  await writeFile(path.join(root, 'svg_output', `${name}.svg`), slide.svg);
  await sharp(Buffer.from(slide.svg))
    .png()
    .toFile(path.join(root, `${name}.png`));
  await writeFile(
    path.join(root, 'notes', `${name}.md`),
    `结构化公式和科研图源（可重新编辑）：\n${JSON.stringify(slide.blocks, null, 2)}`,
  );
}
const scripts = path.join(pptMasterRoot, 'skills', 'ppt-master', 'scripts');
await promisify(execFile)('python3', [path.join(scripts, 'svg_quality_checker.py'), root], {
  timeout: 120_000,
});
await promisify(execFile)(
  'python3',
  [
    path.join(scripts, 'svg_to_pptx.py'),
    root,
    '--output',
    path.join(root, 'semantic-smoke.pptx'),
    '--animation',
    'none',
  ],
  { timeout: 120_000 },
);
const files = unzipSync(await readFile(path.join(root, 'semantic-smoke.pptx')));
const slides = Object.keys(files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
if (
  slides.length !== rendered.length ||
  !slides.every((name) => strFromU8(files[name]).includes('a:custGeom'))
)
  throw new Error('The exported deck did not preserve rendered vector geometry');
if (process.argv[3] && !strFromU8(files['ppt/slides/slide3.xml']).includes('<p:pic>'))
  throw new Error('The mixed scientific slide lost its generated image during export');
const size = strFromU8(files['ppt/presentation.xml']).match(
  /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/u,
);
if (!size) throw new Error('Exported slide dimensions are missing');
for (const name of slides) {
  for (const shape of strFromU8(files[name]).split('<p:sp>')) {
    if (!shape.includes('<a:custGeom')) continue;
    const offset = shape.match(/<a:off x="(-?\d+)" y="(-?\d+)"/u);
    const extent = shape.match(/<a:ext cx="(\d+)" cy="(\d+)"/u);
    if (!offset || !extent) throw new Error('Exported vector geometry has no bounds');
    if (
      +offset[1] < -100 ||
      +offset[2] < -100 ||
      +offset[1] + +extent[1] > +size[1] + 100 ||
      +offset[2] + +extent[2] > +size[2] + 100
    )
      throw new Error('Exported vector geometry escaped the slide; inspect nested transforms');
  }
}
if (
  !Object.keys(files)
    .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(name))
    .some((name) => strFromU8(files[name]).includes('latex'))
)
  throw new Error('Editable formula source was not preserved in PPTX notes');
console.log(
  JSON.stringify(
    {
      root,
      pptx: path.join(root, 'semantic-smoke.pptx'),
      slides: slides.length,
      contentQuality: inspectPresentationContent(plan),
      vectorsPreserved: true,
      generatedImageEmbedded: Boolean(process.argv[3]),
      sourcePreservedInNotes: true,
    },
    null,
    2,
  ),
);
