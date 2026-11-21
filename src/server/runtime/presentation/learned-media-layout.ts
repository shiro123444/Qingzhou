import { selectedLayoutStyle } from './selected-style-layout';
import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import { approvedPointSeries } from './approved-point-series';
import type { CapabilityCapsule } from './capability-memory';
import type { DeckVisualSystem } from './deck-visual-system';
import { measureFormula } from './formula-renderer';
import { learnedFooter, learnedTextLines, learnedTextSvg } from './learned-layout-primitives';
import { plotPalette } from './scatter-chart';
import {
  escapeSvgText,
  minimumScientificDiagramSize,
  type SemanticBlock,
  semanticBlockSchema,
} from './semantic-blocks';

type Slot = NonNullable<NonNullable<CapabilityCapsule['designReference']>['slots']>[number];
type Box = { x: number; y: number; width: number; height: number };
type MediaInput = {
  svg: string;
  rawBlocks: unknown;
  title: string;
  capsules: CapabilityCapsule[];
  system: DeckVisualSystem;
  approvedContent?: string[];
  exhibitCopy?: string[];
  pageNumber?: number;
  totalPages?: number;
  imageSizes?: ReadonlyMap<string, { width: number; height: number }>;
  onSkip?: (reason: string) => void;
};
type Unit = {
  id: string;
  kind: 'image' | 'formula' | 'table' | 'chart' | 'graph';
  minWidth: number;
  block?: SemanticBlock;
  href?: string;
  size?: { width: number; height: number };
  minHeight?: (width: number) => number;
};
const canon = (s: string) => s.replaceAll(/[\s\p{P}]/gu, '');
const boxOf = (slot: Slot, system: DeckVisualSystem): Box => ({
  x: slot.box.x * system.width,
  y: slot.box.y * system.height,
  width: slot.box.width * system.width,
  height: slot.box.height * system.height,
});

/** Pack real media into indexed source lanes. Repeated execution starts from
 * approved content and immutable media, never the previous repair's decoration. */
