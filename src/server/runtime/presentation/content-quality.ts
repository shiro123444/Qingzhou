import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import { PRESENTATION_CONTENT_BUDGET } from './content-intent';
import { assertLessonPublishable } from './lesson';
import { measureSlideText } from './text-measurement';
import { inspectVisualOccupancy } from './visual-ownership';

export interface ContentQualityIssue {
  category: 'density' | 'formula' | 'geometry' | 'legibility';
  evidence: string;
  instruction: string;
  severity: 'major';
  slideId: string;
}

const inherited = (element: Element, name: string): string | null => {
  for (
    let node: Element | null = element;
    node;
    node = node.parentNode?.nodeType === 1 ? (node.parentNode as Element) : null
  ) {
    const direct = node.getAttribute(name);
    if (direct) return direct;
    const style = node
      .getAttribute('style')
      ?.split(';')
      .find((value) => value.trim().startsWith(`${name}:`));
    if (style) return style.slice(style.indexOf(':') + 1).trim();
  }
  return null;
};

const scaleOf = (element: Element): number => {
  let scale = 1;
  for (
    let node: Element | null = element;
    node;
    node = node.parentNode?.nodeType === 1 ? (node.parentNode as Element) : null
  ) {
    for (const match of (node.getAttribute('transform') ?? '').matchAll(
      /(scale|matrix)\s*\(([^)]+)\)/gu,
    )) {
      const values = match[2]
        .trim()
        .split(/[\s,]+/u)
        .map(Number);
      if (match[1] === 'scale')
        scale *= Math.min(Math.abs(values[0]), Math.abs(values[1] ?? values[0]));
      else {
        const [a, b, c, d] = values;
        const sum = a * a + b * b + c * c + d * d;
        scale *= Math.sqrt(
          Math.max(0, (sum - Math.sqrt(Math.max(0, sum * sum - 4 * (a * d - b * c) ** 2))) / 2),
        );
      }
    }
  }
  return scale;
};

/** Promote undersized plain captions only when the larger text still fits. */
export const promoteReadablePlainText = (svg: string): string => {
  const document = parseString(svg);
  const root = document.documentElement;
  const viewBox = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/u).map(Number);
  if (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) return svg;
  const [originX, originY, width, height] = viewBox;
  const minimum = (PRESENTATION_CONTENT_BUDGET.minBodyFontSize * width) / 960;
  const panels = Array.from(document.getElementsByTagName('rect'))
    .map((rect) => ({
      x: Number(rect.getAttribute('x')),
      y: Number(rect.getAttribute('y')),
      width: Number(rect.getAttribute('width')),
      height: Number(rect.getAttribute('height')),
      transformed: !!inherited(rect, 'transform'),
    }))
    .filter(
      (panel) =>
        !panel.transformed &&
        panel.width >= 100 &&
        panel.height >= 60 &&
        panel.width < width - 20 &&
        panel.height < height - 20,
    );
  let changed = false;
  for (const node of Array.from(document.getElementsByTagName('text'))) {
    const content = node.textContent ?? '';
    if (
      content.length <= 16 ||
      Array.from(node.childNodes).some((child) => child.nodeType === 1) ||
      inherited(node, 'data-formula-latex') ||
      inherited(node, 'data-scientific-diagram') ||
      inherited(node, 'transform')
    )
      continue;
    const x = Number.parseFloat(node.getAttribute('x') ?? 'NaN');
    const y = Number.parseFloat(node.getAttribute('y') ?? 'NaN');
    const rawSize = inherited(node, 'font-size') ?? '16';
    const size = Number.parseFloat(rawSize) * (rawSize.endsWith('pt') ? 4 / 3 : 1);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(size) ||
      size >= minimum ||
      y > originY + height * 0.88
    )
      continue;
    const advance = measureSlideText(
      content,
      minimum,
      inherited(node, 'font-family') ?? undefined,
      inherited(node, 'font-weight') ?? undefined,
    );
    const anchor = inherited(node, 'text-anchor') ?? 'start';
    const left = x - (anchor === 'end' ? advance : anchor === 'middle' ? advance / 2 : 0);
    const panel = panels
      .filter(
        (candidate) =>
          x >= candidate.x &&
          x <= candidate.x + candidate.width &&
          y >= candidate.y + minimum * 0.6 &&
          y <= candidate.y + candidate.height,
      )
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];
    const right = panel ? panel.x + panel.width - 8 : originX + width - 0.5;
    const safeLeft = panel ? panel.x + 8 : originX + 0.5;
    if (left < safeLeft || left + advance > right) continue;
    node.setAttribute('font-size', String(minimum));
    changed = true;
  }
  return changed ? document.toString() : svg;
};

