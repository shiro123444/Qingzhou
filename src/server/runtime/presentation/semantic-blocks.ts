import { z } from 'zod';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import { isNativeVisual, type SlideContentIntent, visualRequirements } from './content-intent';
import {
  computeScientificPlot,
  quadraticPlotSchema,
  taylorPlotSchema,
} from './scientific-computation';
import {
  graphLabelLines,
  layoutScientificGraph,
  minimumGraphLabelWidth,
} from './scientific-graph-layout';
import { measureSlideText } from './text-measurement';

const finite = z.number().finite();
const color = z.string().regex(/^#[a-f\d]{6}$/iu);
const point = z.tuple([finite, finite]);
const rect = z
  .object({
    x: finite.nonnegative(),
    y: finite.nonnegative(),
    width: finite.positive(),
    height: finite.positive(),
  })
  .strict();
const provenance = z
  .object({
    kind: z.enum(['illustrative', 'source']),
    reference: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .refine(
    (value) => value.kind !== 'source' || !!value.reference,
    'Measured data requires a source reference',
  );
const series = z
  .object({
    label: z.string().min(1).max(100),
    arrowEnd: z.boolean().optional(),
    color: color.optional(),
    points: z.array(point).min(2).max(300).optional(),
    polynomial: z.array(finite).min(1).max(8).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.points) !== Boolean(value.polynomial),
    'Use points OR polynomial coefficients (constant first)',
  );
const plot = z
  .object({
    type: z.literal('plot'),
    xRange: point.refine(([a, b]) => b > a, 'Axis range must increase'),
    yRange: point.refine(([a, b]) => b > a, 'Axis range must increase'),
    xLabel: z.string().min(1).max(60),
    yLabel: z.string().min(1).max(60),
    equalAspect: z.boolean().optional(),
    series: z.array(series).min(1).max(6),
  })
  .strict();
const graph = z
  .object({
    type: z.literal('graph'),
    nodes: z
      .array(
        z
          .object({
            id: z.string().regex(/^[\w-]{1,60}$/u),
            label: z
              .string()
              .min(1)
              .max(12, 'Use short graph labels (≤12 characters); explanations belong in notes'),
            x: finite.min(0).max(1),
            y: finite.min(0).max(1),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    edges: z
      .array(
        z
          .object({ from: z.string(), to: z.string(), label: z.string().max(60).optional() })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set(value.nodes.map((node) => node.id));
    if (
      ids.size !== value.nodes.length ||
      value.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Graph must have unique nodes and existing, distinct edge endpoints',
      });
  });
const radar = z
  .object({
    type: z.literal('radar'),
    axes: z.array(z.string().trim().min(1).max(18)).min(3).max(6),
    series: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(24),
            color: color.optional(),
            values: z.array(finite.min(0).max(1)),
          })
          .strict(),
      )
      .min(2)
      .max(4),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.series.some((item) => item.values.length !== value.axes.length))
      ctx.addIssue({ code: 'custom', message: 'Each radar series needs one value per axis' });
  });
const base = { id: z.string().regex(/^[\w-]{1,80}$/u), rect };
export const semanticBlockSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...base,
      kind: z.literal('formula'),
      latex: z.string().trim().min(1).max(2000),
      display: z.boolean().default(true),
      color: color.default('#172554'),
      fontSize: finite.min(24).max(64).default(28),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('scientific-diagram'),
      // Surface minimum geometry alongside schema errors in the same bounded repair.
      rect: rect.extend({ width: finite.min(280), height: finite.min(180) }),
      title: z.string().min(1).max(100),
      provenance,
      spec: z
        .discriminatedUnion('type', [
          plot,
          graph.innerType(),
          radar.innerType(),
          quadraticPlotSchema,
          taylorPlotSchema,
        ])
        .superRefine((value, ctx) => {
          if (value.type === 'graph') {
            const result = graph.safeParse(value);
            if (!result.success) for (const issue of result.error.issues) ctx.addIssue(issue);
          }
          if (value.type === 'radar') {
            const result = radar.safeParse(value);
            if (!result.success) for (const issue of result.error.issues) ctx.addIssue(issue);
          }
        }),
    })
    .strict(),
]);
export type SemanticBlock = z.infer<typeof semanticBlockSchema>;

