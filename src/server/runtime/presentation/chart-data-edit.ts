import { z } from 'zod';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type {
  PresentationJobInput,
  PresentationMessageInput,
  PresentationPlan,
} from '../../../../packages/runtime-contracts/src';
import { updateApprovedPointSeries, updateChartNarration } from './approved-point-series';
import { learnedTextLines, learnedTextSvg } from './learned-layout-primitives';
import { isEditableScatter, replaceScatterPoints } from './scatter-chart';
import { renderScientificDiagram, semanticBlockSchema } from './semantic-blocks';

const coordinate = z.number().finite();
export const chartDataPatchSchema = z
  .object({
    blockId: z.string().regex(/^[\w-]{1,80}$/u),
    expectedVersionId: z.string().min(1).max(128),
    series: z
      .array(
        z
          .array(z.tuple([coordinate, coordinate]))
          .min(2)
          .max(300),
      )
      .min(1)
      .max(6),
  })
  .strict();

type ChartDataPatch = z.infer<typeof chartDataPatchSchema>;
const invalid = (message: string) =>
  Object.assign(new Error(message), { code: 'PRESENTATION_INVALID' });

export function assertChartDataPatchTarget(
  plan: PresentationPlan | undefined,
  target: PresentationMessageInput['target'],
  patch: ChartDataPatch,
) {
  const index = target.type === 'slide' ? target.slideNumber - 1 : -1;
  const slide = plan?.slides[index];
  const raw = slide?.metadata?.contentBlocks;
  const matches = Array.isArray(raw) ? raw.filter((block) => block?.id === patch.blockId) : [];
  const parsed = matches.length === 1 ? semanticBlockSchema.safeParse(matches[0]) : undefined;
  if (!slide || !parsed?.success || !isEditableScatter(parsed.data))
    throw invalid('所选页面没有可编辑的 XY 图表');
  const chart = parsed.data;
  if (chart.spec.series.length !== patch.series.length) throw invalid('图表数据列数与原图不一致');
  const updated = replaceScatterPoints(chart, patch.series);
  if (
    [updated.spec.xRange, updated.spec.yRange].some(
      ([low, high]) =>
        !Number.isFinite(high - low) || !Number.isFinite(low + high) || (high - low) / 4 === 0,
    )
  )
    throw invalid('图表坐标值超出了可显示的范围');
  const document = parseString(slide.svg);
  const groups = Array.from(document.getElementsByTagName('g')).filter(
    (node) => node.getAttribute('data-scientific-diagram') === chart.id,
  );
  const expected = parseString(
    `<svg xmlns="http://www.w3.org/2000/svg">${renderScientificDiagram(chart)}</svg>`,
  );
  const visual = groups[0]?.cloneNode(true) as Element | undefined;
  visual?.removeAttribute('data-canvas-group');
  if (groups.length !== 1 || visual?.toString() !== expected.documentElement.firstChild?.toString())
    throw invalid('图表预览与数据版本不一致，请重新打开最新页面');
  return { index, slide, chart, updated, blocks: raw as unknown[], document, group: groups[0] };
}

export function applyChartDataPatch(
  plan: PresentationPlan,
  input: PresentationJobInput,
  message: Pick<PresentationMessageInput, 'chartDataPatch' | 'target'>,
) {
  const patch = chartDataPatchSchema.parse(message.chartDataPatch);
  const { index, slide, chart, updated, blocks, document, group } = assertChartDataPatchTarget(
    plan,
    message.target,
    patch,
  );
  const previous = chart.spec.series.map((series) => series.points!);
  const revise = (points: string[]) =>
    updateApprovedPointSeries(points, previous, patch.series).map((text) =>
      updateChartNarration(text, previous, patch.series, [chart.spec.xLabel, chart.spec.yLabel]),
    );
  const reviseOutline = (value: unknown) =>
    Array.isArray(value) && value.every((point) => typeof point === 'string')
      ? revise(value)
      : value;
  const provenance = updated.provenance;
  const revisedChart = {
    ...updated,
    provenance: {
      ...provenance,
      ...(provenance.caption ? { caption: revise([provenance.caption])[0] } : {}),
      ...(provenance.reference ? { reference: revise([provenance.reference])[0] } : {}),
    },
  };
  // Learned paragraphs retain their source string across display line breaks.
  // Reflow the edited source with the same font, measure and starting baseline.
  for (const paragraph of Array.from(document.getElementsByTagName('g'))) {
    const original = paragraph.getAttribute('data-source-paragraph');
    if (!original) continue;
    const [value] = revise([original]);
    if (original === value) continue;
    const first = paragraph.getElementsByTagName('text')[0];
    if (!first) continue;
    const font = document.documentElement.getAttribute('font-family') ?? 'Arial';
    const width = Number(paragraph.getAttribute('data-source-width'));
    const size = Number(first.getAttribute('font-size'));
    const lines = learnedTextLines(value, width, size, font);
    const copy = learnedTextSvg(
      lines,
      Number(first.getAttribute('x')),
      Number(first.getAttribute('y')) - size,
      size,
      first.getAttribute('fill') ?? '#334155',
    );
    const children = parseString(`<svg xmlns="http://www.w3.org/2000/svg">${copy}</svg>`)
      .documentElement.childNodes;
    while (paragraph.firstChild) paragraph.removeChild(paragraph.firstChild);
    for (const node of Array.from(children)) paragraph.appendChild(document.importNode(node, true));
    paragraph.setAttribute('data-source-paragraph', value);
  }
  const replacement = parseString(
    `<svg xmlns="http://www.w3.org/2000/svg">${renderScientificDiagram(revisedChart)}</svg>`,
  ).documentElement.firstChild!;
  const member = group.getAttribute('data-canvas-group');
  if (member) (replacement as Element).setAttribute('data-canvas-group', member);
  group.parentNode!.replaceChild(document.importNode(replacement, true), group);
  // An explicitly repeated data statement on the same slide tracks the edited
  // series. Match the old coordinates before changing any surrounding prose.
  for (const node of Array.from(document.getElementsByTagName('text'))) {
    for (const child of [node, ...Array.from(node.getElementsByTagName('tspan'))]) {
      if (child.childNodes.length !== 1 || child.firstChild?.nodeType !== 3) continue;
      const text = child.firstChild.nodeValue ?? '';
      const [revised] = revise([text]);
      if (text !== revised) child.replaceChild(document.createTextNode(revised), child.firstChild);
    }
  }
  const nextSlide = {
    ...slide,
    notes: slide.notes ? revise(slide.notes.split('\n')).join('\n') : slide.notes,
    svg: document.toString(),
    metadata: {
      ...slide.metadata,
      contentBlocks: blocks.map((block) =>
        (block as { id: string }).id === chart.id ? revisedChart : block,
      ),
      ...(slide.metadata?.outline ? { outline: reviseOutline(slide.metadata.outline) } : {}),
    },
  };
  const outline = input.options?.outline;
  return {
    input: Array.isArray(outline)
      ? {
          ...input,
          options: {
            ...input.options,
            outline: outline.map((page, i) =>
              i === index ? { ...page, keyPoints: reviseOutline(page?.keyPoints) } : page,
            ),
          },
        }
      : input,
    plan: { ...plan, slides: plan.slides.map((item, i) => (i === index ? nextSlide : item)) },
    slideId: slide.slideId,
  };
}
