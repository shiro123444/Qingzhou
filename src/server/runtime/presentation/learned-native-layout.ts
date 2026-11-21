import { selectedLayoutStyle } from './selected-style-layout';
import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { CapabilityCapsule } from './capability-memory';
import type { DeckPageRole, DeckVisualSystem } from './deck-visual-system';
import { isLearnedFooter, learnedFooter, learnedTextLines } from './learned-layout-primitives';
import { compileLearnedTextLayout } from './learned-text-layout';
import { layoutReportTable } from './report-table';
import { layoutScientificGraph, scientificGraphFeedbackOrder } from './scientific-graph-layout';
import {
  escapeSvgText,
  minimumScientificDiagramSize,
  type SemanticBlock,
  semanticBlockSchema,
} from './semantic-blocks';
import { measurePowerPointFrame, measureSlideText } from './text-measurement';

/** Text carriers are in page coordinates, even inside translated author groups. */
function textCarrier(element: Element) {
  const chain: Element[] = [];
  for (
    let node: Element | null = element;
    node;
    node = node.parentNode?.nodeType === 1 ? (node.parentNode as Element) : null
  )
    chain.unshift(node);
  let sx = 1,
    sy = 1,
    tx = 0,
    ty = 0;
  for (const node of chain)
    for (const [, name, args] of (node.getAttribute('transform') ?? '').matchAll(
      /([a-z]+)\s*\(([^)]*)\)/giu,
    )) {
      const values = args
        .trim()
        .split(/[\s,]+/u)
        .map(Number);
      if (!values.every(Number.isFinite)) return;
      if (name === 'translate') {
        tx += sx * values[0];
        ty += sy * (values[1] ?? 0);
      } else if (name === 'scale') {
        sx *= values[0];
        sy *= values[1] ?? values[0];
      } else return;
    }
  const inherited = (name: string) =>
    [...chain]
      .reverse()
      .find((node) => node.hasAttribute(name))
      ?.getAttribute(name);
  const first = element.getElementsByTagName('tspan')[0];
  return {
    text: (element.textContent ?? '').trim(),
    x: tx + sx * Number(element.getAttribute('x') ?? first?.getAttribute('x') ?? 0),
    y: ty + sy * Number(element.getAttribute('y') ?? first?.getAttribute('y') ?? 0),
    size: Math.abs(sy) * Number.parseFloat(inherited('font-size') ?? '16'),
    anchor: inherited('text-anchor') ?? 'start',
    weight: inherited('font-weight') ?? 'normal',
  };
}

