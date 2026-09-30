import { isNativeVisual, type SlideContentIntent, visualRequirements } from './content-intent';
import { contentLayout } from './content-layout';
import { fitFormula } from './formula-renderer';
import { layoutScientificGraph } from './scientific-graph-layout';
import {
  escapeSvgText,
  minimumScientificDiagramSize,
  renderSemanticBlocks,
  type SemanticBlock,
  semanticBlockSchema,
} from './semantic-blocks';
import { measureSlideText } from './text-measurement';

/** A restrained layout for valid sources when a model gives measured formulas undersized boxes. */
export async function recoverSemanticSlideLayout(input: {
  aspectRatio: string;
  boardSpace?: string;
  intent: SlideContentIntent;
  rawBlocks: unknown;
  title: string;
  /** Already-owned image references; recovery may arrange them but never invent them. */
  imageRefs?: string[];
  visibleContent?: string[];
}) {
  const blocks = Array.isArray(input.rawBlocks)
    ? input.rawBlocks
        .map((block) => semanticBlockSchema.safeParse(block))
        .flatMap((result) => (result.success ? [result.data] : []))
    : [];
  const diagramIds = visualRequirements(input.intent)
    .filter((visual) => visual.required && isNativeVisual(visual))
    .map((visual) => visual.id);
  if (diagramIds.length > 1)
    throw new Error('This stage needs separate pages for multiple diagrams');
  let diagram = blocks.find(
    (block) => block.kind === 'scientific-diagram' && diagramIds.includes(block.id),
  );
  const required = visualRequirements(input.intent).find((visual) => visual.id === diagramIds[0]);
  if (
    required?.fidelity === 'computed' &&
    (!diagram ||
      (diagram.kind === 'scientific-diagram' &&
        !['quadratic', 'taylor'].includes(diagram.spec.type) &&
        diagram.provenance.kind !== 'source'))
  ) {
    const subject = `${input.title} ${required.brief}`;
    const spec =
      /凸|convex/iu.test(subject) && /切线|泰勒|tangent/iu.test(subject)
        ? {
            type: 'taylor' as const,
            coefficients: [0, 0, 0.5],
            at: 1,
            xRange: [-2, 3] as [number, number],
          }
        : /病态|峡谷|动量|Nesterov|NAG|梯度下降/iu.test(subject) &&
            /等高线|轨迹|迭代/u.test(subject)
          ? {
              type: 'quadratic' as const,
              a: 1,
              b: 20,
              levels: [4, 12, 24],
              start: [-3, 1.2] as [number, number],
              learningRate: /Nesterov|NAG|动量/iu.test(subject) ? 0.035 : 0.08,
              steps: 16,
              methods: /Nesterov|NAG|动量/iu.test(subject)
                ? (['gradient', 'nesterov'] as const)
                : (['gradient'] as const),
            }
          : undefined;
    if (spec)
      diagram = semanticBlockSchema.parse({
        id: required.id,
        kind: 'scientific-diagram',
        title: input.intent.claim.slice(0, 100),
        provenance: { kind: 'illustrative' },
        rect: { x: 48, y: 100, width: 400, height: 300 },
        spec,
      });
  }
  if (diagramIds.length && !diagram)
    throw new Error('A required scientific diagram has no valid source');
  const bounds = contentLayout(input.boardSpace, input.aspectRatio);
  const [ratioWidth, ratioHeight] = input.aspectRatio.split(':').map(Number);
  const canvasHeight = (960 * ratioHeight) / ratioWidth;
  const formulas = input.intent.formulas.filter((formula) => formula.placement !== 'notes');
  const imageRefs = [...new Set(input.imageRefs ?? [])];
  const layout = async (width: number) => {
    const fitted: SemanticBlock[] = [];
    for (const formula of formulas) {
      const fontSize = formula.fontSize ?? 28;
      const fit = await fitFormula(
        { latex: formula.latex, display: formula.display ?? true, fontSize },
        { width, height: bounds.height },
      );
      fitted.push({
        id: formula.id,
        kind: 'formula',
        latex: fit.latex,
        display: formula.display ?? true,
        color: '#172554',
        fontSize,
        rect: { x: bounds.x, y: 0, width, height: fit.measurement.minRectHeight },
      });
    }
    return fitted;
  };
  const diagramFits = (diagramWidth: number, diagramHeight: number) => {
    if (diagram?.kind !== 'scientific-diagram' || diagram.spec.type !== 'graph') return true;
    try {
      layoutScientificGraph(diagram.spec, diagramWidth, diagramHeight);
      return true;
    } catch {
      return false;
    }
  };
  const sideColumn = (bounds.width - 24) / 2;
  // A comparison graph keeps its full label width. Half a slide is not used when
  // that would force the labels to shrink or the page to fail.
  const twoColumns = Boolean(
    diagram &&
    bounds.width >= 800 &&
    (formulas.length || imageRefs.length || input.visibleContent?.length) &&
    diagramFits(sideColumn, bounds.height),
  );
  let formulaWidth = twoColumns ? (bounds.width - 24) / 2 : bounds.width;
  let fitted: SemanticBlock[];
  try {
    fitted = await layout(formulaWidth);
  } catch (error) {
    if (!twoColumns) throw error;
    formulaWidth = bounds.width;
    fitted = await layout(formulaWidth);
  }
  let imageColumn = false;
  if (!diagram && imageRefs.length === 1 && bounds.width >= 800 && formulaWidth === bounds.width) {
    const stacked =
      bounds.height -
      fitted.reduce((sum, formula) => sum + formula.rect.height, 0) -
      12 * Math.max(0, fitted.length - 1);
    if (stacked < 180) {
      try {
        const half = (bounds.width - 24) / 2;
        fitted = await layout(half);
        formulaWidth = half;
        imageColumn = true;
      } catch {
        // The formulas cannot wrap into a column. Keep them full width.
      }
    }
  }
  const sideBySide = formulaWidth < bounds.width;
  const imageCount = imageRefs.length;
  const reservedImage =
    imageCount && !sideBySide ? 96 * imageCount + 12 * Math.max(0, imageCount - 1) : 0;
  const formulaHeight = fitted.reduce((sum, formula) => sum + formula.rect.height, 0);
  const formulaGaps = Math.max(0, fitted.length - 1);
  const freeForGaps = bounds.height - formulaHeight - reservedImage;
  const formulaGap = formulaGaps
    ? Math.min(12, Math.max(4, Math.floor(freeForGaps / formulaGaps)))
    : 0;
  if (formulaHeight + formulaGap * formulaGaps + reservedImage > bounds.height + 1)
    throw new Error('This stage needs separate pages for its formulas');
  const blocksOut: SemanticBlock[] = [];
  let y = bounds.y;
  for (const [index, formula] of fitted.entries()) {
    blocksOut.push({ ...formula, rect: { ...formula.rect, y } });
    y += formula.rect.height;
    if (index < fitted.length - 1) y += formulaGap;
  }
  const columnWidth = sideBySide ? (bounds.width - 24) / 2 : bounds.width;
  const textMarkup: string[] = [];
  const fontSize = 24;
  const lineHeight = 29;
  const wrap = (value: string, maxWidth: number): string[] => {
    const tokens = value.match(/[A-Za-z0-9]+(?:[./+-][A-Za-z0-9]+)*|./gu) ?? [];
    const lines: string[] = [];
    let current = '';
    for (const token of tokens) {
      if (current && measureSlideText(current + token, fontSize) > maxWidth) {
        lines.push(current.trimEnd());
        current = '';
      }
      if (measureSlideText(token, fontSize) > maxWidth) {
        for (const character of token) {
          if (current && measureSlideText(current + character, fontSize) > maxWidth) {
            lines.push(current.trimEnd());
            current = '';
          }
          current += character;
        }
      } else current += token;
    }
    if (current.trim()) lines.push(current.trimEnd());
    return lines;
  };
  const contentLines = (input.visibleContent ?? []).flatMap((item) =>
    wrap(`• ${item}`, columnWidth - 16),
  );
  const overflowLines: string[] = [];
  const textBottom = bounds.y + bounds.height - reservedImage;
  if (contentLines.length && y + 4 < textBottom) {
    y += 4;
    for (const line of contentLines) {
      if (y + lineHeight > textBottom) {
        overflowLines.push(line);
        continue;
      }
      y += lineHeight;
      textMarkup.push(
        `<text x="${bounds.x + 4}" y="${y}" font-size="${fontSize}" font-family="Arial, Microsoft YaHei" fill="#26374d">${escapeSvgText(line)}</text>`,
      );
    }
    y += 8;
  } else overflowLines.push(...contentLines);
  const imageMarkup: string[] = [];
  if (diagram?.kind === 'scientific-diagram') {
    const diagramRect = sideBySide
      ? {
          x: bounds.x + (bounds.width - 24) / 2 + 24,
          y: bounds.y,
          width: (bounds.width - 24) / 2,
          height: bounds.height,
        }
      : {
          x: bounds.x,
          y,
          width: bounds.width,
          height: bounds.y + bounds.height - y - (imageRefs.length ? reservedImage + 12 : 0),
        };
    const requiredSize = minimumScientificDiagramSize(diagram, diagramRect.width);
    if (diagramRect.width < requiredSize.width || diagramRect.height < requiredSize.height)
      throw new Error('This stage needs separate pages for formulas and the scientific diagram');
    blocksOut.push({ ...diagram, rect: diagramRect });
    if (!sideBySide) y += diagramRect.height + 12;
  }
  const remainingHeight = bounds.y + bounds.height - y;
  if (imageColumn) {
    const imageWidth = (bounds.width - 24) / 2;
    imageMarkup.push(
      `<image href="${escapeSvgText(imageRefs[0])}" x="${bounds.x + imageWidth + 24}" y="${bounds.y}" width="${imageWidth}" height="${bounds.height}" preserveAspectRatio="xMidYMid meet"/>`,
    );
  } else if (imageRefs.length) {
    const imageWidth = diagram && sideBySide ? (bounds.width - 24) / 2 : bounds.width;
    const gap = 12;
    const imageHeight = (remainingHeight - gap * (imageRefs.length - 1)) / imageRefs.length;
    if (imageHeight < 96) throw new Error('This stage needs separate pages for its images');
    for (const [index, href] of imageRefs.entries())
      imageMarkup.push(
        `<image href="${escapeSvgText(href)}" x="${bounds.x}" y="${y + index * (imageHeight + gap)}" width="${imageWidth}" height="${imageHeight}" preserveAspectRatio="xMidYMid meet"/>`,
      );
  }
  const title = escapeSvgText(input.title);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${canvasHeight}"><rect x="0" y="0" width="960" height="${canvasHeight}" fill="#ffffff"/><text x="72" y="44" font-family="Microsoft YaHei, Arial" font-size="28" font-weight="bold" fill="#172554">${title}</text>${imageMarkup.join('')}${textMarkup.join('')}${blocksOut.map((block) => `<g data-content-id="${block.id}"/>`).join('')}</svg>`;
  const rendered = await renderSemanticBlocks(svg, blocksOut, input.intent);
  return overflowLines.length ? { ...rendered, overflowNotes: overflowLines.join('\n') } : rendered;
}