/** The renderer's true minimum, shared with composition before coordinates exist. */
export function minimumScientificDiagramSize(
  block: Extract<SemanticBlock, { kind: 'scientific-diagram' }>,
  width: number,
): { width: number; height: number } {
  const computed =
    block.spec.type === 'quadratic' || block.spec.type === 'taylor'
      ? computeScientificPlot(block.spec)
      : undefined;
  if (block.spec.type === 'graph') {
    const widths = [...new Set([Math.max(280, width), 420, 540, 680, 864, 960])].sort(
      (a, b) => a - b,
    );
    for (const candidate of widths)
      for (const height of [180, 240, 320, 420, 540])
        try {
          layoutScientificGraph(block.spec, candidate, height);
          return { width: Math.ceil(candidate), height };
        } catch {
          // A label that does not fit at this size needs a larger canvas, not a smaller font.
        }
    return { width: 960, height: 540 };
  }
  const spec = computed ?? (block.spec.type === 'plot' ? block.spec : undefined);
  if (!spec) return { width: 280, height: 180 };
  const legendRows = spec.series.reduce(
    (rows, series) => rows + graphLabelLines(series.label, width - 84).length,
    0,
  );
  return { width: 280, height: Math.max(180, 28 + legendRows * 20 + 116) };
}
export type FormulaBlock = Extract<SemanticBlock, { kind: 'formula' }>;

const sameFormulaSource = (a: string, b: string) => {
  const content = (latex: string) =>
    latex.replaceAll(/\\begin\{aligned\}|\\end\{aligned\}|\\\\|&/gu, '').replaceAll(/\s/gu, '');
  return content(a) === content(b);
};

/** Send editable sources back to the model, never ask it to reproduce rendered glyph paths. */
export function semanticAuthoringSvg(svg: string, raw: unknown): string {
  const blocks = z.array(semanticBlockSchema).parse(raw ?? []);
  if (!blocks.length) return svg;
  const document = parseString(svg);
  for (const block of blocks) {
    const groups = Array.from(document.getElementsByTagName('g')).filter((element) =>
      block.kind === 'formula'
        ? element.getAttribute('data-content-id') === block.id
        : element.getAttribute('data-scientific-diagram') === block.id,
    );
    if (groups.length !== 1) throw new Error(`Cannot recover editable content anchor ${block.id}`);
    const anchor = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    anchor.setAttribute('data-content-id', block.id);
    groups[0].parentNode!.replaceChild(anchor, groups[0]);
  }
  return document.toString();
}

export const escapeSvgText = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const number = (value: number) => Number(value.toFixed(3));

/** Diagram-owned labels must fit their local viewport, not merely the slide. */
function diagramLabelLines(value: string, width: number, maximum = 3): string[] {
  const lines: string[] = [];
  let line = '';
  for (const token of value.match(/[A-Za-z0-9.]+|\P{ASCII}|\s+|./gu) ?? []) {
    if (measureSlideText(token, 16) > width)
      throw new Error(`Diagram label needs a wider region for "${token}"`);
    if (line && measureSlideText(line + token, 16) > width) {
      lines.push(line.trim());
      line = '';
    }
    line += token;
  }
  if (line.trim()) lines.push(line.trim());
  if (lines.length > maximum)
    throw new Error(`Diagram label needs more space: ${value.slice(0, 80)}`);
  return lines;
}