function compileCover(input: {
  svg: string;
  title: string;
  capsules: CapabilityCapsule[];
  system: DeckVisualSystem;
  approvedContent?: string[];
}) {
  const { system } = input;
  const style = input.capsules.find(
    (c) =>
      c.kind === 'style' &&
      (selectedLayoutStyle(c, system) || c.designReference?.style?.sparseDecoration),
  );
  const preset = style && selectedLayoutStyle(style, system);
  const covers = input.capsules.filter(
    (c) =>
      c.kind === 'layout' &&
      c.layout?.roles.includes('cover') &&
      c.designReference?.slots?.some((s) => s.kind === 'title'),
  );
  const layout =
    covers.find((capsule) => capsule.source.workspaceId === preset?.coverLayout) ?? covers[0];
  if (!style || !layout) return;
  const doc = parseString(input.svg);
  if (doc.getElementsByTagName('image').length) return;
  const texts = Array.from(doc.getElementsByTagName('text')).flatMap((e) => {
    const text = textCarrier(e);
    return text ? [text] : [];
  });
  let title =
    texts.find((t) => t.text === input.title) ??
    texts.filter((t) => t.size >= 30).sort((a, b) => b.size - a.size)[0];
  if (!title || (!input.approvedContent?.length && texts.length > 7)) return;
  const headingLines = texts.filter((t) => t.size === title!.size && Math.abs(t.x - title!.x) < 1);
  const joinedTitle = headingLines.map((t) => t.text).join('');
  if (joinedTitle.replaceAll(/\s/gu, '').includes(input.title.replaceAll(/\s/gu, '')))
    title = { ...title, text: joinedTitle };
  else if (input.approvedContent?.length) title = { ...title, text: input.title };
  const slots = layout.designReference!.slots!;
  const main = slots.find((s) => s.kind === 'title')!,
    subtitle = slots.find((s) => s.kind === 'subtitle') ?? slots.find((s) => s.kind === 'body');
  const x = Math.round(main.box.x * system.width);
  const width = Math.min(
    Math.round(main.box.width * system.width),
    preset?.visualStyle === 'swiss-minimal' ? Math.round(system.width * 0.68) : system.width - x,
  );
  // Reserve display-scale type for short headlines; longer titles keep the
  // original source size so the cover remains editable and fits its slots.
  const shortTitle = [...input.title].length <= 12;
  const preferredTitleSize =
    preset && shortTitle
      ? preset.visualStyle === 'editorial'
        ? 88
        : 76
      : Math.max(36, Math.min(48, main.fontSize ?? 42));
  // Keep short titles together at display size when only the final glyphs would wrap.
  const measuredWidth = measurePowerPointFrame(
    title.text,
    preferredTitleSize,
    system.fontFamily,
    'bold',
  );
  const fitSize = Math.floor((preferredTitleSize * width) / Math.max(1, measuredWidth));
  const titleSize =
    preset && shortTitle && fitSize >= preferredTitleSize * 0.8
      ? Math.min(fitSize, preferredTitleSize)
      : preferredTitleSize;
  const parts: string[] = [];
  const paint = (text: string, y: number, size: number, color: string, bold = false) => {
    const lines = learnedTextLines(
      text,
      width,
      size,
      system.fontFamily,
      bold,
      measurePowerPointFrame,
    );
    lines.forEach((line, i) =>
      parts.push(
        `<text x="${x}" y="${y + size + i * size * 1.35}" font-size="${size}" fill="${color}" font-weight="${bold ? 'bold' : 'normal'}">${escapeSvgText(line)}</text>`,
      ),
    );
    return y + lines.length * size * 1.35;
  };
  const approved = input.approvedContent
    ?.filter((text) => text.trim() && text !== input.title)
    .map(
      (text) =>
        texts.find((t) => t.text === text) ?? { text, y: title.y, size: 18, x, anchor: 'start' },
    );
  const others = approved ?? texts.filter((t) => !headingLines.includes(t));
  const before = others.filter((t) => t.y < title.y);
  const after = others.filter((t) => t.y >= title.y);
  const beforeSize = input.approvedContent?.length ? 24 : 18;
  const beforeHeight = before.reduce(
    (height, item) =>
      height +
      learnedTextLines(
        item.text,
        width,
        beforeSize,
        system.fontFamily,
        false,
        measurePowerPointFrame,
      ).length *
        beforeSize *
        1.35 +
      12,
    0,
  );
  let titleY = Math.max(32 + beforeHeight, Math.round(main.box.y * system.height));
  let cursor = titleY - beforeHeight;
  for (const item of before)
    cursor = paint(item.text, cursor, beforeSize, system.colors.muted) + 12;
  cursor = paint(
    title.text,
    titleY,
    titleSize,
    preset?.visualStyle === 'editorial' ? system.colors.primary : system.colors.text,
    true,
  );
  let headerBottom = cursor;
  for (const [i, item] of after.entries())
    cursor = paint(
      item.text.replace(/^(?:副标题|subtitle)\s*[：:]\s*(?=\S)/iu, ''),
      i === 0 ? Math.max(cursor + 20, (subtitle?.box.y ?? 0) * system.height) : cursor + 28,
      input.approvedContent?.length || i === 0 ? 24 : 18,
      system.colors.muted,
    );
  if (cursor > system.height - 32) {
    // Dense covers can use part of the source's large top margin. Move the
    // entire measured title/subtitle group together, retaining its hierarchy.
    const shift = cursor - (system.height - 32);
    if (shift > titleY - beforeHeight - 32) return;
    titleY -= shift;
    headerBottom -= shift;
    cursor -= shift;
    for (let i = 0; i < parts.length; i++)
      parts[i] = parts[i].replaceAll(/ y="([\d.]+)"/gu, (_, y) => ` y="${Number(y) - shift}"`);
  }
  const accents = layout.designReference?.accents ?? [];
  const accentSvg = accents
    .filter((accent) => accent.box.height > accent.box.width && accent.box.x < main.box.x)
    .map(
      (accent) =>
        `<rect id="learned-${accent.id}" x="${accent.box.x * system.width}" y="${titleY}" width="${accent.box.width * system.width}" height="${cursor - titleY}" fill="${accent.fill}"/>`,
    )
    .join('');
  const blueprintGrid =
    preset?.visualStyle === 'blueprint'
      ? Array.from(
          { length: Math.ceil(system.width / 48) },
          (_, i) => `M ${i * 48} 0 v ${system.height}`,
        ).join(' ') +
        ' ' +
        Array.from(
          { length: Math.ceil(system.height / 48) },
          (_, i) => `M 0 ${i * 48} h ${system.width}`,
        ).join(' ')
      : '';
  const coverGeometry = !preset
    ? accentSvg
    : preset.visualStyle === 'swiss-minimal'
      ? `<rect x="${system.width * 0.8}" width="${system.width * 0.2}" height="${system.height}" fill="${system.colors.primary}"/>`
      : preset.visualStyle === 'editorial'
        ? `<path d="M ${x} 40 H ${system.width - x} M ${x} ${system.height - 40} H ${system.width - x}" stroke="${system.colors.primary}" fill="none" stroke-width="2"/>`
        : `<path d="${blueprintGrid}" fill="none" stroke="${system.colors.primary}" stroke-opacity=".17" stroke-width="1"/><path d="M ${x} 46 H ${system.width - x} V ${system.height - 40} M ${x} 38 V 54 M ${system.width - x - 8} ${system.height - 40} H ${system.width - x + 8}" fill="none" stroke="${system.colors.primary}" stroke-width="2"/>`;
  const receipt = {
    decorationIds: (preset ? [] : accents)
      .filter((accent) => accent.box.height > accent.box.width && accent.box.x < main.box.x)
      .map((accent) => accent.id),
    schemaVersion: 1,
    layoutCapsuleId: layout.id,
    sourceDigest: layout.source.sourceDigest,
    observation: layout.source.templateId
      ? {
          templateId: layout.source.templateId,
          versionId: layout.source.versionId,
          pages: layout.source.evidencePages,
        }
      : undefined,
    styleCapsuleId: style.id,
    visualStyle: style.designReference!.style!.id,
    slotIds: slots.map((s) => s.id),
    adaptations: [
      'source title/subtitle hierarchy',
      'content-measured cover height',
      ...(preset
        ? [`Applied ${preset.visualStyle} cover geometry and measured display type`]
        : accentSvg
          ? ['source cover accent aligned to measured title/subtitle block']
          : []),
    ],
    metrics: {
      headerBottom,
      evidenceTop: headerBottom,
      evidenceBottom: cursor,
      contentBottom: cursor,
      sourceEvidenceBottom: (main.box.y + main.box.height) * system.height,
      canvasHeight: system.height,
    },
  };
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" lang="zh-CN" viewBox="0 0 ${system.width} ${system.height}" font-family="${escapeSvgText(system.fontFamily)}"><rect id="learned-background" data-pptx-role="background" width="${system.width}" height="${system.height}" fill="${system.colors.background}"/>${coverGeometry}<g id="learned-cover" data-pptx-bounds="${x} ${Math.max(0, titleY - beforeHeight)} ${width} ${cursor - Math.max(0, titleY - beforeHeight)}">${parts.join('')}</g></svg>`,
    blocks: [] as SemanticBlock[],
    receipt,
    uses: [
      {
        capsuleId: layout.id,
        reason: 'Compiled source title and subtitle geometry with measured cover text.',
      },
      {
        capsuleId: style.id,
        reason: `Applied ${receipt.visualStyle} type-led cover and sparse-decoration grammar.`,
      },
    ],
  };
}

