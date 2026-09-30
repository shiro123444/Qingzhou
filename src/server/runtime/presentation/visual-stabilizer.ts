import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import { visualRequirementSchema } from './content-intent';
import {
  renderScientificDiagram,
  renderSemanticBlocks,
  semanticAuthoringSvg,
  semanticBlockSchema,
} from './semantic-blocks';
import type { TemplateApplication } from './templates';
import { measureSlideText } from './text-measurement';
import type { PresentationVisualReview } from './visual-critic';
import { reconcileNativeVisualAssets } from './visual-ownership';

/** Only an explicit, page-selected header contract may author template chrome. */
export function stampLockedTemplateChrome(
  svg: string,
  template?: TemplateApplication,
  archetypeId?: string,
): string {
  const archetypes = template?.visual?.designProgram?.archetypes ?? [];
  const archetype = archetypeId
    ? archetypes.find((item) => item.id === archetypeId)
    : archetypes.length === 1
      ? archetypes[0]
      : undefined;
  const header = archetype?.header;
  if (!header) return svg;
  const document = parseString(svg);
  const root = document.documentElement;
  const viewBox = root
    ?.getAttribute('viewBox')
    ?.split(/[\s,]+/u)
    .map(Number);
  if (
    !root ||
    !viewBox ||
    viewBox.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    viewBox[2] <= 0 ||
    viewBox[3] <= 0
  )
    return svg;
  const [x, y, width, height] = viewBox;
  const box = {
    x: x + header.box.x * width,
    y: y + header.box.y * height,
    width: header.box.width * width,
    height: header.box.height * height,
  };
  if (
    Array.from(document.getElementsByTagName('rect')).some(
      (rect) =>
        rect.getAttribute('fill')?.toLowerCase() === header.fill.toLowerCase() &&
        Object.entries(box).every(
          ([key, value]) => Math.abs(Number(rect.getAttribute(key)) - value) < 1,
        ),
    )
  )
    return svg;
  // Missing/ambiguous title evidence is not permission to paint over body content.
  const titles = Array.from(document.getElementsByTagName('text')).filter((text) => {
    const baseline = Number(text.getAttribute('y'));
    return (
      text.parentNode === root &&
      Number(text.getAttribute('font-size')) >= width / 40 &&
      baseline > box.y &&
      baseline <= box.y + box.height
    );
  });
  if (titles.length !== 1) return svg;
  const title = titles[0];
  const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  for (const [key, value] of Object.entries(box)) bar.setAttribute(key, String(value));
  bar.setAttribute('fill', header.fill);
  bar.setAttribute('data-template-chrome', 'header');
  title.setAttribute('fill', header.textColor);
  // Keep the background behind its title, but above the page's background.
  root.insertBefore(bar, title);
  return document.toString();
}

/** Recompile typed native blocks after renderer upgrades, independent of model retries. */
export async function stabilizePresentationVisuals(
  plan: PresentationPlan,
  template?: TemplateApplication,
): Promise<PresentationPlan> {
  const slides = await Promise.all(
    plan.slides.map(async (slide) => {
      const blocks = slide.metadata?.contentBlocks;
      let svg = slide.svg;
      if (Array.isArray(blocks) && blocks.length) {
        const editable = semanticAuthoringSvg(svg, blocks);
        svg = (await renderSemanticBlocks(editable, blocks)).svg;
      }
      svg = stampLockedTemplateChrome(
        svg,
        template,
        (slide.metadata?.visualDirection as { archetypeId?: string } | undefined)?.archetypeId,
      );
      return reconcileNativeVisualAssets(svg === slide.svg ? slide : { ...slide, svg });
    }),
  );
  return slides.every((slide, index) => slide === plan.slides[index]) ? plan : { ...plan, slides };
}

/** A pixel critic cannot override a verified native formula's exact source. */
export function reconcileTypedFormulaReview(
  review: PresentationVisualReview,
  plan: PresentationPlan,
): PresentationVisualReview {
  const issues = review.issues.filter((issue) => {
    if (
      issue.category !== 'formula' ||
      !/符号|latex|表达式|半正定|偏序/iu.test(`${issue.evidence} ${issue.instruction}`) ||
      /重叠|断裂|裁切|遮挡|overlap|clip/iu.test(issue.evidence)
    )
      return true;
    const slide = plan.slides.find((candidate) => candidate.slideId === issue.slideId);
    if (!slide || !Array.isArray(slide.metadata?.contentBlocks)) return true;
    const document = parseString(slide.svg);
    const rendered = Array.from(document.getElementsByTagName('g'));
    const symbols = [
      ...issue.instruction.matchAll(/\\(?:succeq|preceq|geq|leq|neq|ge|le)\b/gu),
    ].map((match) => match[0]);
    const candidates = slide.metadata.contentBlocks.filter((raw) => {
      if (
        !raw ||
        typeof raw !== 'object' ||
        !('kind' in raw) ||
        raw.kind !== 'formula' ||
        !('latex' in raw) ||
        typeof raw.latex !== 'string' ||
        !('id' in raw) ||
        typeof raw.id !== 'string' ||
        (issue.blockId && issue.blockId !== raw.id)
      )
        return false;
      const latex = raw.latex;
      return (
        issue.instruction.includes(latex) ||
        (symbols.length === 1 && new Set(latex.match(/\\[A-Za-z]+/gu)).has(symbols[0]))
      );
    });
    // A short symbol instruction may identify one source; ambiguity must remain reviewable.
    if (candidates.length !== 1) return true;
    const raw = candidates[0] as { id: string; latex: string };
    return !rendered.some(
      (group) =>
        group.getAttribute('data-content-id') === raw.id &&
        group.getAttribute('data-formula-latex') === raw.latex &&
        group.getElementsByTagName('path').length > 0,
    );
  });
  return issues.length === review.issues.length
    ? review
    : {
        ...review,
        issues,
        passed: issues.every((issue) => issue.severity === 'minor'),
      };
}