export function renderScientificDiagram(
  block: Extract<SemanticBlock, { kind: 'scientific-diagram' }>,
): string {
  const { width, height } = block.rect;
  if (width < 280 || height < 180)
    throw new Error('Scientific diagrams need at least 280×180 canvas units');
  const label = (x: number, y: number, text: string, anchor = 'middle') =>
    `<text x="${number(x)}" y="${number(y)}" font-size="16" font-family="Arial, Microsoft YaHei" text-anchor="${anchor}" fill="#334155">${escapeSvgText(text)}</text>`;
  const body: string[] = [];
  const palette = ['#2563eb', '#dc2626', '#059669', '#7c3aed', '#b45309', '#0891b2'];
  const computed =
    block.spec.type === 'quadratic' || block.spec.type === 'taylor'
      ? computeScientificPlot(block.spec)
      : undefined;
  const source =
    computed?.caption ??
    (block.provenance.kind === 'source'
      ? `来源：${block.provenance.reference}`
      : block.spec.type === 'radar'
        ? '教学定性比较'
        : block.spec.type === 'plot' && block.spec.series.some((s) => s.points)
          ? '概念轨迹（非运行结果）'
          : '');
  // Leave a real right-side inset: browser/PPTX font fallback can be wider
  // than canvas metrics, especially for mixed CJK, Greek and numerals.
  const radarIllustrative = block.spec.type === 'radar' && block.provenance.kind === 'illustrative';
  const sourceLines =
    source && !radarIllustrative
      ? diagramLabelLines(source, Math.min(width - 32, width * 0.8))
      : [];
  const footerHeight = sourceLines.length * 20;
  if (block.spec.type === 'plot' || computed) {
    const spec = computed ?? (block.spec as z.infer<typeof plot>);
    const left = 48;
    const legendLines = spec.series.map((series) => graphLabelLines(series.label, width - 84));
    const legendHeight = legendLines.reduce((rows, lines) => rows + lines.length, 0) * 20;
    const right = width - 28;
    const bottom = height - 68 - Math.max(0, sourceLines.length - 1) * 20;
    // A page whose rect cannot also hold legend rows still deserves a truthful structured plot:
    // drop the legend and label every series at its end instead of failing the whole page.
    const withLegend = bottom - (28 + legendHeight) >= 48;
    const top = withLegend ? 28 + legendHeight : 28;
    if (bottom - top < 48)
      throw new Error(
        `Plot requires at least ${minimumScientificDiagramSize(block, width).height}px height to separate legend and geometry`,
      );
    let legendY = 32;
    if (withLegend)
      legendLines.forEach((lines, index) => {
        body.push(
          `<path d="M ${left} ${legendY - 5} h 18" stroke="${spec.series[index].color ?? palette[index]}" stroke-width="3"/>`,
        );
        lines.forEach((line) => {
          body.push(label(left + 26, legendY, line, 'start'));
          legendY += 20;
        });
      });
    const sx = (right - left) / (spec.xRange[1] - spec.xRange[0]);
    const sy = (bottom - top) / (spec.yRange[1] - spec.yRange[0]);
    const scaleX = spec.equalAspect ? Math.min(sx, sy) : sx;
    const scaleY = spec.equalAspect ? Math.min(sx, sy) : sy;
    const X = (x: number) =>
      (left + right) / 2 + (x - (spec.xRange[0] + spec.xRange[1]) / 2) * scaleX;
    const Y = (y: number) =>
      (top + bottom) / 2 - (y - (spec.yRange[0] + spec.yRange[1]) / 2) * scaleY;
    const axisLeft = X(spec.xRange[0]);
    const axisRight = X(spec.xRange[1]);
    const axisTop = Y(spec.yRange[1]);
    const axisBottom = Y(spec.yRange[0]);
    body.push(
      `<path d="M ${number(axisLeft)} ${number(axisTop)} V ${number(axisBottom)} H ${number(axisRight)}" fill="none" stroke="#64748b" stroke-width="2"/>`,
    );
    for (let tick = 0; tick <= 4; tick++) {
      const x = spec.xRange[0] + (tick / 4) * (spec.xRange[1] - spec.xRange[0]);
      const y = spec.yRange[0] + (tick / 4) * (spec.yRange[1] - spec.yRange[0]);
      body.push(
        label(X(x), axisBottom + 20, String(number(x))),
        label(axisLeft - 8, Y(y) + 5, String(number(y)), 'end'),
      );
    }
    body.push(
      label((left + right) / 2, axisBottom + 43, spec.xLabel),
      label(left, 18, spec.yLabel, 'start'),
    );
    spec.series.forEach((item, index) => {
      const points =
        item.points ??
        Array.from({ length: 121 }, (_, i) => {
          const x = spec.xRange[0] + (i / 120) * (spec.xRange[1] - spec.xRange[0]);
          return [x, item.polynomial!.reduceRight((y, coefficient) => y * x + coefficient, 0)] as [
            number,
            number,
          ];
        });
      if (
        points.some(
          ([x, y]) =>
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            x < spec.xRange[0] ||
            x > spec.xRange[1] ||
            y < spec.yRange[0] ||
            y > spec.yRange[1],
        )
      )
        throw new Error(
          'Plot values must fit declared axes; expand axes rather than silently clipping scientific data',
        );
      body.push(
        `<polyline points="${points.map(([x, y]) => `${number(X(x))},${number(Y(y))}`).join(' ')}" fill="none" stroke="${item.color ?? palette[index]}" stroke-width="2.5"/>`,
      );
      if (item.arrowEnd) {
        const end = points.at(-1)!;
        const previous = [...points].reverse().find(([x, y]) => x !== end[0] || y !== end[1]);
        if (!previous) throw new Error('Vector arrow requires a nonzero direction');
        const dx = X(end[0]) - X(previous[0]);
        const dy = Y(end[1]) - Y(previous[1]);
        const length = Math.hypot(dx, dy);
        const ux = dx / length,
          uy = dy / length;
        body.push(
          `<path d="M ${number(X(end[0]) - 9 * ux - 4 * uy)} ${number(Y(end[1]) - 9 * uy + 4 * ux)} L ${number(X(end[0]))} ${number(Y(end[1]))} L ${number(X(end[0]) - 9 * ux + 4 * uy)} ${number(Y(end[1]) - 9 * uy - 4 * ux)}" fill="none" stroke="${item.color ?? palette[index]}" stroke-width="2.5"/>`,
        );
      }
      if (!withLegend)
        body.push(
          `<text x="${number(X(points.at(-1)![0]) + 6)}" y="${number(Y(points.at(-1)![1]) - 6)}" font-size="14" font-family="Arial, Microsoft YaHei" fill="${item.color ?? palette[index]}">${escapeSvgText(item.label.slice(0, 18))}</text>`,
        );
    });
  } else if (block.spec.type === 'radar') {
    const spec = radar.parse(block.spec);
    const centerX = width / 2;
    const plotTop = Math.max(64, 18 + spec.series.length * 22);
    const footerGap = sourceLines.length ? 48 : 40;
    const centerY = (plotTop + height - footerHeight - footerGap) / 2;
    // Long CJK dimension names should remain whole when the chart has enough
    // width. A fixed 96px label box created one-character orphan lines.
    const axisLines = spec.axes.map((axis) => diagramLabelLines(axis, 160, 2));
    const sideWidth = Math.max(
      ...axisLines.map((lines, index) => {
        const angle = -Math.PI / 2 + (index * 2 * Math.PI) / spec.axes.length;
        return Math.abs(Math.cos(angle)) > 0.65
          ? Math.max(...lines.map((line) => measureSlideText(line, 16)))
          : 0;
      }),
    );
    const radius = Math.min(
      width * 0.25,
      centerX - sideWidth - 22,
      (height - footerHeight - plotTop - footerGap) / 2,
    );
    if (radius < 44) throw new Error('Radar chart needs a taller or wider region');
    const pointAt = (axis: number, value: number) => {
      const angle = -Math.PI / 2 + (axis * 2 * Math.PI) / spec.axes.length;
      return [
        centerX + Math.cos(angle) * radius * value,
        centerY + Math.sin(angle) * radius * value,
      ];
    };
    for (const level of [0.5, 1])
      body.push(
        `<polygon points="${spec.axes.map((_, axis) => pointAt(axis, level).map(number).join(',')).join(' ')}" fill="none" stroke="#cbd5e1" stroke-width="1"/>`,
      );
    spec.axes.forEach((axis, index) => {
      const [endX, endY] = pointAt(index, 1);
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / spec.axes.length;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const lines = axisLines[index];
      const anchor = dx > 0.65 ? 'start' : dx < -0.65 ? 'end' : 'middle';
      const labelX = endX + dx * 18;
      const labelY = endY + dy * 18;
      body.push(
        `<path d="M ${number(centerX)} ${number(centerY)} L ${number(endX)} ${number(endY)}" stroke="#cbd5e1"/>`,
      );
      lines.forEach((line, row) =>
        body.push(label(labelX, labelY + 5 + (row - (lines.length - 1) / 2) * 19, line, anchor)),
      );
    });
    spec.series.forEach((item, index) => {
      const stroke = item.color ?? palette[index];
      body.push(
        `<polygon points="${item.values.map((value, axis) => pointAt(axis, value).map(number).join(',')).join(' ')}" fill="${stroke}" fill-opacity="0.11" stroke="${stroke}" stroke-width="2.5"/>`,
      );
      body.push(`<path d="M 10 ${18 + index * 22} h 16" stroke="${stroke}" stroke-width="3"/>`);
      body.push(label(34, 23 + index * 22, item.label, 'start'));
    });
  } else if (block.spec.type === 'graph') {
    const spec = block.spec;
    const { positions, nodeWidth, nodeHeight, horizontal } = layoutScientificGraph(
      spec,
      width,
      height,
    );
    const at = (node: (typeof spec.nodes)[number]) => positions.get(node.id)!;
    for (const edge of spec.edges) {
      const a = at(spec.nodes.find((node) => node.id === edge.from)!);
      const b = at(spec.nodes.find((node) => node.id === edge.to)!);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 60) throw new Error('Graph nodes overlap; allocate more space');
      const inset = Math.min(
        nodeWidth / 2 / Math.max(Math.abs(dx / distance), 0.001),
        nodeHeight / 2 / Math.max(Math.abs(dy / distance), 0.001),
      );
      const ex = b.x - (dx / distance) * inset;
      const ey = b.y - (dy / distance) * inset;
      const sx = a.x + (dx / distance) * inset;
      const sy = a.y + (dy / distance) * inset;
      if (horizontal && b.x > a.x) {
        const start = a.x + nodeWidth / 2;
        const end = b.x - nodeWidth / 2;
        const merging =
          spec.edges.filter((item) => item.to === edge.to).length > 1 &&
          spec.edges.filter((item) => item.from === edge.from).length === 1;
        const elbow = merging ? end - 6 : start + 6;
        const labelY = merging ? a.y : b.y;
        body.push(
          `<path d="M ${number(start)} ${number(a.y)} H ${number(elbow)} V ${number(b.y)} H ${number(end)} M ${number(end - 8)} ${number(b.y - 4)} L ${number(end)} ${number(b.y)} L ${number(end - 8)} ${number(b.y + 4)}" stroke="#64748b" stroke-width="2" fill="none"/>`,
        );
        if (edge.label) {
          const lines = graphLabelLines(
            edge.label,
            Math.max(end - start - 20, minimumGraphLabelWidth(edge.label)),
          );
          const center = (start + end) / 2 + 2;
          const top = labelY - lines.length * 10;
          const labelWidth =
            Math.max(
              ...lines.map((line) =>
                [...line].reduce(
                  (sum, character) => sum + (/\P{ASCII}/u.test(character) ? 16 : 9),
                  0,
                ),
              ),
            ) + 6;
          body.push(
            `<rect x="${number(center - labelWidth / 2)}" y="${number(top - 2)}" width="${number(labelWidth)}" height="${lines.length * 20 + 4}" fill="#ffffff"/>`,
          );
          lines.forEach((line, i) => body.push(label(center, top + 15 + i * 20, line)));
        }
        continue;
      }
      body.push(
        `<path d="M ${number(sx)} ${number(sy)} L ${number(ex)} ${number(ey)} M ${number(ex - (dx / distance) * 9 - (dy / distance) * 4)} ${number(ey - (dy / distance) * 9 + (dx / distance) * 4)} L ${number(ex)} ${number(ey)} L ${number(ex - (dx / distance) * 9 + (dy / distance) * 4)} ${number(ey - (dy / distance) * 9 - (dx / distance) * 4)}" stroke="#64748b" stroke-width="2" fill="none"/>`,
      );
      if (edge.label) {
        if (!horizontal && Math.abs(dx) < 1 && b.y > a.y) {
          const needed = minimumGraphLabelWidth(edge.label);
          const rightLane = width - a.x - 14;
          const leftLane = a.x - 14;
          const placeRight = rightLane >= leftLane;
          const lines = graphLabelLines(
            edge.label,
            Math.max(placeRight ? rightLane : leftLane, needed),
          );
          if (lines.length * 20 > ey - sy)
            throw new Error('Vertical graph labels need more space between nodes');
          lines.forEach((line, index) =>
            body.push(
              label(
                placeRight ? a.x + 10 : a.x - 10,
                (sy + ey) / 2 + 5 + (index - (lines.length - 1) / 2) * 20,
                line,
                placeRight ? 'start' : 'end',
              ),
            ),
          );
        } else body.push(label((a.x + b.x) / 2, (a.y + b.y) / 2 - 8, edge.label));
      }
    }
    for (const node of spec.nodes) {
      const p = at(node);
      if (node.label.length > 12)
        throw new Error('Use short graph labels (≤12 characters); explanations belong in notes');
      body.push(
        `<rect x="${number(p.x - nodeWidth / 2)}" y="${number(p.y - nodeHeight / 2)}" width="${nodeWidth}" height="${nodeHeight}" rx="8" fill="#eff6ff" stroke="#2563eb"/>`,
        ...p.lines.map((line, index) =>
          label(p.x, p.y + 5 + (index - (p.lines.length - 1) / 2) * 20, line),
        ),
      );
    }
  }
  sourceLines.forEach((line, index) =>
    body.push(label(8, height - 6 - (sourceLines.length - index - 1) * 20, line, 'start')),
  );
  if (radarIllustrative) body.push(label(width - 8, 23, source, 'end'));
  return `<g transform="translate(${block.rect.x} ${block.rect.y})" data-scientific-diagram="${block.id}" aria-label="${escapeSvgText(block.title)}">${body.join('')}</g>`;
}

