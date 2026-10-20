import { execFileSync } from 'node:child_process';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import { measureSlideText } from './text-measurement';

/** Version the deterministic repair/measurement alongside the renderer snapshot. */
export const TRIAL_TEXT_LAYOUT_VERSION = 'text-bounds-v1';
const fail = (code: string) => Object.assign(new Error(code), { code });
const inherited = (element: Element, name: string): string | undefined => {
  for (
    let node: Element | null = element;
    node;
    node = node.parentNode?.nodeType === 1 ? (node.parentNode as Element) : null
  ) {
    const style = node
      .getAttribute('style')
      ?.split(';')
      .map((part) => part.split(':').map((value) => value.trim()))
      .findLast(([key]) => key === name);
    if (style) return style[1];
    if (node.hasAttribute(name)) return node.getAttribute(name)!;
  }
};
const scalar = (value: string | undefined | null, fallback: number): number => {
  if (!value) return fallback;
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:px|pt)?$/u.test(value))
    throw fail('TRIAL_TEXT_LAYOUT_UNSUPPORTED');
  return Number.parseFloat(value) * (value.endsWith('pt') ? 4 / 3 : 1);
};
type Box = { left: number; right: number; top: number; bottom: number };
type Run = Box & {
  text: string;
  x: number;
  y: number;
  size: number;
  family: string;
  weight: string;
  spacing: number;
  anchor: string;
};
const resolvedFamilies = new Map<string, string>();
function resolvedFamily(family: string): string {
  if (family.length > 300) throw fail('TRIAL_TEXT_LAYOUT_UNSUPPORTED');
  const cached = resolvedFamilies.get(family);
  if (cached) return cached;
  try {
    // Match librsvg/fontconfig's substitution. Skia otherwise measures missing
    // CJK glyphs as tofu even when librsvg will paint a wider fallback font.
    const matched = execFileSync('fc-match', ['-f', '%{family}\n', family], {
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 4096,
    })
      .trim()
      .split(',')[0];
    if (!matched) throw fail('TRIAL_TEXT_METRICS_UNAVAILABLE');
    const quoted = JSON.stringify(matched);
    if (resolvedFamilies.size >= 128) resolvedFamilies.clear();
    resolvedFamilies.set(family, quoted);
    return quoted;
  } catch {
    throw fail('TRIAL_TEXT_METRICS_UNAVAILABLE');
  }
}
const widthOf = (text: string, size: number, family: string, weight: string, spacing: number) =>
  Math.max(
    0,
    measureSlideText(text, size, resolvedFamily(family), weight) +
      Math.max(0, [...text].length - 1) * spacing,
  );