export interface VisualEvidenceAdjudication {
  category: PresentationVisualReview['issues'][number]['category'];
  minimumClearancePx?: number;
  reason:
    | 'verified-formula-source'
    | 'verified-native-radar-clearance'
    | 'server-drawn-annotations';
  slideId: string;
  visualId?: string;
}

const distanceToBox = (
  point: [number, number],
  box: { left: number; right: number; top: number; bottom: number },
): number =>
  Math.hypot(
    Math.max(box.left - point[0], 0, point[0] - box.right),
    Math.max(box.top - point[1], 0, point[1] - box.bottom),
  );

const distanceFromSegmentToBox = (
  start: [number, number],
  end: [number, number],
  box: { left: number; right: number; top: number; bottom: number },
): number => {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  let entry = 0;
  let exit = 1;
  let crosses = true;
  for (const [p, q] of [
    [-dx, start[0] - box.left],
    [dx, box.right - start[0]],
    [-dy, start[1] - box.top],
    [dy, box.bottom - start[1]],
  ]) {
    if (p === 0 && q < 0) {
      crosses = false;
      break;
    }
    if (p !== 0) {
      const crossing = q / p;
      if (p < 0) entry = Math.max(entry, crossing);
      else exit = Math.min(exit, crossing);
    }
  }
  if (crosses && entry <= exit && entry <= 1 && exit >= 0 && [entry, exit].every(Number.isFinite))
    return 0;
  const lengthSquared = dx * dx + dy * dy;
  const distanceFromCorner = (corner: [number, number]) => {
    const position = lengthSquared
      ? Math.max(
          0,
          Math.min(1, ((corner[0] - start[0]) * dx + (corner[1] - start[1]) * dy) / lengthSquared),
        )
      : 0;
    return Math.hypot(start[0] + position * dx - corner[0], start[1] + position * dy - corner[1]);
  };
  return Math.min(
    distanceToBox(start, box),
    distanceToBox(end, box),
    ...([box.left, box.right] as const).flatMap((x) =>
      ([box.top, box.bottom] as const).map((y) => distanceFromCorner([x, y])),
    ),
  );
};

/** Certify a critic's polygon-versus-axis-label claim against server-owned SVG geometry. */
function nativeRadarLabelClearance(
  slide: PresentationPlan['slides'][number],
  visualId: string,
  evidence: string,
): number | undefined {
  if (!Array.isArray(slide.metadata?.contentBlocks)) return;
  const parsed = slide.metadata.contentBlocks
    .map((block) => semanticBlockSchema.safeParse(block))
    .find((result) => result.success && result.data.id === visualId);
  if (
    !parsed?.success ||
    parsed.data.kind !== 'scientific-diagram' ||
    parsed.data.spec.type !== 'radar' ||
    parsed.data.spec.axes.length !== 4
  )
    return;
  const block = parsed.data;
  const spec = block.spec;
  if (spec.type !== 'radar') return;
  const document = parseString(slide.svg);
  const group = Array.from(document.getElementsByTagName('g')).find(
    (node) => node.getAttribute('data-scientific-diagram') === visualId,
  );
  if (!group || group.getAttribute('transform') !== `translate(${block.rect.x} ${block.rect.y})`)
    return;
  // A hand-authored group cannot be used as proof. The full native group must
  // equal the deterministic renderer's output after reparsing XML attributes.
  let expected: Element;
  try {
    expected = parseString(
      `<svg xmlns="http://www.w3.org/2000/svg">${renderScientificDiagram(block)}</svg>`,
    ).getElementsByTagName('g')[0];
  } catch {
    return;
  }
  if (group.toString() !== expected.toString()) return;
  const polygons = Array.from(group.getElementsByTagName('polygon'));
  if (polygons.length !== spec.series.length + 2) return;
  const seriesPoints = polygons.slice(2).map((polygon) =>
    (polygon.getAttribute('points') ?? '')
      .trim()
      .split(/\s+/u)
      .map((pair) => pair.split(',').map(Number) as [number, number]),
  );
  if (
    seriesPoints.some(
      (points) =>
        points.length !== 4 ||
        points.some(
          (point) => point.length !== 2 || point.some((value) => !Number.isFinite(value)),
        ),
    )
  )
    return;
  const labels = Array.from(group.getElementsByTagName('text'));
  let minimum = Number.POSITIVE_INFINITY;
  for (const axis of spec.axes) {
    const matches = labels.filter((label) => label.textContent === axis);
    if (matches.length !== 1) return; // Wrapping or missing text needs visual review.
    const label = matches[0];
    const x = Number(label.getAttribute('x'));
    const y = Number(label.getAttribute('y'));
    const font = Number(label.getAttribute('font-size'));
    const anchor = label.getAttribute('text-anchor') ?? 'start';
    if (![x, y, font].every(Number.isFinite) || font < 16) return;
    const width = measureSlideText(axis, font) * 1.08;
    const left = anchor === 'end' ? x - width : anchor === 'middle' ? x - width / 2 : x;
    const box = { left, right: left + width, top: y - font, bottom: y + font * 0.25 };
    if (
      box.left < 0 ||
      box.right > block.rect.width ||
      box.top < 0 ||
      box.bottom > block.rect.height
    )
      return;
    if (evidence.includes(axis))
      minimum = Math.min(
        minimum,
        ...seriesPoints.flatMap((points) =>
          points.map((point, index) =>
            distanceFromSegmentToBox(point, points[(index + 1) % 4], box),
          ),
        ),
      );
  }
  return Number.isFinite(minimum) && minimum >= 16 ? Math.floor(minimum) : undefined;
}

