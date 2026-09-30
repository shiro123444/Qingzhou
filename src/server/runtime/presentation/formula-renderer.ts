import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/js/input/tex/base/BaseConfiguration.js';
import '@mathjax/src/js/util/asyncLoad/esm.js';

import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { mathjax } from '@mathjax/src/js/mathjax.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import svgpath from 'svgpath';
import { z } from 'zod';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import { escapeSvgText, type FormulaBlock, semanticBlockSchema } from './semantic-blocks';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

type Matrix = [number, number, number, number, number, number];
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

/** Bake MathJax's nested glyph transforms into paths: PPTX converters differ on nested scales. */
function absoluteFormulaPaths(body: string, initial: Matrix): string {
  const root = parseString(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`).documentElement;
  const paths: string[] = [];
  const visit = (element: Element, parent: Matrix) => {
    let matrix = parent;
    let remaining = element.getAttribute('transform') ?? '';
    for (const match of remaining.matchAll(/(translate|scale|matrix)\s*\(([^)]+)\)/gu)) {
      const v = match[2]
        .trim()
        .split(/[\s,]+/u)
        .map(Number);
      if (v.some((value) => !Number.isFinite(value))) throw new Error('Invalid math transform');
      const local: Matrix =
        match[1] === 'translate'
          ? [1, 0, 0, 1, v[0], v[1] ?? 0]
          : match[1] === 'scale'
            ? [v[0], 0, 0, v[1] ?? v[0], 0, 0]
            : (v as Matrix);
      if (local.length !== 6) throw new Error('Invalid math matrix');
      matrix = multiply(matrix, local);
    }
    remaining = remaining.replaceAll(/(translate|scale|matrix)\s*\(([^)]+)\)/gu, '').trim();
    if (remaining) throw new Error('Unsupported math transform');
    let d = element.getAttribute('d');
    if (element.tagName === 'rect') {
      const x = Number(element.getAttribute('x') || 0),
        y = Number(element.getAttribute('y') || 0);
      const w = Number(element.getAttribute('width')),
        h = Number(element.getAttribute('height'));
      d = `M${x},${y}h${w}v${h}h${-w}Z`;
    } else if (!['svg', 'g', 'path'].includes(element.tagName)) {
      throw new Error('Unsupported math glyph; move explanatory text outside the formula');
    }
    if (d) {
      const converted = svgpath(d).matrix(matrix).abs().round(4);
      if ('err' in converted && converted.err) throw new Error('Invalid math glyph path');
      paths.push(`<path d="${converted.toString()}"/>`);
    }
    for (const child of Array.from(element.childNodes))
      if (child.nodeType === 1) visit(child as Element, matrix);
  };
  visit(root, initial);
  if (!paths.length) throw new Error('Formula contains no visible glyphs');
  return paths.join('');
}

export const formulaMeasurementInputSchema = z
  .object({
    latex: z.string().trim().min(1).max(2000),
    display: z.boolean().default(true),
    fontSize: z.number().finite().min(24).max(64).default(28),
  })
  .strict();

/** A shared engine and fixed container keep planning measurements identical to final rendering. */
async function compileFormula(raw: z.input<typeof formulaMeasurementInputSchema>) {
  const block = formulaMeasurementInputSchema.parse(raw);
  // MathJax's extensible cases brace is built from disconnected glyph pieces in
  // some SVG/PPTX consumers. Render the rows with MathJax and own one continuous
  // vector brace ourselves, using the same geometry in preflight and export.
  const nativeCasesBrace = /^\s*\\begin\{cases\}[\s\S]*\\end\{cases\}\s*$/u.test(block.latex);
  const visualLatex = nativeCasesBrace
    ? block.latex
        .replace('\\begin{cases}', '\\begin{aligned}&')
        .replaceAll('\\\\', '\\\\ &')
        .replace('\\end{cases}', '\\end{aligned}')
    : block.latex;
  const braceWidth = nativeCasesBrace ? Math.max(22, block.fontSize * 0.9) : 0;
  if (
    /\\(?:require|href|url|includegraphics|html\w*|def|gdef|newcommand|renewcommand|input|write)\b/u.test(
      block.latex,
    )
  )
    throw new Error('Formula source contains unsupported commands');
  const document = mathjax.document('', {
    InputJax: new TeX({
      packages: ['base', 'ams'],
      maxBuffer: 4096,
      maxMacros: 1000,
      formatError: (_jax: unknown, error: Error) => {
        throw error;
      },
    }),
    OutputJax: new SVG({ fontCache: 'none' }),
  });
  const node = await document.convertPromise(visualLatex, {
    display: block.display,
    em: block.fontSize,
    ex: block.fontSize / 2,
    containerWidth: 960,
  });
  const svg = adaptor.tags(node, 'svg')[0];
  if (!svg) throw new Error('Math renderer did not return SVG');
  const [x, y, width, height] = adaptor.getAttribute(svg, 'viewBox').split(/\s/u).map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
    throw new Error('Invalid rendered formula geometry');
  const scale = block.fontSize / 1000;
  const body = adaptor.innerHTML(svg).replaceAll('currentColor', '#000000');
  // Run the same export compatibility validation during preflight, not just at export time.
  absoluteFormulaPaths(body, [scale, 0, 0, scale, -x * scale, -y * scale]);
  return { x, y, width, height, scale, braceWidth, body: adaptor.innerHTML(svg) };
}

export async function measureFormula(raw: z.input<typeof formulaMeasurementInputSchema>) {
  const input = formulaMeasurementInputSchema.parse(raw);
  const compiled = await compileFormula(input);
  return {
    fontSize: input.fontSize,
    width: Math.ceil(compiled.width * compiled.scale + compiled.braceWidth),
    height: Math.ceil(compiled.height * compiled.scale),
    minRectWidth: Math.ceil(compiled.width * compiled.scale + compiled.braceWidth) + 8,
    minRectHeight: Math.ceil(compiled.height * compiled.scale) + 8,
  };
}

/** Change only line layout, never algebra. Split at top-level additive terms. */
export async function fitFormula(
  raw: z.input<typeof formulaMeasurementInputSchema>,
  bounds: { width: number; height: number },
) {
  const input = formulaMeasurementInputSchema.parse(raw);
  const initial = await measureFormula(input);
  const fits = (m: typeof initial) =>
    m.minRectWidth <= bounds.width && m.minRectHeight <= bounds.height;
  if (fits(initial)) return { latex: input.latex, measurement: initial };
  // Existing environments and paired delimiters require explicit model repair.
  if (!/\\(?:begin|left|right)\b/u.test(input.latex)) {
    let depth = 0;
    const breaks: number[] = [];
    for (let i = 0; i < input.latex.length; i++) {
      const char = input.latex[i];
      if (char === '\\') {
        i++;
        continue;
      }
      if ('{(['.includes(char)) depth++;
      if ('})]'.includes(char)) depth--;
      if (depth === 0 && i > 0 && (char === '+' || char === '-')) breaks.push(i);
    }
    // Try balanced two-line variants, then one additive term per line.
    const candidates = [
      ...breaks
        .sort((a, b) => Math.abs(a - input.latex.length / 2) - Math.abs(b - input.latex.length / 2))
        .map((at) => [input.latex.slice(0, at), input.latex.slice(at)]),
      [...breaks]
        .sort((a, b) => a - b)
        .reduce<string[]>((parts, at, i, all) => {
          if (!i) parts.push(input.latex.slice(0, at));
          parts.push(input.latex.slice(at, all[i + 1]));
          return parts;
        }, []),
    ];
    for (const lines of candidates.filter((lines) => lines.length > 1)) {
      const latex = `\\begin{aligned}${lines.map((line) => `&${line.trim()}`).join(' \\\\ ')}\\end{aligned}`;
      const measurement = await measureFormula({ ...input, latex });
      if (fits(measurement)) return { latex, measurement };
    }
  }
  throw new Error(
    `Formula needs ${initial.minRectWidth}×${initial.minRectHeight}, but this stage has only ${bounds.width}×${bounds.height}. Use equivalent aligned line breaks within this budget; keep the approved mathematical content and font size. Do not move a teaching derivation to notes or remove the teacher's board space.`,
  );
}