/** Server-owned content rendering replaces explicit empty anchors, preserving paint order. */
export async function renderSemanticBlocks(
  svg: string,
  raw: unknown,
  intent?: SlideContentIntent,
): Promise<{ svg: string; blocks: SemanticBlock[] }> {
  const blocks = z
    .array(semanticBlockSchema)
    .max(12)
    .parse(raw ?? []);
  const document = parseString(svg);
  const viewBox = document.documentElement
    .getAttribute('viewBox')
    ?.split(/[\s,]+/u)
    .map(Number);
  if (
    !viewBox ||
    viewBox.length !== 4 ||
    viewBox.some((v) => !Number.isFinite(v)) ||
    viewBox[2] <= 0 ||
    viewBox[3] <= 0
  )
    throw new Error('Semantic rendering requires a valid SVG viewBox');
  if (new Set(blocks.map((b) => b.id)).size !== blocks.length)
    throw new Error('Content block ids must be unique');
  for (const formula of intent?.formulas ?? []) {
    if (formula.placement === 'notes') continue;
    if (
      !blocks.some(
        (b) =>
          b.kind === 'formula' && b.id === formula.id && sameFormulaSource(b.latex, formula.latex),
      )
    )
      throw new Error(
        `Render required formula ${formula.id} using its exact LaTeX in contentBlocks`,
      );
    const block = blocks.find((b) => b.id === formula.id)!;
    if (
      block.kind === 'formula' &&
      formula.measurement &&
      (block.fontSize !== formula.measurement.fontSize ||
        (block.latex.replaceAll(/\s/gu, '') === formula.latex.replaceAll(/\s/gu, '') &&
          (block.rect.width < formula.measurement.minRectWidth ||
            block.rect.height < formula.measurement.minRectHeight)))
    )
      throw new Error(
        `Formula ${formula.id}: reserve at least ${formula.measurement.minRectWidth}×${formula.measurement.minRectHeight} at ${formula.measurement.fontSize}px (premeasured); rearrange the layout, do not shrink or change its source.`,
      );
  }
  for (const visual of visualRequirements(intent).filter((v) => v.required && isNativeVisual(v))) {
    if (
      !blocks.some(
        (b) => b.kind === 'scientific-diagram' && (!intent?.visuals || b.id === visual.id),
      )
    )
      throw new Error(
        `This page requires a structured scientific diagram ${visual.id}, not an impression image`,
      );
    const scientific = blocks.find(
      (b) => b.kind === 'scientific-diagram' && (!intent?.visuals || b.id === visual.id),
    );
    if (
      /雷达图|radar\s*chart/iu.test(visual.brief) &&
      scientific?.kind === 'scientific-diagram' &&
      scientific.spec.type !== 'radar'
    )
      throw new Error(`Visual ${visual.id} requires a radar chart, not ${scientific.spec.type}`);
    if (
      visual.fidelity === 'computed' &&
      scientific?.kind === 'scientific-diagram' &&
      !['quadratic', 'taylor'].includes(scientific.spec.type) &&
      scientific.provenance.kind !== 'source'
    )
      throw new Error(
        `Visual ${visual.id} requires a reproducible quadratic/taylor recipe or referenced source data, not invented points.`,
      );
  }
  let result = svg;
  for (const block of blocks) {
    const r = block.rect;
    if (
      r.x < viewBox[0] ||
      r.y < viewBox[1] ||
      r.x + r.width > viewBox[0] + viewBox[2] ||
      r.y + r.height > viewBox[1] + viewBox[3]
    )
      throw new Error(`Content block ${block.id} extends beyond the canvas`);
    for (const other of blocks) {
      if (other.id === block.id) continue;
      const q = other.rect;
      if (
        Math.min(r.x + r.width, q.x + q.width) - Math.max(r.x, q.x) > 1 &&
        Math.min(r.y + r.height, q.y + q.height) - Math.max(r.y, q.y) > 1
      )
        throw new Error(
          `Semantic blocks ${block.id} and ${other.id} overlap; allocate separate readable regions`,
        );
    }
    const element = Array.from(document.getElementsByTagName('g')).find(
      (element) => element.getAttribute('data-content-id') === block.id,
    );
    for (let parent = element?.parentNode; parent?.nodeType === 1; parent = parent.parentNode) {
      if ((parent as Element).getAttribute('transform'))
        throw new Error('Content anchors must use canvas coordinates without transformed parents');
    }
    const anchor = new RegExp(
      `<g\\b(?=[^>]*\\bdata-content-id=["']${block.id}["'])[^>]*(?:\\/>|>\\s*<\\/g>)`,
      'gu',
    );
    if ([...result.matchAll(anchor)].length !== 1)
      throw new Error(`Provide exactly one empty <g data-content-id="${block.id}"/> anchor`);
    const rendered =
      block.kind === 'scientific-diagram'
        ? renderScientificDiagram(block)
        : await (await import('./formula-renderer')).renderFormula(block);
    result = result.replace(anchor, () => rendered);
  }
  return { svg: result, blocks };
}