/** Only measurable contradictions are dismissed; uncertain visual findings remain blocking. */
export function reconcileEvidenceBasedVisualReview(
  review: PresentationVisualReview,
  plan: PresentationPlan,
): { adjudications: VisualEvidenceAdjudication[]; review: PresentationVisualReview } {
  const formulaReview = reconcileTypedFormulaReview(review, plan);
  // Arrow directions, leader lines and their labels are drawn by the server from the signed
  // annotations, so a complaint about them inside the bitmap is not an actionable defect.
  const annotated = new Set<string>();
  for (const slide of plan.slides) {
    const parsed = visualRequirementSchema
      .array()
      .safeParse(slide.metadata?.visualRequirements ?? []);
    if (!parsed.success) continue;
    for (const visual of parsed.data)
      if (visual.annotations?.length) annotated.add(`${slide.slideId}/${visual.id}`);
  }
  const serverAnnotated = (issue: PresentationVisualReview['issues'][number]): boolean =>
    Boolean(issue.visualId) &&
    annotated.has(`${issue.slideId}/${issue.visualId}`) &&
    ['legibility', 'scientific-semantics'].includes(issue.category) &&
    /箭头|向量|方向|引线|法向|梯度|arrow|vector|direction|leader/iu.test(issue.evidence);
  const adjudications: VisualEvidenceAdjudication[] = [
    ...review.issues
      .filter((issue) => !formulaReview.issues.includes(issue) && !serverAnnotated(issue))
      .map((issue) => ({
        category: issue.category,
        reason: 'verified-formula-source' as const,
        slideId: issue.slideId,
        ...(issue.visualId ? { visualId: issue.visualId } : {}),
      })),
    ...formulaReview.issues.filter(serverAnnotated).map((issue) => ({
      category: issue.category,
      reason: 'server-drawn-annotations' as const,
      slideId: issue.slideId,
      ...(issue.visualId ? { visualId: issue.visualId } : {}),
    })),
  ];
  const issues = formulaReview.issues.filter((issue) => {
    if (serverAnnotated(issue)) return false;
    if (
      !issue.visualId ||
      !['legibility', 'spacing', 'scientific-semantics'].includes(issue.category) ||
      !/雷达|多边形|顶点|折线/u.test(issue.evidence) ||
      !/标签|文字|轴|维度/u.test(issue.evidence) ||
      !/遮挡|压盖|穿透|重叠|覆盖|cross|overlap/iu.test(issue.evidence)
    )
      return true;
    const slide = plan.slides.find((candidate) => candidate.slideId === issue.slideId);
    if (!slide) return true;
    const minimumClearancePx = nativeRadarLabelClearance(slide, issue.visualId, issue.evidence);
    if (minimumClearancePx === undefined) return true;
    adjudications.push({
      category: issue.category,
      minimumClearancePx,
      reason: 'verified-native-radar-clearance',
      slideId: issue.slideId,
      visualId: issue.visualId,
    });
    return false;
  });
  return {
    adjudications,
    review:
      issues.length === formulaReview.issues.length
        ? formulaReview
        : {
            ...formulaReview,
            issues,
            passed: issues.every((issue) => issue.severity === 'minor'),
          },
  };
}