/** Compile observed slots into measured native composition, without a page-specific prompt.
 * Complex artwork/formula pages remain in their existing authoring path. */
export function compileLearnedNativeLayout(input: {
  svg: string;
  rawBlocks: unknown;
  title: string;
  capsules: CapabilityCapsule[];
  system?: DeckVisualSystem;
  role?: DeckPageRole;
  approvedContent?: string[];
  onSkip?: (reason: string) => void;
  pageNumber?: number;
  totalPages?: number;
  deckTitle?: string;
}) {
  const { system } = input;
  const skip = (reason: string) => {
    input.onSkip?.(reason);
    return undefined;
  };
  if (
    system?.schemaVersion === 3 &&
    input.role === 'cover' &&
    (!input.rawBlocks || (Array.isArray(input.rawBlocks) && !input.rawBlocks.length))
  )
    return compileCover({ ...input, system });
  if (
    system?.schemaVersion === 3 &&
    (!input.rawBlocks || (Array.isArray(input.rawBlocks) && !input.rawBlocks.length))
  )
    return compileLearnedTextLayout({ ...input, system });
  if (
    system?.schemaVersion !== 3 ||
    !Array.isArray(input.rawBlocks) ||
    input.rawBlocks.length !== 1
  )
    return skip('unsupported-contract-or-native-block-count');
  const parsed = semanticBlockSchema.safeParse(input.rawBlocks[0]);
  if (
    !parsed.success ||
    parsed.data.kind !== 'scientific-diagram' ||
    !['table', 'graph'].includes(parsed.data.spec.type)
  )
    return skip('unsupported-native-kind');
  const block = parsed.data;
  const kind = block.spec.type;
  const document = parseString(input.svg);
  if (document.getElementsByTagName('image').length) return skip('complex-image-composition');
  const style = input.capsules.find(
    (c) =>
      c.kind === 'style' &&
      (selectedLayoutStyle(c, system) ||
        c.designReference?.style?.flat ||
        c.designReference?.style?.sparseDecoration ||
        c.designReference?.style?.grid),
  );
  const candidates = input.capsules.filter(
    (c) =>
      c.kind === 'layout' &&
      (!c.source.aspectRatio ||
        Math.abs(
          Number(c.source.aspectRatio.split(':')[0]) / Number(c.source.aspectRatio.split(':')[1]) -
            system.width / system.height,
        ) < 0.001) &&
      c.layout?.roles.includes(kind === 'table' ? 'data' : 'process') &&
      c.designReference?.slots?.some((s) => s.kind === (kind === 'table' ? 'table' : 'object')),
  );
  const layout = candidates.sort(
    (a, b) =>
      b.designReference!.slots!.filter((s) => s.kind === (kind === 'table' ? 'table' : 'object'))
        .length -
        a.designReference!.slots!.filter((s) => s.kind === (kind === 'table' ? 'table' : 'object'))
          .length || a.id.localeCompare(b.id),
  )[0];
  if (!layout) return skip('no-compatible-source-layout');
  const slots = layout.designReference!.slots!;
  const heading = slots.find((s) => s.kind === 'title');
  const evidence = slots.filter((s) => s.kind === (kind === 'table' ? 'table' : 'object'));
  if (!heading || !evidence.length) return skip('source-slots-incomplete');
  // Do not steal another native visual's labels: only simple source text carriers
  // outside the semantic anchor are eligible, and every string survives exactly.
  const texts = Array.from(document.getElementsByTagName('text'))
    .filter((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement)
        if (parent.hasAttribute('data-scientific-diagram')) return false;
      return true;
    })
    .filter((e) => !Array.from(e.getElementsByTagName('text')).length)
    .flatMap((e) => {
      const text = textCarrier(e);
      return text ? [text] : [];
    })
    .filter(
      (t) =>
        t.text.trim() &&
        (t.text === input.title ||
          block.spec.type !== 'graph' ||
          !block.spec.nodes.some((node) => node.label === t.text)),
    );
  if (texts.length > 24) return skip('complex-text-composition');
  let titleIndex = texts.findIndex((t) => t.text === input.title);
  if (titleIndex < 0) {
    // Authors may expand a heading into an assertion. Identify its text carrier
    // from typography and position, and preserve that complete authored heading.
    const titles = texts
      .map((text, index) => ({ ...text, index }))
      .filter((text) => text.size >= 28 && text.y < block.rect.y && text.y <= system.height * 0.3)
      .sort((a, b) => b.size - a.size || a.y - b.y);
    if (!titles.length) return skip('heading-carrier-not-found');
    titleIndex = titles[0].index;
  }
  const headingLines = texts.filter(
    (t) =>
      t.size === texts[titleIndex].size &&
      Math.abs(t.x - texts[titleIndex].x) < 1 &&
      t.y < block.rect.y,
  );
  const carriedTitle =
    headingLines.length > 1 ? headingLines.map((t) => t.text).join('') : texts[titleIndex].text;
  const authoredTitle =
    input.approvedContent?.length &&
    !carriedTitle.replaceAll(/[\s\p{P}]/gu, '').includes(input.title.replaceAll(/[\s\p{P}]/gu, ''))
      ? input.title
      : carriedTitle;
  const other = texts.filter((t, i) => i !== titleIndex && !headingLines.includes(t));
  let before = other.filter((t) => t.y < block.rect.y);
  const pageText = (t: (typeof texts)[number]) => {
    const fraction = t.text.match(/(?:^|[\s·•])(\d{1,3})\s*\/\s*(\d{1,3})$/u);
    if (
      fraction &&
      (input.pageNumber === undefined
        ? /^\d{1,3}\s*\/\s*\d{1,3}$/u.test(t.text)
        : Number(fraction[1]) === input.pageNumber && Number(fraction[2]) === input.totalPages)
    )
      return `${Number(fraction[1])} / ${Number(fraction[2])}`;
    if (
      input.pageNumber !== undefined &&
      input.totalPages &&
      t.y > system.height * 0.9 &&
      /^\d{1,3}$/u.test(t.text) &&
      Number(t.text) === input.pageNumber
    )
      return `${input.pageNumber} / ${input.totalPages}`;
  };
  const footerCarriers = other.filter(
    (t) => (t.y > system.height * 0.9 && t.size <= 18) || pageText(t),
  );
  const footers = footerCarriers
    .filter(
      (t) =>
        !isLearnedFooter(t, system.height, input.pageNumber, input.totalPages, input.deckTitle) &&
        !(input.pageNumber && input.totalPages && pageText(t)),
    )
    .map((t) =>
      pageText(t)
        ? {
            ...t,
            text: pageText(t)!,
            x: (heading.box.x + heading.box.width) * system.width,
            y: system.height - 16,
            anchor: 'end',
          }
        : t,
    );

  let after = other.filter((t) => t.y >= block.rect.y && !footerCarriers.includes(t));
  let hasTakeaway = !input.approvedContent?.length;
  let responsibilityNotes: typeof after = [];
  if (input.approvedContent?.length) {
    const canonical = (value: string) => value.normalize('NFC').replaceAll(/\s/gu, '');
    const labels = block.spec.type === 'graph' ? block.spec.nodes.map((node) => node.label) : [];
    const facts = new Set(
      [
        authoredTitle,
        ...labels,
        ...(block.spec.type === 'table' ? [...block.spec.columns, ...block.spec.rows.flat()] : []),
      ].map(canonical),
    );
    if (block.spec.type === 'table') {
      for (const row of block.spec.rows) {
        // An approved label–value statement can already be present as one complete
        // native row. Match whole cells in order so qualifiers stay in the notes.
        for (const separator of ['：', ':', '—', '——', '｜', '|', '·']) {
          facts.add(canonical(row.join(separator)));
        }
      }
    }
    const points = input.approvedContent.filter((point) => point.trim());
    const keys = points.map(canonical);
    const nodeLabels = labels.map(canonical);
    // When the outline itself enumerates the diagram nodes, surrounding copy
    // can frame that diagram. Otherwise its key points form one peer group.
    const nodeStart =
      nodeLabels.length >= 2
        ? keys.findIndex((_, start) => nodeLabels.every((label, i) => keys[start + i] === label))
        : -1;
    const carriers = (items: string[]) =>
      items
        .filter((point) => !facts.has(canonical(point)))
        .map((text, index) => ({
          text,
          x: 48,
          y: block.rect.y + block.rect.height + index * 32,
          size: 24,
          anchor: 'start',
          weight: 'normal',
        }));
    before = nodeStart < 0 ? [] : carriers(points.slice(0, nodeStart));
    after = carriers(nodeStart < 0 ? points : points.slice(nodeStart + nodeLabels.length));
    hasTakeaway = nodeStart >= 0 && after.length === 1;
  }
  // Keep a node's approved responsibilities together in the measured source
  // evidence band. This applies only when each graph entity has exactly one
  // explicitly keyed paragraph; an unkeyed conclusion still spans the row.
  if (
    input.approvedContent?.length &&
    block.spec.type === 'graph' &&
    block.spec.nodes.length >= 2 &&
    block.spec.nodes.length <= 4 &&
    block.spec.edges.length >= block.spec.nodes.length
  ) {
    const facts = [...before, ...after];
    const names = block.spec.nodes.map(
      (node) => new Set([node.id, node.label, node.label.split(/[·•（(：:]/u)[0]]),
    );
    const matches = names.map((aliases) =>
      facts.filter(({ text }) => {
        const prefix = text.match(/^([^：:]{1,32})[：:]/u)?.[1]?.trim();
        return !!prefix && aliases.has(prefix);
      }),
    );
    if (
      matches.every((items) => items.length === 1) &&
      new Set(matches.flat()).size === names.length
    ) {
      responsibilityNotes = matches.flat();
      before = [];
      after = facts;
    }
  }
  before = before.filter((item) => !footerCarriers.includes(item));
  const x = Math.round(heading.box.x * system.width);
  const width = Math.round(heading.box.width * system.width);
  const top = Math.round(heading.box.y * system.height);
  const sourceBottom = Math.max(...evidence.map((s) => (s.box.y + s.box.height) * system.height));
  const parts: string[] = [];
  const wrap = (value: string, size: number, weight: string, availableWidth = width) => {
    return learnedTextLines(
      value,
      availableWidth,
      size,
      system.fontFamily,
      weight === 'bold' || Number(weight) >= 600,
    );
  };
  const paint = (
    value: string,
    y: number,
    size: number,
    color: string,
    weight = 'normal',
    left = x,
    availableWidth = width,
  ) => {
    const lines = wrap(value, size, weight, availableWidth);
    lines.forEach((line, i) =>
      parts.push(
        `<text x="${left}" y="${y + size + i * size * 1.35}" font-size="${size}" font-weight="${weight}" fill="${color}">${escapeSvgText(line)}</text>`,
      ),
    );
    return y + lines.length * size * 1.35;
  };
  let cursor = paint(
    authoredTitle,
    top,
    Math.max(30, Math.min(36, heading.fontSize ?? system.typography.title)),
    system.colors.text,
    'bold',
  );
  for (const item of before) cursor = paint(item.text, cursor + 10, 24, system.colors.muted);
  // Derive a useful evidence top from the source slot, then compact the gap
  // against the real header height. Empty slot height is not painted content.
  const evidenceTop = Math.min(...evidence.map((s) => s.box.y * system.height));
  let y: number;
  const headerBottom = cursor;
  const sparse = style?.designReference?.style?.sparseDecoration ?? false;
  let next: SemanticBlock;
  let actualHeight: number;
  const sideSlot =
    kind === 'table' && after.length
      ? slots.find(
          (slot) => slot.kind === 'body' && slot.box.x >= evidence[0].box.x + evidence[0].box.width,
        )
      : undefined;
  const evidenceX = sideSlot ? Math.round(evidence[0].box.x * system.width) : x;
  const tableWidth = sideSlot ? Math.round(evidence[0].box.width * system.width) : width;
  let sideX = sideSlot ? Math.round(sideSlot.box.x * system.width) : 0;
  let sideWidth = sideSlot ? Math.round(sideSlot.box.width * system.width) : 0;
  let sideFont = 24;
  let sideCount = after.length;
  const responsibilityWidth = responsibilityNotes.length
    ? (width - 24 * (responsibilityNotes.length - 1)) / responsibilityNotes.length
    : 0;
  const responsibilityHeight = responsibilityNotes.length
    ? 10 +
      Math.max(
        ...responsibilityNotes.map(
          ({ text }) => wrap(text, 24, 'normal', responsibilityWidth).length * 24 * 1.35,
        ),
      )
    : 0;
  const summaryFont = 24;
  let summaryGap = 24;
  const bottomLimit = Math.min(
    system.height - 32,
    ...footers.map((item) => item.y - item.size - 8),
  );
  if (block.spec.type === 'table') {
    const spec = {
      ...block.spec,
      fontFamily: system.fontFamily,
      fontSize: Math.max(20, block.spec.fontSize),
      ...(sparse
        ? {
            headerFill: system.colors.background,
            headerText: system.colors.text,
            bodyFill: system.colors.background,
            bandFill: system.colors.background,
            textColor: system.colors.text,
          }
        : {}),
    };
    const measured = layoutReportTable(spec, tableWidth);
    actualHeight = Math.max(180, measured.height);
    const sideHeight = (count: number) =>
      after
        .slice(0, count)
        .reduce(
          (height, item, index) =>
            height +
            wrap(item.text, sideFont, item.weight, sideWidth).length * sideFont * 1.35 +
            (index ? 12 : 0),
          0,
        );
    const sideTop = sideSlot ? Math.max(headerBottom + 28, sideSlot.box.y * system.height) : 0;
    if (sideSlot && sideTop + sideHeight(sideCount) > bottomLimit) {
      // The measured exemplar leaves a wide gutter for its short summary.
      // Let longer approved summaries use that space, keeping a visible gutter
      // and the same title/table anchors, then flow surplus paragraphs below.
      sideX = Math.min(sideX, evidenceX + tableWidth + 24);
      sideWidth = Math.max(sideWidth, x + width - sideX);
      for (const size of [24, 22, 20]) {
        sideFont = size;
        if (sideTop + sideHeight(sideCount) <= bottomLimit) break;
      }
      // Allocate the remaining paragraphs to the full-width space below the
      // exhibit only when both bands fit together.
      while (sideCount && sideTop + sideHeight(sideCount) > bottomLimit) sideCount--;
    }
    const belowHeight = (count: number) =>
      after
        .slice(count)
        .reduce(
          (height, { text }) =>
            height + summaryGap + wrap(text, summaryFont, 'normal').length * summaryFont * 1.35,
          0,
        );
    while (
      sideSlot &&
      sideCount < after.length &&
      Math.max(headerBottom + 28 + actualHeight, sideTop + sideHeight(sideCount)) +
        belowHeight(sideCount) >
        bottomLimit
    ) {
      if (sideCount === 0) return skip('content-exceeds-source-capacity');
      sideCount--;
    }
    const reservedBelow = sideSlot ? belowHeight(sideCount) : 0;
    const notesHeight = sideSlot ? sideHeight(sideCount) : 0;
    y = Math.max(
      headerBottom + 28,
      Math.min(
        (evidenceTop + sourceBottom - Math.max(actualHeight, notesHeight)) / 2,
        bottomLimit - reservedBelow - Math.max(actualHeight, notesHeight),
      ),
    );
    next = {
      ...block,
      spec,
      rect: { x: evidenceX, y, width: tableWidth, height: Math.max(180, actualHeight) },
    };
  } else if (block.spec.type === 'graph') {
    // Preserve node/edge semantics and order; the graph renderer owns DAG layout.
    const spec = {
      ...block.spec,
      style: {
        ...block.spec.style,
        fontFamily: system.fontFamily,
        fontSize: 24,
        ...(sparse
          ? {
              nodeFill: 'none' as const,
              nodeStroke: 'none' as const,
              borderRadius: 0,
              textColor: system.colors.text,
              edgeColor: system.colors.primary,
            }
          : {}),
      },
    };
    actualHeight =
      (sparse ? 96 : 180) + (scientificGraphFeedbackOrder(spec)?.feedback.length ?? 0) * 96;
    let evidenceWidth = width;
    let graphLayout: ReturnType<typeof layoutScientificGraph>;
    try {
      graphLayout = layoutScientificGraph(spec, evidenceWidth / 1.5, actualHeight / 1.5);
    } catch {
      evidenceWidth = system.width - 2 * x;
      try {
        graphLayout = layoutScientificGraph(spec, evidenceWidth / 1.5, actualHeight / 1.5);
      } catch {
        // Branches and cross-level links occupy more than a single timeline
        // row. Reuse the renderer's measured minimum for the full evidence band.
        const needed = minimumScientificDiagramSize({ ...block, spec }, evidenceWidth);
        if (needed.width > evidenceWidth) return skip('graph-content-exceeds-source-capacity');
        actualHeight = Math.max(actualHeight, needed.height);
        try {
          graphLayout = layoutScientificGraph(spec, evidenceWidth / 1.5, actualHeight / 1.5);
        } catch {
          return skip('graph-content-exceeds-source-capacity');
        }
      }
    }
    const centers = [...graphLayout.positions.values()].map((position) => position.y * 1.5);
    const visibleCenter = (Math.min(...centers) + Math.max(...centers)) / 2;
    y = Math.max(headerBottom + 28, (evidenceTop + sourceBottom) / 2 - visibleCenter);
    if (input.approvedContent?.length && after.length) {
      // The authored graph may include return lanes. Reserve the measured
      // explanation band before centering it in the observed sequence grid.
      const required = () =>
        after
          .filter((item) => !responsibilityNotes.includes(item))
          .reduce(
            (height, { text }) =>
              height + summaryGap + wrap(text, summaryFont, 'normal').length * summaryFont * 1.35,
            responsibilityHeight,
          );
      if (y + actualHeight + required() > bottomLimit) {
        summaryGap = 12;
        if (headerBottom + 20 + actualHeight + required() > bottomLimit) summaryGap = 8;
        y = Math.max(headerBottom + 20, Math.min(y, bottomLimit - actualHeight - required()));
      }
    }
    next = { ...block, spec, rect: { x, y, width: evidenceWidth, height: actualHeight } };
  } else return skip('unsupported-native-kind');
  parts.push(
    `<g id="learned-native-evidence" data-pptx-bounds="${next.rect.x} ${y} ${next.rect.width} ${next.rect.height}"><g data-content-id="${block.id}"/></g>`,
  );
  cursor = y + actualHeight;
  const columnNotes = new Set<(typeof after)[number]>();
  if (responsibilityNotes.length) {
    const top = cursor + 10;
    for (const [index, item] of responsibilityNotes.entries()) {
      paint(
        item.text,
        top,
        24,
        system.colors.text,
        'normal',
        x + index * (responsibilityWidth + 24),
        responsibilityWidth,
      );
      columnNotes.add(item);
    }
    cursor += responsibilityHeight;
  }
  if (sideSlot) {
    let sideY = Math.max(y, sideSlot.box.y * system.height);
    for (const [index, item] of after.slice(0, sideCount).entries()) {
      sideY = paint(
        item.text,
        sideY + (index ? 12 : 0),
        sideFont,
        system.colors.text,
        item.weight,
        sideX,
        sideWidth,
      );
      columnNotes.add(item);
    }
    cursor = Math.max(cursor, sideY);
  }
  if (
    block.spec.type === 'graph' &&
    !responsibilityNotes.length &&
    after.length >= block.spec.nodes.length &&
    block.spec.nodes.length >= 2
  ) {
    const n = block.spec.nodes.length;
    const rowTop = Math.min(...after.map((item) => item.y));
    const candidates = after.filter(
      (item) =>
        item.y >= rowTop && measureSlideText(item.text, 24, system.fontFamily) <= (width / n) * 1.5,
    );
    const band = candidates.filter((item) => item.y <= rowTop + 48);
    const groups: Array<Array<(typeof after)[number]>> = [];
    for (const item of band.toSorted((a, b) => a.x - b.x || a.y - b.y)) {
      const group = groups.find((items) => Math.abs(items[0].x - item.x) < width / n / 3);
      if (group) group.push(item);
      else groups.push([item]);
    }
    // Adjacent columns are a semantic relationship, not four independent
    // paragraphs. Keep complete node explanations together at readable size.
    if (groups.length === n) {
      for (const item of candidates.filter(
        (item) => !band.includes(item) && item.y <= rowTop + 160,
      )) {
        const group = groups.find((items) => Math.abs(items[0].x - item.x) < width / n / 3);
        if (group) group.push(item);
      }
      let bottom = cursor;
      for (const [index, items] of groups.entries()) {
        // A simple flow's viewport includes transparent lower space. Put the
        // node explanations on that grid band instead of adding a second empty
        // viewport's worth of gap below the arrows.
        let noteY = cursor + 8;
        for (const item of items.toSorted((a, b) => a.y - b.y)) {
          noteY = paint(
            item.text,
            noteY,
            item.size <= 18 && item.text.length <= 12 ? 16 : 24,
            system.colors.muted,
            'normal',
            x + (index * width) / n,
            width / n - 24,
          );
          columnNotes.add(item);
        }
        bottom = Math.max(bottom, noteY);
      }
      cursor = bottom;
    }
  }
  const takeaway =
    kind === 'graph' && hasTakeaway
      ? slots.find((slot) => slot.kind === 'body' && slot.box.y * system.height >= sourceBottom)
      : undefined;
  const remainingAfter = after.filter((item) => !columnNotes.has(item));
  for (const [index, item] of remainingAfter.entries())
    cursor = paint(
      item.text,
      takeaway && index === remainingAfter.length - 1
        ? Math.max(
            cursor + summaryGap,
            Math.min(
              takeaway.box.y * system.height,
              bottomLimit - wrap(item.text, summaryFont, 'normal').length * summaryFont * 1.35,
            ),
          )
        : cursor + summaryGap,
      summaryFont,
      system.colors.text,
    );
  if (cursor > system.height - 24) return skip('content-exceeds-source-capacity');
  for (const item of footers)
    parts.push(
      `<text x="${item.x}" y="${item.y}" text-anchor="${escapeSvgText(item.anchor)}" font-size="16" fill="${system.colors.muted}">${escapeSvgText(item.text)}</text>`,
    );
  const receipt = {
    schemaVersion: 1,
    layoutCapsuleId: layout.id,
    sourceDigest: layout.source.sourceDigest,
    observation: layout.source.templateId
      ? {
          templateId: layout.source.templateId,
          versionId: layout.source.versionId,
          pages: layout.source.evidencePages,
        }
      : undefined,
    styleCapsuleId: style?.id,
    visualStyle: style?.designReference?.style?.id,
    slotIds: [
      heading.id,
      ...evidence.map((s) => s.id),
      ...(sideSlot ? [sideSlot.id] : []),
      ...(takeaway && remainingAfter.length ? [takeaway.id] : []),
    ],
    adaptations: [
      'content-measured columns',
      'intrinsic evidence height',
      'source grid anchors',
      ...(kind === 'graph' ? ['source evidence center band'] : []),
      ...(block.spec.type === 'graph' && scientificGraphFeedbackOrder(block.spec)
        ? ['source sequence with measured native feedback return lanes']
        : []),
      ...(takeaway && remainingAfter.length ? ['source takeaway baseline'] : []),
      ...(input.approvedContent?.length
        ? ['approved content routed to native evidence and source text slots']
        : []),
      ...(sideSlot
        ? ['source table and summary columns']
        : columnNotes.size
          ? ['node-aligned explanation columns']
          : []),
    ],
    metrics: {
      headerBottom,
      evidenceTop: y,
      evidenceBottom: y + actualHeight,
      contentBottom: cursor,
      sourceEvidenceBottom: sourceBottom,
      canvasHeight: system.height,
    },
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" lang="zh-CN" viewBox="0 0 ${system.width} ${system.height}" font-family="${escapeSvgText(system.fontFamily)}"><rect id="learned-background" data-pptx-role="background" width="${system.width}" height="${system.height}" fill="${system.colors.background}"/><g id="learned-page-content" data-pptx-bounds="${x} ${top} ${width} ${Math.max(cursor, ...footers.map((item) => item.y + 8)) - top}">${parts.join('')}</g>${learnedFooter(system, input.pageNumber, input.totalPages)}</svg>`;
  return {
    svg,
    blocks: [next],
    receipt,
    uses: [
      {
        capsuleId: layout.id,
        reason: `Compiled observed slots ${receipt.slotIds.join(', ')}; measured evidence and text without changing facts.`,
      },
      ...(style
        ? [
            {
              capsuleId: style.id,
              reason: `Compiled ${receipt.visualStyle} grid, surface and decoration observations into native content styling.`,
            },
          ]
        : []),
    ],
  };
}