export const SEMANTIC_BLOCK_FORMAT =
  `每页JSON可包含contentBlocks数组。formula: {id,kind:"formula",latex,display:true,color:"#172554",fontSize:28,rect:{x,y,width,height}}。scientific-diagram: {id,kind:"scientific-diagram",title,provenance:{kind:"illustrative"或"source",reference?:"出处"},rect:{x,y,width,height},spec: {type:"plot",xRange:[min,max],yRange:[min,max],xLabel,yLabel,series:[{label,color?:"#RRGGBB",arrowEnd?:true,points:[[x,y],...] 或 polynomial:[常数项,一次项,二次项,...]}]} 或 spec:{type:"graph",nodes:[{id,label:"最多12字",x:0到1,y:0到1}],edges:[{from,to,label?}]} 或定性雷达图 spec:{type:"radar",axes:["维度1","维度2","维度3","维度4"],series:[{label:"算法A",values:[0.2,0.5,0.8,0.6]},{label:"算法B",values:[0.7,0.6,0.3,0.9]}]}，雷达值在0到1，仅用于明确标为教学定性比较、不得伪称实测。方向向量用独立points序列和arrowEnd:true，不要把没有箭头的线段当向量。图例由服务端在绘图区外排布，每个图例行需20px空间；复杂多曲线图优先独占一页，不要与多行推导争抢区域。图区域至少280×180，坐标范围必须容纳全部数据。contentBlocks中的公式id和latex必须与内容编译器一致。公式区域须容纳指定字号，长公式拆行，不能压缩到无法阅读。` +
  ' 对需要精确计算的图，使用服务端计算配方（不要填points）：spec:{type:"quadratic",a:1,b:20,levels:[10,20],start:[-3,1],learningRate:0.08,momentum:0.9,steps:20,methods:["gradient","momentum"]}，函数为(a*x²+b*y²)/2，支持gradient/momentum/nesterov，等高线与迭代点由服务端真实计算。泰勒对比：spec:{type:"taylor",coefficients:[0,0,1,0.1],at:1,xRange:[-1,3]}，系数常数项在前，由服务端计算函数与一/二阶近似。图区域高度按图例行数测算，至少为144+20×图例行数；空间不够时拆页，不要缩小公式或覆盖板书区。精确向量几何的plot使用equalAspect:true避免角度失真。普通概念框架应使用Image资产或graph，不需要免责声明。';