function runsOf(element: Element): Run[] {
  if (
    [
      'transform',
      'textLength',
      'writing-mode',
      'rotate',
      'clip-path',
      'mask',
      'baseline-shift',
      'direction',
    ].some((key) => inherited(element, key))
  )
    throw fail('TRIAL_TEXT_LAYOUT_UNSUPPORTED');
  const children = Array.from(element.childNodes);
  if (children.some((node) => node.nodeType === 1 && (node as Element).localName !== 'tspan'))
    throw fail('TRIAL_TEXT_LAYOUT_UNSUPPORTED');
  const nodes = children.length ? children : [element];
  let x = scalar(element.getAttribute('x'), 0),
    y = scalar(element.getAttribute('y'), 0);
  x += scalar(element.getAttribute('dx'), 0);
  y += scalar(element.getAttribute('dy'), 0);
  const result: Run[] = [];
  for (const node of nodes) {
    if (node.nodeType !== 1 && node.nodeType !== 3) continue;
    const span = node.nodeType === 1 ? (node as Element) : element;
    if (span !== element) {
      if (
        Array.from(span.childNodes).some((child) => child.nodeType === 1) ||
        [
          'transform',
          'textLength',
          'rotate',
          'writing-mode',
          'clip-path',
          'mask',
          'baseline-shift',
          'direction',
        ].some((key) => span.hasAttribute(key))
      )
        throw fail('TRIAL_TEXT_LAYOUT_UNSUPPORTED');
      x = scalar(span.getAttribute('x'), x) + scalar(span.getAttribute('dx'), 0);
      y = scalar(span.getAttribute('y'), y) + scalar(span.getAttribute('dy'), 0);
    }
    const text = node === element ? (element.textContent ?? '') : (node.textContent ?? '');
    if (!text.trim()) continue;
    const size = scalar(inherited(span, 'font-size'), 16);
    if (size <= 0 || size > 4096) throw fail('TRIAL_TEXT_LAYOUT_UNSUPPORTED');
    const family = inherited(span, 'font-family') ?? 'Arial, Microsoft YaHei';
    const weight = inherited(span, 'font-weight') ?? 'normal';
    const spacingValue = inherited(span, 'letter-spacing');
    const spacing = spacingValue === 'normal' ? 0 : scalar(spacingValue, 0);
    const anchor = inherited(span, 'text-anchor') ?? 'start';
    if (!['start', 'middle', 'end'].includes(anchor)) throw fail('TRIAL_TEXT_LAYOUT_UNSUPPORTED');
    const advance = widthOf(text, size, family, weight, spacing);
    const left = x - (anchor === 'end' ? advance : anchor === 'middle' ? advance / 2 : 0);
    result.push({
      text,
      x,
      y,
      size,
      family,
      weight,
      spacing,
      anchor,
      left,
      right: left + advance,
      top: y - size,
      bottom: y + size * 0.25,
    });
    x += advance;
  }
  return result;
}
function readPage(svg: string) {
  const document = parseString(svg),
    root = document.documentElement;
  const raw = root.getAttribute('viewBox');
  const values = raw
    ? raw
        .trim()
        .split(/[\s,]+/u)
        .map(Number)
    : [0, 0, scalar(root.getAttribute('width'), NaN), scalar(root.getAttribute('height'), NaN)];
  if (
    root.localName !== 'svg' ||
    values.length !== 4 ||
    !values.every(Number.isFinite) ||
    values[2] <= 0 ||
    values[3] <= 0
  )
    throw fail('TRIAL_INVALID_SVG');
  const [x, y, width, height] = values;
  if (document.getElementsByTagName('style').length) throw fail('TRIAL_TEXT_LAYOUT_UNSUPPORTED');
  if (
    root.hasAttribute('width') &&
    root.hasAttribute('height') &&
    Math.abs(
      scalar(root.getAttribute('width'), NaN) / scalar(root.getAttribute('height'), NaN) -
        width / height,
    ) > 0.001
  )
    throw fail('TRIAL_CANVAS_MISMATCH');
  const canvas: Box = { left: x, top: y, right: x + width, bottom: y + height };
  const texts = Array.from(document.getElementsByTagName('text'));
  const spans = Array.from(document.getElementsByTagName('tspan'));
  if (
    spans.length > 512 ||
    new Set(
      [...texts, ...spans].map(
        (text) => inherited(text, 'font-family') ?? 'Arial, Microsoft YaHei',
      ),
    ).size > 8
  )
    throw fail('TRIAL_TEXT_LAYOUT_LIMIT');
  if (
    texts.length > 128 ||
    texts.reduce((sum, text) => sum + (text.textContent?.length ?? 0), 0) > 20000
  )
    throw fail('TRIAL_TEXT_LAYOUT_LIMIT');
  const panels = Array.from(document.getElementsByTagName('rect')).flatMap((rect) => {
    if (inherited(rect, 'transform')) return [];
    const left = scalar(rect.getAttribute('x'), 0),
      top = scalar(rect.getAttribute('y'), 0);
    const w = scalar(rect.getAttribute('width'), NaN),
      h = scalar(rect.getAttribute('height'), NaN);
    return w >= 80 && h >= 40 && (w < width - 20 || h < height - 20)
      ? [{ left, top, right: left + w, bottom: top + h }]
      : [];
  });
  const region = (run: Run) =>
    panels
      .filter(
        (panel) =>
          run.x >= panel.left &&
          run.x <= panel.right &&
          run.y >= panel.top + run.size * 0.6 &&
          run.y <= panel.bottom,
      )
      .sort(
        (a, b) => (a.right - a.left) * (a.bottom - a.top) - (b.right - b.left) * (b.bottom - b.top),
      )[0];
  return { document, texts, canvas, panels, region, width, height };
}
const inside = (run: Box, box: Box, tolerance = 0.5) =>
  run.left >= box.left - tolerance &&
  run.right <= box.right + tolerance &&
  run.top >= box.top - tolerance &&
  run.bottom <= box.bottom + tolerance;