export async function compileLearnedMediaLayout(input: MediaInput) {
  const skip = (reason: string) => {
    input.onSkip?.(reason);
    return undefined;
  };
  const { system } = input;
  const style = input.capsules.find(
    (c) =>
      c.kind === 'style' &&
      (selectedLayoutStyle(c, system) ||
        c.designReference?.style?.flat ||
        c.designReference?.style?.grid ||
        c.designReference?.style?.sparseDecoration),
  );
  const parsed = Array.isArray(input.rawBlocks)
    ? input.rawBlocks.map((raw) => semanticBlockSchema.safeParse(raw))
    : [];
  if (parsed.some((p) => !p.success)) return skip('invalid-media-content-block');
  const originalBlocks = parsed.flatMap((p) => (p.success ? [p.data] : []));
  const doc = parseString(input.svg);
  const images = Array.from(doc.getElementsByTagName('image'));
  if (!images.length && !originalBlocks.length) return skip('no-media-content');
  // A single picture can use measured source geometry independently from a
  // decorative style the media compiler does not yet implement.
  if (!style && (images.length !== 1 || originalBlocks.length))
    return skip('no-compatible-media-style');
  const units: Unit[] = [];
  for (const [i, image] of images.entries()) {
    const href = image.getAttribute('href') ?? image.getAttribute('xlink:href') ?? '';
    let size = input.imageSizes?.get(href);
    if (!size && /^data:image\/(?:png|jpeg|webp);base64,/u.test(href)) {
      const bytes = Buffer.from(href.slice(href.indexOf(',') + 1), 'base64');
      if (bytes.length > 25 * 1024 * 1024) return skip('media-image-too-large');
      try {
        const meta = await (await import('sharp')).default(bytes).metadata();
        if (meta.width && meta.height) size = { width: meta.width, height: meta.height };
      } catch {
        return skip('media-image-decode-failed');
      }
    }
    if (!href || !size || size.width <= 0 || size.height <= 0)
      return skip('image-intrinsics-unavailable');
    units.push({ id: `image-${i + 1}`, kind: 'image', href, size, minWidth: 120 });
  }
  for (const block of originalBlocks) {
    if (block.kind === 'formula') {
      const measurement = await measureFormula({
        latex: block.latex,
        display: block.display,
        fontSize: block.fontSize,
      });
      units.push({
        id: block.id,
        kind: 'formula',
        block: { ...block, color: system.colors.text },
        minWidth: measurement.minRectWidth,
        minHeight: () => measurement.minRectHeight,
      });
    } else {
      const spec = block.spec;
      const points = approvedPointSeries(input.approvedContent ?? []);
      if (spec.type === 'plot' && spec.series.length === 1 && points) {
        const { xRange, yRange } = spec;
        if (
          points.some(([x, y]) => x < xRange[0] || x > xRange[1] || y < yRange[0] || y > yRange[1])
        )
          return skip('approved-plot-data-exceeds-source-range');
        if (JSON.stringify(spec.series[0].points) !== JSON.stringify(points))
          return skip('approved-point-series-mismatch');
      }
      const styled: SemanticBlock = {
        ...block,
        spec:
          spec.type === 'table'
            ? {
                ...spec,
                fontFamily: system.fontFamily,
                fontSize: Math.max(20, spec.fontSize),
                headerFill: system.colors.background,
                headerText: system.colors.text,
                bodyFill: system.colors.background,
                bandFill: system.colors.background,
                textColor: system.colors.text,
              }
            : spec.type === 'graph'
              ? {
                  ...spec,
                  style: {
                    ...spec.style,
                    fontFamily: system.fontFamily,
                    fontSize: 24,
                    nodeFill: 'none',
                    nodeStroke: 'none',
                    borderRadius: 0,
                    edgeColor: system.colors.primary,
                    textColor: system.colors.text,
                  },
                }
              : spec.type === 'plot'
                ? {
                    ...spec,
                    fontFamily: system.fontFamily,
                    textColor: system.colors.text,
                    series: spec.series.map((s, i) => ({
                      ...s,
                      color: i === 0 ? system.colors.primary : (s.color ?? plotPalette[i]),
                    })),
                  }
                : spec,
      };
      units.push({
        id: block.id,
        kind: spec.type === 'table' ? 'table' : spec.type === 'graph' ? 'graph' : 'chart',
        block: styled,
        minWidth: 280,
        minHeight: (width) => {
          const size = minimumScientificDiagramSize(
            styled as Extract<SemanticBlock, { kind: 'scientific-diagram' }>,
            width,
          );
          if (size.width > width + 0.1) throw new Error('Evidence needs a wider source lane');
          return size.height;
        },
      });
    }
  }
  if (units.length > 8) return skip('media-object-count-exceeds-capacity');
  const evidence = originalBlocks
    .map((block) =>
      block.kind === 'formula'
        ? block.latex
        : block.spec.type === 'table'
          ? [...block.spec.columns, ...block.spec.rows.flat()].join('')
          : block.spec.type === 'graph'
            ? block.spec.nodes.map((n) => n.label).join('')
            : '',
    )
    .join('');
  const nativeRowCovers = (point: string) => {
    const segments = point
      .split(/[：:；;，,]/u)
      .map(canon)
      .filter(Boolean);
    return originalBlocks.some((block) => {
      if (block.kind !== 'scientific-diagram' || block.spec.type !== 'table') return false;
      const spec = block.spec;
      return spec.rows.some(
        (row) =>
          segments.length > 1 &&
          segments[0] === canon(row[0]) &&
          segments.slice(1).every((segment) =>
            row.slice(1).some((value, i) => {
              const header = spec.columns[i + 1];
              const labels = [
                header,
                header.split(/\s/u)[0],
                header.replaceAll(/[（(][^）)]*[）)]/gu, ''),
              ];
              return (
                segment === canon(String(value)) ||
                labels.some((label) => segment === canon(label + String(value)))
              );
            }),
          ),
      );
    });
  };
  const pointRecords = (input.exhibitCopy ?? input.approvedContent ?? [])
    .map((point) => {
      const preferred =
        units.find(
          (unit) =>
            unit.kind === 'formula' &&
            point.includes((unit.block as Extract<SemanticBlock, { kind: 'formula' }>).latex),
        ) ??
        (/^(?:模拟)?(?:曲线|坐标|采样数据|plot|chart)[：:]/iu.test(point)
          ? units.find((u) => u.kind === 'chart')
          : undefined) ??
        (/^(?:图片|图像|照片)[：:与]/u.test(point) &&
        units.filter((u) => u.kind === 'image').length === 1
          ? units.find((u) => u.kind === 'image')
          : undefined);
      let value = point;
      for (const block of originalBlocks)
        if (block.kind === 'formula')
          value = value.replaceAll(`$${block.latex}$`, '').replaceAll(block.latex, '');
      value = value
        .trim()
        .replaceAll(/([：:])\s*[；;]/gu, '$1')
        .replaceAll(/^[：:；;，,\s]+|[：:；;，,\s]+$/gu, '');
      return { value, preferred: preferred?.id };
    })
    .filter(
      ({ value }) =>
        value &&
        canon(value) !== canon(input.title) &&
        !canon(evidence).includes(canon(value)) &&
        !nativeRowCovers(value),
    );
  const candidates = input.capsules.filter(
    (c) =>
      c.kind === 'layout' &&
      c.designReference?.slots?.some((s) => s.kind === 'title') &&
      (style ||
        (c.source.evidencePages?.length &&
          c.designReference?.slots?.some((s) => s.kind === 'picture'))) &&
      (!c.source.aspectRatio ||
        Math.abs(
          Number(c.source.aspectRatio.split(':')[0]) / Number(c.source.aspectRatio.split(':')[1]) -
            system.width / system.height,
        ) < 0.001),
  );
  type Result = {
    layout: CapabilityCapsule;
    heading: Slot;
    parts: string[];
    blocks: SemanticBlock[];
    assignments: object[];
    slotIds: string[];
    headerBottom: number;
    top: number;
    bottom: number;
    sourceBottom: number;
    score: number;
    peerBaseline?: number;
    extended?: boolean;
  };
  let best: Result | undefined;
  let hasCompatibleLane = false;
  for (const layout of candidates) {
    const slots = layout.designReference!.slots!,
      heading = slots.find((s) => s.kind === 'title')!;
    const lanes = slots.filter((s) => ['object', 'picture', 'table', 'chart'].includes(s.kind));
    if (!lanes.length) continue;
    const titleBox = boxOf(heading, system),
      titleSize = Math.max(30, Math.min(36, heading.fontSize ?? 32));
    let titleLines: string[];
    try {
      titleLines = learnedTextLines(
        input.title,
        titleBox.width,
        titleSize,
        system.fontFamily,
        true,
      );
    } catch {
      continue;
    }
    const headerBottom = titleBox.y + titleLines.length * titleSize * 1.35;
    const bodySlots = slots.filter((s) => s.kind === 'body');
    // Keep vertically paired image/caption slots together, using the union of
    // their source bands rather than leaving a transparent image viewport gap.
    const pairedBodies = new Map(
      lanes.flatMap((lane, i) => {
        if (lane.kind !== 'picture') return [];
        const body = bodySlots.find(
          (b) =>
            b.box.y >= lane.box.y + lane.box.height - 0.001 &&
            Math.min(b.box.x + b.box.width, lane.box.x + lane.box.width) -
              Math.max(b.box.x, lane.box.x) >=
              Math.min(b.box.width, lane.box.width) * 0.8,
        );
        return body ? [[i, body] as const] : [];
      }),
    );
    const target = units.map((unit) =>
      lanes.flatMap((slot, index) => {
        const typed =
          unit.kind === 'image'
            ? slot.kind === 'picture'
            : unit.kind === 'table'
              ? slot.kind === 'table'
              : unit.kind === 'chart'
                ? slot.kind === 'chart'
                : false;
        return (typed || slot.kind === 'object') && slot.box.width * system.width >= unit.minWidth
          ? [index]
          : [];
      }),
    );
    if (target.some((t) => !t.length)) continue;
    hasCompatibleLane = true;
    let attempts = 0;
    const evaluate = (assignment: number[]) => {
      if (++attempts > 500) return;
      const groups = lanes.map((_, index) => units.filter((__, i) => assignment[i] === index));
      if (groups.some((g, i) => lanes[i].kind !== 'object' && g.length > 1)) return;
      const parts = [
          learnedTextSvg(titleLines, titleBox.x, titleBox.y, titleSize, system.colors.text, true),
        ],
        blocks: SemanticBlock[] = [],
        bindings: object[] = [];
      const used = new Set<string>([heading.id]);
      const occupied: Box[] = [];
      let bottom = headerBottom,
        firstTop = Infinity,
        sourceBottom = 0;
      let peerBaseline: number | undefined;
      let extended = false;
      // A generic content placeholder alongside a single chart/table can carry
      // its commentary. The placement solver has already reserved the exhibit.
      const copySlots =
        input.exhibitCopy && !bodySlots.length
          ? lanes.filter((slot, i) => slot.kind === 'object' && !groups[i].length)
          : bodySlots;
      const pointGroups = Array.from(
        { length: copySlots.length || units.length },
        () => [] as string[],
      );
      const text = (values: string[], width: number) =>
        values.map((value) => ({
          value,
          lines: learnedTextLines(value, width, 24, system.fontFamily),
          width,
        }));
      const textHeight = (values: ReturnType<typeof text>) =>
        values.reduce((n, v) => n + v.lines.length * 32.4, 0) + Math.max(0, values.length - 1) * 12;
      const paintText = (values: ReturnType<typeof text>, x: number, y: number) => {
        let cursor = y;
        for (const value of values) {
          const content = learnedTextSvg(value.lines, x, cursor, 24, system.colors.text);
          parts.push(
            input.exhibitCopy
              ? `<g data-source-paragraph="${escapeSvgText(value.value)}" data-source-width="${value.width}">${content}</g>`
              : content,
          );
          cursor += value.lines.length * 32.4 + 12;
        }
        return values.length ? cursor - 12 : y;
      };
      const available = (slot: Slot) => {
        const r = boxOf(slot, system);
        const crossesTitle = r.x < titleBox.x + titleBox.width && r.x + r.width > titleBox.x;
        const top = crossesTitle ? Math.max(r.y, headerBottom + 24) : r.y;
        return { ...r, y: top, height: Math.min(r.y + r.height, system.height - 48) - top };
      };
      try {
        if (copySlots.length || !pointRecords.some((p) => p.preferred)) {
          pointRecords.forEach((p, i) =>
            pointGroups[
              Math.min(
                pointGroups.length - 1,
                Math.floor((i * pointGroups.length) / Math.max(1, pointRecords.length)),
              )
            ].push(p.value),
          );
        } else {
          for (const p of pointRecords.filter((p) => p.preferred))
            pointGroups[units.findIndex((u) => u.id === p.preferred)].push(p.value);
          for (const p of pointRecords.filter((p) => !p.preferred)) {
            const costs = units.map((_, i) => {
              const lane = assignment[i];
              const r = available(lanes[lane]);
              return units.reduce(
                (total, unit, index) => {
                  if (assignment[index] !== lane) return total;
                  const height =
                    unit.kind === 'image'
                      ? Math.min(r.height * 0.6, (r.width * unit.size!.height) / unit.size!.width)
                      : unit.minHeight!(r.width);
                  const points =
                    index === i ? [...pointGroups[index], p.value] : pointGroups[index];
                  return (
                    total + height + (points.length ? 18 + textHeight(text(points, r.width)) : 0)
                  );
                },
                (groups[lane].length - 1) * 20,
              );
            });
            pointGroups[costs.indexOf(Math.min(...costs))].push(p.value);
          }
        }
        type Allocation = {
          slot: Slot;
          r: Box;
          captionBox?: Box;
          cells: {
            unit: Unit;
            caption: ReturnType<typeof text>;
            height: number;
            evidenceHeight: number;
          }[];
          height: number;
        };
        const allocations: Allocation[] = [];
        for (const [i, group] of groups.entries()) {
          if (!group.length) continue;
          const slot = lanes[i],
            pairedBody = pairedBodies.get(i),
            captionBox = pairedBody ? boxOf(pairedBody, system) : undefined,
            r = available(slot);
          if (captionBox) {
            r.height = Math.min(captionBox.y + captionBox.height, system.height - 48) - r.y;
            used.add(pairedBody!.id);
          }
          if (r.height <= 0) return;
          used.add(slot.id);
          sourceBottom = Math.max(sourceBottom, r.y + r.height);
          const demands = group.map((unit) => {
            const caption = pairedBody
              ? text(pointGroups[copySlots.indexOf(pairedBody)], captionBox!.width)
              : copySlots.length
                ? []
                : text(pointGroups[units.indexOf(unit)], r.width);
            return {
              unit,
              caption,
              captionHeight: textHeight(caption) + (caption.length ? 18 : 0),
              fixedHeight: unit.kind === 'image' ? 0 : unit.minHeight!(r.width),
            };
          });
          const gaps = Math.max(0, group.length - 1) * 20;
          const imageCount = demands.filter(({ unit }) => unit.kind === 'image').length;
          const imageBudget = imageCount
            ? (r.height -
                gaps -
                demands.reduce(
                  (sum, demand) => sum + demand.captionHeight + demand.fixedHeight,
                  0,
                )) /
              imageCount
            : 0;
          const cells = demands.map(({ unit, caption, captionHeight, fixedHeight }) => {
            const h =
              unit.kind === 'image'
                ? Math.min((r.width * unit.size!.height) / unit.size!.width, imageBudget)
                : input.exhibitCopy && unit.kind === 'chart'
                  ? Math.max(fixedHeight, r.height - captionHeight)
                  : fixedHeight;
            if (h <= 0 || (unit.kind === 'image' && h < 48)) return undefined;
            return {
              unit,
              caption,
              height: h + captionHeight,
              evidenceHeight: h,
            };
          });
          if (cells.some((c) => !c)) return;
          const height = cells.reduce((n, c) => n + c!.height, 0) + gaps;
          if (height > r.height + 0.1) {
            if (height > system.height - 48 - r.y) return;
            r.height = height;
            extended = true;
          }
          allocations.push({
            slot,
            r,
            captionBox,
            cells: cells.flatMap((c) => (c ? [c] : [])),
            height,
          });
        }
        const peer =
          allocations.length > 1 &&
          allocations.every(
            (a) =>
              a.cells.length === 1 &&
              a.cells[0].unit.kind === allocations[0].cells[0].unit.kind &&
              ['image', 'formula'].includes(a.cells[0].unit.kind),
          ) &&
          Math.max(...allocations.map((a) => a.r.y)) - Math.min(...allocations.map((a) => a.r.y)) <
            1 &&
          Math.max(...allocations.map((a) => a.r.y + a.r.height)) -
            Math.min(...allocations.map((a) => a.r.y + a.r.height)) <
            1;
        let shared: { top: number; bottom: number; captionTop: number } | undefined;
        if (peer) {
          const start = Math.max(...allocations.map((a) => a.r.y)),
            end = Math.min(...allocations.map((a) => a.r.y + a.r.height));
          const captionHeight = Math.max(...allocations.map((a) => textHeight(a.cells[0].caption))),
            gap = captionHeight ? 18 : 0;
          if (allocations[0].cells[0].unit.kind === 'image')
            for (const a of allocations)
              a.cells[0].evidenceHeight = Math.min(
                a.cells[0].evidenceHeight,
                end - start - captionHeight - gap,
              );
          const evidenceHeight = Math.max(...allocations.map((a) => a.cells[0].evidenceHeight));
          if (
            (allocations[0].cells[0].unit.kind === 'image'
              ? evidenceHeight < 48
              : evidenceHeight <= 0) ||
            evidenceHeight + captionHeight + gap > end - start + 0.1
          )
            return;
          const top = start + (end - start - evidenceHeight - captionHeight - gap) / 2;
          shared = { top, bottom: top + evidenceHeight, captionTop: top + evidenceHeight + gap };
          peerBaseline = shared.captionTop;
        }
        for (const { slot, r, captionBox, cells, height } of allocations) {
          let y = shared
            ? cells[0].unit.kind === 'image'
              ? shared.bottom - cells[0].evidenceHeight
              : shared.top + (shared.bottom - shared.top - cells[0].evidenceHeight) / 2
            : r.y + (r.height - height) / 2;
          const top = y;
          for (const cell of cells) {
            const { unit, caption, evidenceHeight } = cell!;
            const rect = { x: r.x, y, width: r.width, height: evidenceHeight };
            if (unit.kind === 'image') {
              const factor = Math.min(
                rect.width / unit.size!.width,
                rect.height / unit.size!.height,
              );
              const fitted = {
                x: rect.x + (rect.width - unit.size!.width * factor) / 2,
                y: rect.y + (rect.height - unit.size!.height * factor) / 2,
                width: unit.size!.width * factor,
                height: unit.size!.height * factor,
              };
              parts.push(
                `<image id="learned-${unit.id}" x="${fitted.x}" y="${fitted.y}" width="${fitted.width}" height="${fitted.height}" preserveAspectRatio="xMidYMid meet" href="${escapeSvgText(unit.href!)}"/>`,
              );
              bindings.push({
                id: unit.id,
                kind: unit.kind,
                slotId: slot.id,
                rect: fitted,
                intrinsic: unit.size,
              });
            } else {
              blocks.push({ ...unit.block!, rect });
              parts.push(`<g data-content-id="${unit.id}"/>`);
              bindings.push({ id: unit.id, kind: unit.kind, slotId: slot.id, rect });
            }
            y += evidenceHeight;
            if (caption.length)
              y = paintText(caption, captionBox?.x ?? r.x, shared?.captionTop ?? y + 18);
            y += 20;
          }
          const actualBottom = shared ? y - 20 : top + height;
          occupied.push({ x: r.x, y: top, width: r.width, height: actualBottom - top });
          bottom = Math.max(bottom, actualBottom);
          firstTop = Math.min(firstTop, top);
        }
        for (const [i, slot] of copySlots.entries()) {
          if ([...pairedBodies.values()].includes(slot)) continue;
          const values = text(pointGroups[i], slot.box.width * system.width);
          if (!values.length) continue;
          const r = available(slot),
            height = textHeight(values);
          if (height > r.height + 0.1) return;
          const y = r.y + (r.height - height) / 2;
          paintText(values, r.x, y);
          used.add(slot.id);
          occupied.push({ ...r, y, height });
          bottom = Math.max(bottom, y + height);
          firstTop = Math.min(firstTop, y);
          sourceBottom = Math.max(sourceBottom, r.y + r.height);
        }
      } catch {
        return;
      }
      for (let i = 0; i < occupied.length; i++)
        for (let j = i + 1; j < occupied.length; j++) {
          const a = occupied[i],
            b = occupied[j];
          if (
            Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 &&
            Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1
          )
            return;
        }
      const mismatch = units.reduce(
        (n, u, i) => n + (u.kind === 'image' && lanes[assignment[i]].kind !== 'picture' ? 1 : 0),
        0,
      );
      const retainedImageSize = bindings.reduce((total, binding) => {
        const part = binding as { kind: string; rect: Box };
        return total + (part.kind === 'image' ? part.rect.height / system.height : 0);
      }, 0);
      const score =
        mismatch * 100 +
        (input.exhibitCopy && groups.some((g, i) => g[0]?.kind === lanes[i].kind) ? -24 : 0) +
        (slots.length - used.size) * 12 +
        groups.reduce((n, g) => n + Math.max(0, g.length - 1) * 5, 0) +
        -retainedImageSize * 120 +
        Math.max(0, headerBottom - titleBox.y - titleBox.height) * 0.2;
      if (!best || score < best.score)
        best = {
          layout,
          heading,
          parts,
          blocks,
          assignments: bindings,
          slotIds: [...used],
          headerBottom,
          top: firstTop,
          bottom,
          sourceBottom,
          score,
          peerBaseline,
          extended,
        };
    };
    const search = (path: number[]) => {
      if (attempts > 500) return;
      if (path.length === units.length) {
        evaluate(path);
        return;
      }
      for (const lane of target[path.length]) search([...path, lane]);
    };
    search([]);
  }
  if (!best) {
    if (input.exhibitCopy && !hasCompatibleLane) return skip('no-compatible-source-layout');
    return skip(style ? 'media-content-exceeds-source-capacity' : 'no-compatible-media-style');
  }
  const result = best as Result;
  const receipt = {
    schemaVersion: 1,
    layoutCapsuleId: result.layout.id,
    sourceDigest: result.layout.source.sourceDigest,
    observation: result.layout.source.templateId
      ? {
          templateId: result.layout.source.templateId,
          versionId: result.layout.source.versionId,
          pages: result.layout.source.evidencePages,
        }
      : undefined,
    ...(style
      ? { styleCapsuleId: style.id, visualStyle: style.designReference!.style!.id }
      : { layoutOnly: true as const }),
    slotIds: result.slotIds,
    assignments: result.assignments,
    adaptations: [
      ...(input.exhibitCopy
        ? ['source evidence slot and measured source commentary']
        : ['typed source lanes for heterogeneous objects']),
      ...(units.some((unit) => unit.kind === 'formula')
        ? ['intrinsic formula measurement without algebra changes']
        : []),
      ...(units.some((unit) => unit.kind === 'image')
        ? ['source media aspect ratios preserved']
        : []),
      ...(units.some((unit) => unit.kind === 'chart')
        ? ['source-aligned chart with preserved series']
        : []),
      'content groups centered within source bands',
      'shared deck typography and footer',
      ...(!style ? ['preserved deck styling while borrowing measured picture geometry'] : []),
      ...(result.peerBaseline === undefined ? [] : ['aligned peer evidence and caption baselines']),
      ...(result.extended ? ['source lane extended into measured footer clearance'] : []),
    ],
    metrics: {
      peerBaseline: result.peerBaseline,
      headerBottom: result.headerBottom,
      evidenceTop: result.top,
      evidenceBottom: result.bottom,
      contentBottom: result.bottom,
      sourceEvidenceBottom: result.sourceBottom,
      canvasHeight: system.height,
    },
  };
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" lang="zh-CN" viewBox="0 0 ${system.width} ${system.height}" font-family="${escapeSvgText(system.fontFamily)}"><rect id="learned-background" data-pptx-role="background" width="${system.width}" height="${system.height}" fill="${system.colors.background}"/>${result.parts.join('')}${learnedFooter(system, input.pageNumber, input.totalPages)}</svg>`,
    blocks: result.blocks,
    receipt,
    uses: [
      {
        capsuleId: result.layout.id,
        reason: 'Packed measured native objects and intact media into observed source slots.',
      },
      ...(style
        ? [
            {
              capsuleId: style.id,
              reason: 'Applied one deck typography, palette and sparse surface grammar.',
            },
          ]
        : []),
    ],
  };
}