/** All-page deterministic checks; model critics cannot waive these constraints. */
export const inspectPresentationContent = (
  plan: PresentationPlan,
): { passed: boolean; issues: ContentQualityIssue[] } => {
  const issues: ContentQualityIssue[] = [];
  for (const slide of plan.slides) {
    const document = parseString(slide.svg);
    const root = document.documentElement;
    const viewBox =
      root
        .getAttribute('viewBox')
        ?.trim()
        .split(/[\s,]+/u)
        .map(Number) ?? [];
    const width = viewBox[2];
    const height = viewBox[3];
    if (
      viewBox.length !== 4 ||
      viewBox.some((value) => !Number.isFinite(value)) ||
      width <= 0 ||
      height <= 0
    ) {
      issues.push({
        slideId: slide.slideId,
        severity: 'major',
        category: 'geometry',
        evidence: 'Missing finite slide dimensions',
        instruction: 'Return a finite positive viewBox matching the requested canvas',
      });
      continue;
    }
    const add = (
      category: ContentQualityIssue['category'],
      evidence: string,
      instruction: string,
    ) => {
      if (!issues.some((issue) => issue.slideId === slide.slideId && issue.category === category))
        issues.push({ category, evidence, instruction, severity: 'major', slideId: slide.slideId });
    };
    const texts = Array.from(document.getElementsByTagName('text'));
    for (const conflict of inspectVisualOccupancy(slide))
      add(
        'geometry',
        conflict,
        'Allocate separate regions for images, native content and text; replace retired representations instead of overlaying them',
      );
    const panels = Array.from(document.getElementsByTagName('rect'))
      .map((rect) => ({
        x: Number(rect.getAttribute('x')),
        y: Number(rect.getAttribute('y')),
        width: Number(rect.getAttribute('width')),
        height: Number(rect.getAttribute('height')),
        transformed: !!inherited(rect, 'transform'),
      }))
      .filter(
        (rect) =>
          !rect.transformed &&
          rect.width >= 100 &&
          rect.height >= 60 &&
          rect.width < width - 20 &&
          rect.height < height - 20,
      );
    const characters = texts.reduce(
      (sum, text) => sum + (text.textContent ?? '').replaceAll(/\s/gu, '').length,
      0,
    );
    if (characters > PRESENTATION_CONTENT_BUDGET.maxBodyCharacters)
      add(
        'density',
        `${characters} visible characters exceed ${PRESENTATION_CONTENT_BUDGET.maxBodyCharacters}`,
        'Keep one teaching action on the page; split dense explanations into stages, preserve approved derivations, and never shrink text',
      );
    for (const text of texts) {
      if (inherited(text, 'data-formula-latex')) continue;
      const content = text.textContent ?? '';
      if (/\\(?:frac|sum|int|nabla|alpha|theta|begin)\b|[_^]\s*[({]|\$\$|\\\(|\\\[/u.test(content))
        add(
          'formula',
          `Unrendered mathematical notation: ${content.slice(0, 100)}`,
          'Move the expression into a formula content block with LaTeX; remove the plain-text duplicate',
        );
      const runs = [text, ...Array.from(text.getElementsByTagName('tspan'))];
      // Server-drawn annotation labels are clamped inside their own artwork box by the projector and
      // are deliberately brief labels, so flow-based panel rules do not describe them.
      const annotationLabel = !!inherited(text, 'data-asset-annotations');
      // Measure real glyph advances; quarter-em guesses missed mixed math/CJK clipping.
      // Explicitly positioned multiline tspans need a full SVG layout engine and are skipped here.
      const simpleLine =
        !inherited(text, 'transform') &&
        runs
          .slice(1)
          .every(
            (run) =>
              !['x', 'y', 'dx', 'dy', 'transform', 'textLength'].some((attribute) =>
                run.hasAttribute(attribute),
              ),
          );
      if (simpleLine && !text.hasAttribute('textLength')) {
        const sizes = runs.map((run) => {
          const raw = inherited(run, 'font-size') ?? '16';
          return Number.parseFloat(raw) * (raw.endsWith('pt') ? 4 / 3 : 1);
        });
        const font = Math.min(...sizes);
        const advance = measureSlideText(
          content,
          font,
          inherited(text, 'font-family') ?? undefined,
          inherited(text, 'font-weight') ?? undefined,
        );
        const x = Number.parseFloat(text.getAttribute('x') ?? '0');
        const anchor = inherited(text, 'text-anchor') ?? 'start';
        const left = x - (anchor === 'end' ? advance : anchor === 'middle' ? advance / 2 : 0);
        if (
          Number.isFinite(left) &&
          (left < viewBox[0] - 0.5 || left + advance > viewBox[0] + width + 0.5)
        )
          add(
            'geometry',
            `Text “${content.slice(0, 50)}” extends beyond the slide even with conservative glyph widths`,
            'Wrap or shorten this line within the canvas; move explanation to notes, never shrink the font',
          );
        const baseline = Number.parseFloat(text.getAttribute('y') ?? 'NaN');
        const panel = panels
          .filter(
            (rect) =>
              left >= rect.x - 1 &&
              left <= rect.x + rect.width &&
              baseline >= rect.y + font * 0.6 &&
              baseline <= rect.y + rect.height,
          )
          .sort((a, b) => a.width * a.height - b.width * b.height)[0];
        if (!annotationLabel && panel && left + advance > panel.x + panel.width - 8)
          add(
            'geometry',
            `Text “${content.slice(0, 50)}” extends ${Math.ceil(left + advance - (panel.x + panel.width))}px beyond its panel`,
            'Wrap or recompose this panel within its border without shrinking text or hiding content',
          );
      }
      if (!simpleLine && runs.length > 1) {
        let baseline = Number.parseFloat(text.getAttribute('y') ?? 'NaN');
        for (const run of runs.slice(1)) {
          if (run.getElementsByTagName('tspan').length || run.hasAttribute('textLength')) continue;
          const line = run.textContent?.trim() ?? '';
          if (!line) continue;
          if (run.hasAttribute('y')) baseline = Number.parseFloat(run.getAttribute('y')!);
          else if (run.hasAttribute('dy')) baseline += Number.parseFloat(run.getAttribute('dy')!);
          const raw = inherited(run, 'font-size') ?? '16';
          const font = Number.parseFloat(raw) * (raw.endsWith('pt') ? 4 / 3 : 1);
          const x =
            Number.parseFloat(run.getAttribute('x') ?? text.getAttribute('x') ?? 'NaN') +
            Number.parseFloat(run.getAttribute('dx') ?? '0');
          const advance = measureSlideText(
            line,
            font,
            inherited(run, 'font-family') ?? undefined,
            inherited(run, 'font-weight') ?? undefined,
          );
          const anchor = inherited(run, 'text-anchor') ?? 'start';
          const left = x - (anchor === 'end' ? advance : anchor === 'middle' ? advance / 2 : 0);
          if (!Number.isFinite(left) || !Number.isFinite(baseline)) continue;
          if (left < viewBox[0] - 0.5 || left + advance > viewBox[0] + width + 0.5)
            add(
              'geometry',
              `Text run “${line.slice(0, 50)}” extends beyond the slide`,
              'Reflow the complete line within the canvas; do not hide or shrink it',
            );
          const panel = panels
            .filter(
              (candidate) =>
                left >= candidate.x - 1 &&
                left <= candidate.x + candidate.width &&
                baseline >= candidate.y + font * 0.6 &&
                baseline <= candidate.y + candidate.height,
            )
            .sort((a, b) => a.width * a.height - b.width * b.height)[0];
          if (
            !inherited(run, 'data-asset-annotations') &&
            panel &&
            left + advance > panel.x + panel.width - 8
          )
            add(
              'geometry',
              `Text run “${line.slice(0, 50)}” extends ${Math.ceil(left + advance - (panel.x + panel.width))}px beyond its panel`,
              'Reflow this line inside its panel without splitting scientific names',
            );
        }
      }
      for (const run of runs) {
        if (!(run.textContent ?? '').trim()) continue;
        const rawSize = inherited(run, 'font-size') ?? '16';
        const size =
          (Number.parseFloat(rawSize) * (rawSize.endsWith('pt') ? 4 / 3 : 1) * scaleOf(run) * 960) /
          width;
        const y = Number.parseFloat(inherited(run, 'y') ?? '0');
        const isDiagram = !!inherited(run, 'data-scientific-diagram');
        const isFooter = y > viewBox[1] + height * 0.88 && content.length <= 100;
        // Server-drawn annotation labels are brief labels by construction: `renderAssetAnnotations`
        // paints them at the label size inside the artwork box, so body-text minimums do not apply.
        // The label minimum still applies, so hiding small text in an annotation group gains nothing.
        const isAnnotationLabel = !!inherited(run, 'data-asset-annotations');
        const isShortLabel = content.length <= 16;
        const minimum =
          isDiagram || isFooter || isShortLabel || isAnnotationLabel
            ? PRESENTATION_CONTENT_BUDGET.minLabelFontSize
            : PRESENTATION_CONTENT_BUDGET.minBodyFontSize;
        if (!Number.isFinite(size) || size < minimum - 0.1)
          add(
            'legibility',
            `Text “${content.slice(0, 50)}” is ${size.toFixed(1)}px; minimum ${minimum}px at 960 width`,
            'Use ≥24px body text and ≥16px brief labels/captions; simplify content or move detail to notes',
          );
      }
    }
  }
  return { issues, passed: issues.length === 0 };
};

export const assertPresentationPublishable = (plan: PresentationPlan): void => {
  assertLessonPublishable(plan);
  const review = plan.designSpec?.templateVisualReview as
    | { final?: { passed?: boolean; issues?: { severity: string }[] }; finalReviewError?: string }
    | undefined;
  if (review?.finalReviewError)
    throw Object.assign(new Error('视觉复核暂时不可用，草稿已保存；请恢复复核后再发布。'), {
      code: 'PRESENTATION_REVIEW_UNAVAILABLE',
      details: review,
    });
  if (
    review &&
    (!review.final?.passed || review.final.issues?.some((issue) => issue.severity !== 'minor'))
  )
    throw Object.assign(new Error('视觉复核未通过，已保留草稿；修复严重问题后才能发布。'), {
      code: 'PRESENTATION_QUALITY_FAILED',
      details: review,
    });
  if (plan.designSpec?.contentPolicyVersion === 1) {
    const report = inspectPresentationContent(plan);
    if (!report.passed)
      throw Object.assign(new Error('内容质量检查未通过：请修正公式、字号或内容密度后重试。'), {
        code: 'PRESENTATION_QUALITY_FAILED',
        details: report,
      });
  }
};