/** Conservative subset: unsupported text geometry is unknown, never silently certified. */
export function inspectTrialTextBounds(svg: string): {
  status: 'passed' | 'failed' | 'unknown';
  evidence: string;
} {
  try {
    const page = readPage(svg);
    const boxes: { node: Element; run: Run }[] = [];
    for (const node of page.texts)
      for (const run of runsOf(node)) {
        if (!run.text.trim()) continue;
        const panel = page.region(run);
        const boundary = panel
          ? {
              left: Math.max(page.canvas.left, panel.left + 8),
              right: Math.min(page.canvas.right, panel.right - 8),
              top: Math.max(page.canvas.top, panel.top),
              bottom: Math.min(page.canvas.bottom, panel.bottom - 4),
            }
          : page.canvas;
        if (!inside(run, boundary))
          return {
            status: 'failed',
            evidence: `原生文字越出页面或容器边界：${run.text.slice(0, 60)}`,
          };
        boxes.push({ node, run });
      }
    for (let i = 0; i < boxes.length; i++)
      for (const other of boxes.slice(i + 1)) {
        const a = boxes[i].run,
          b = other.run;
        if (
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2
        )
          return {
            status: 'failed',
            evidence: `独立文字块相互重叠：${a.text.slice(0, 35)} / ${b.text.slice(0, 35)}`,
          };
      }
    return {
      status: 'passed',
      evidence: '逐行测量原生文字，页面/容器边界与独立文字块间距通过；未核验路径图形语义',
    };
  } catch (error) {
    return {
      status: 'unknown',
      evidence: `文字几何无法完整核验：${(error as { code?: string }).code ?? 'TRIAL_INVALID_SVG'}`,
    };
  }
}
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
function wrap(text: string, limit: number, run: Run, size: number, signal: AbortSignal): string[] {
  const rows: string[] = [];
  let row = '';
  for (const { segment } of segmenter.segment(text)) {
    if (signal.aborted) throw fail('TRIAL_CANCELLED');
    if (widthOf(segment, size, run.family, run.weight, run.spacing) > limit)
      throw fail('TRIAL_TEXT_NO_FIT');
    if (row && widthOf(row + segment, size, run.family, run.weight, run.spacing) > limit) {
      rows.push(row);
      row = '';
    }
    row += segment;
    if (rows.length > 64) throw fail('TRIAL_TEXT_LAYOUT_LIMIT');
  }
  if (row) rows.push(row);
  return rows;
}

function readableSize(run: Run, content: string, width: number, top: number, height: number) {
  if (run.y >= top + height * 0.82) return run.size;
  if (content.length >= 16 && /^(?:bold|[6-9]00)$/u.test(run.weight))
    return Math.max(run.size, (width / 960) * 18);
  return content.length >= 32 && ['normal', '400'].includes(run.weight)
    ? Math.max(run.size, (width / 960) * 16)
    : run.size;
}