/** Isolated TeX state per conversion: no caller-defined macros, URLs, HTML or extensions. */
export async function renderFormula(raw: FormulaBlock): Promise<string> {
  const block = semanticBlockSchema.parse(raw);
  if (block.kind !== 'formula') throw new Error('Expected a formula block');
  const {
    x,
    y,
    width,
    height,
    scale,
    braceWidth,
    body: rawBody,
  } = await compileFormula({
    latex: block.latex,
    display: block.display,
    fontSize: block.fontSize,
  });
  if (width * scale + braceWidth > block.rect.width + 1 || height * scale > block.rect.height + 1)
    throw new Error(
      `Formula ${block.id} needs ${Math.ceil(width * scale + braceWidth)}×${Math.ceil(height * scale)} at ${block.fontSize}px; enlarge the region or split the formula, never shrink it`,
    );
  const body = rawBody.replaceAll('currentColor', block.color);
  if (/<(?:style|use|foreignObject|image)\b/u.test(body))
    throw new Error('Formula must be self-contained vector paths');
  const left = block.rect.x + (block.rect.width - width * scale - braceWidth) / 2;
  const tx = left + braceWidth - x * scale;
  const ty = block.rect.y + (block.rect.height - height * scale) / 2 - y * scale;
  const paths = absoluteFormulaPaths(body, [scale, 0, 0, scale, tx, ty]);
  const top = block.rect.y + (block.rect.height - height * scale) / 2;
  const bottom = top + height * scale;
  const middle = (top + bottom) / 2;
  const right = left + braceWidth - 4;
  const stem = left + braceWidth * 0.38;
  const brace = braceWidth
    ? `<path d="M ${right} ${top + 2} Q ${stem} ${top + 2} ${stem} ${top + height * scale * 0.2} L ${stem} ${middle - 10} Q ${stem} ${middle - 3} ${left + 2} ${middle} Q ${stem} ${middle + 3} ${stem} ${middle + 10} L ${stem} ${bottom - height * scale * 0.2} Q ${stem} ${bottom - 2} ${right} ${bottom - 2}" fill="none" stroke="${block.color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`
    : '';
  return `<g data-content-id="${block.id}" data-formula-latex="${escapeSvgText(block.latex)}" aria-label="${escapeSvgText(block.latex)}" fill="${block.color}">${brace}${paths}</g>`;
}