/** Candidate-only, lossless line reflow. Never shrink, clip, truncate or move unrelated elements. */
export function fitTrialPageText(svg: string, signal: AbortSignal): string {
  if (signal.aborted) throw fail('TRIAL_CANCELLED');
  const page = readPage(svg);
  let changed = false;
  for (const node of page.texts) {
    if (signal.aborted) throw fail('TRIAL_CANCELLED');
    const runs = runsOf(node);
    if (!runs.length) continue;
    const first = runs[0],
      panel = page.region(first);
    const right = panel ? Math.min(panel.right - 8, page.canvas.right - 8) : page.canvas.right - 8;
    const left = panel ? Math.max(panel.left + 8, page.canvas.left) : page.canvas.left;
    const content = node.textContent ?? '';
    const sameStyle = runs.every(
      (run) =>
        run.anchor === 'start' &&
        run.x === first.x &&
        run.size === first.size &&
        run.family === first.family &&
        run.weight === first.weight &&
        run.spacing === first.spacing,
    );
    // Mixed emphasis, inline runs, transformed/scientific text retain their authored structure.
    const desiredSize = readableSize(first, content, page.width, page.canvas.top, page.height);
    const overflow = runs.some(
      (run) => run.left < left || run.right > right || run.bottom > page.canvas.bottom,
    );
    if (!overflow && desiredSize === first.size) continue;
    if (!sameStyle && !overflow) continue;
    if (!sameStyle || first.x < left || right - first.x < first.size)
      throw fail('TRIAL_TEXT_NO_FIT');
    let bottom = panel
      ? Math.min(panel.bottom - 8, page.canvas.bottom - 4)
      : page.canvas.bottom - 4;
    for (const other of page.texts)
      if (other !== node)
        for (const run of runsOf(other)) {
          if (run.y > first.y && run.left < right && run.right > first.x)
            bottom = Math.min(
              bottom,
              run.y -
                readableSize(
                  run,
                  other.textContent ?? '',
                  page.width,
                  page.canvas.top,
                  page.height,
                ) -
                4,
            );
        }
    const bullet = /^\s*(?:[·•●▪◆]|[-–]\s|\d+[.)、])/u;
    const paragraphs =
      runs.length > 1 && runs.every((run) => bullet.test(run.text))
        ? runs.map(({ text }) => text)
        : [content];
    let fitted: { size: number; rows: string[]; baselines: number[] } | undefined;
    for (const size of new Set([desiredSize, first.size])) {
      const rows: string[] = [],
        baselines: number[] = [];
      let baseline = first.y;
      try {
        for (const [index, paragraph] of paragraphs.entries()) {
          const wrapped = wrap(paragraph, right - first.x, first, size, signal);
          for (const [lineIndex, line] of wrapped.entries()) {
            rows.push(line);
            baselines.push(baseline + lineIndex * size * 1.25);
          }
          if (index + 1 < paragraphs.length)
            baseline = Math.max(runs[index + 1].y, baselines.at(-1)! + size * 1.5);
        }
      } catch (error) {
        if ((error as { code?: string }).code === 'TRIAL_TEXT_NO_FIT') continue;
        throw error;
      }
      if (
        first.y - size < Math.max(page.canvas.top, panel?.top ?? page.canvas.top) ||
        baselines.at(-1)! + size * 0.25 > bottom
      )
        continue;
      fitted = { size, rows, baselines };
      break;
    }
    if (!fitted || fitted.rows.join('') !== content) throw fail('TRIAL_TEXT_NO_FIT');
    node.removeAttribute('dx');
    node.removeAttribute('dy');
    node.textContent = '';
    node.setAttribute('font-size', String(fitted.size));
    // Inline font-size overrides presentation attributes; update the same declaration too.
    if (node.hasAttribute('style'))
      node.setAttribute(
        'style',
        node.getAttribute('style')!.replaceAll(/(?:^|;)\s*font-size\s*:[^;]*/gu, '') +
          `;font-size:${fitted.size}px`,
      );
    for (const [index, text] of fitted.rows.entries()) {
      const span = page.document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      span.setAttribute('x', String(first.x));
      span.setAttribute('y', String(fitted.baselines[index]));
      span.textContent = text;
      node.appendChild(span);
    }
    changed = true;
  }
  const result = changed ? page.document.toString() : svg;
  const check = inspectTrialTextBounds(result);
  if (check.status !== 'passed')
    throw fail(check.status === 'unknown' ? 'TRIAL_TEXT_LAYOUT_UNSUPPORTED' : 'TRIAL_TEXT_NO_FIT');
  return result;
}

/** The candidate cannot obtain more space by changing the frozen page canvas. */
export function assertTrialCanvas(source: string, candidate: string) {
  if (JSON.stringify(readPage(source).canvas) !== JSON.stringify(readPage(candidate).canvas))
    throw fail('TRIAL_CANVAS_MISMATCH');
}
