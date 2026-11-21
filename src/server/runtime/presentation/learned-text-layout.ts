import { selectedLayoutStyle } from './selected-style-layout';
import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { CapabilityCapsule } from './capability-memory';
import { PRESENTATION_CONTENT_BUDGET } from './content-intent';
import type { DeckVisualSystem } from './deck-visual-system';
import { learnedFooter, learnedTextLines, learnedTextSvg } from './learned-layout-primitives';
import { escapeSvgText, type SemanticBlock } from './semantic-blocks';

/** Execute real parallel source slots. Group boundaries come from approved
 * points, not the author's incidental SVG coordinates or source sample labels. */
export function compileLearnedTextLayout(input: {
  svg: string;
  title: string;
  capsules: CapabilityCapsule[];
  system: DeckVisualSystem;
  approvedContent?: string[];
  pageNumber?: number;
  totalPages?: number;
  onSkip?: (reason: string) => void;
}) {
  const skip = (reason: string) => {
    input.onSkip?.(reason);
    return undefined;
  };
  const { system } = input;
  const points = input.approvedContent?.filter((point) => point.trim());
  if (!points?.length) return skip('text-layout-needs-approved-groups');
  const document = parseString(input.svg);
  if (document.getElementsByTagName('image').length || document.getElementsByTagName('path').length)
    return skip('complex-text-artwork');
  const style = input.capsules.find(
    (c) => c.kind === 'style' && (selectedLayoutStyle(c, system) || c.designReference?.style?.grid),
  );
  if (!style) return skip('no-compatible-text-style');
  const label = /^([^：:]{1,40})[：:]([\s\S]+)$/u;
  // An unlabelled conclusion following two or more parallel labelled facts
  // belongs to the whole row. Give it a full-width band underneath the slots.
  const hasTakeaway =
    points.length >= 3 &&
    !label.test(points.at(-1)!) &&
    points.slice(0, -1).every((point) => label.test(point));
  const takeaway = hasTakeaway ? points.at(-1) : undefined;
  const groups = hasTakeaway ? points.slice(0, -1) : points;
  const candidates = input.capsules.filter(
    (c) =>
      c.kind === 'layout' &&
      c.layout?.roles.some((role) => role === 'comparison' || role === 'content') &&
      (!c.source.aspectRatio ||
        Math.abs(
          Number(c.source.aspectRatio.split(':')[0]) / Number(c.source.aspectRatio.split(':')[1]) -
            system.width / system.height,
        ) < 0.001) &&
      c.designReference?.slots?.some((s) => s.kind === 'title') &&
      c.designReference.slots.filter((s) => s.kind === 'object').length === groups.length,
  );
  if (!candidates.length) return skip('no-compatible-text-source-layout');
  const preferred = selectedLayoutStyle(style, system)?.textLayout;
  const layout =
    candidates.find((candidate) => candidate.source.workspaceId === preferred) ??
    candidates.sort((a, b) => a.id.localeCompare(b.id))[0];
  const slots = layout.designReference!.slots!;
  const heading = slots.find((s) => s.kind === 'title')!;
  const columns = slots
    .filter((s) => s.kind === 'object')
    .sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y);
  // Only parallel, disjoint object slots are supported here; charts and
  // stacked narratives must not be flattened into columns by a receipt.
  if (
    columns.some(
      (slot, i) => i && slot.box.x < columns[i - 1].box.x + columns[i - 1].box.width - 0.001,
    )
  )
    return skip('unsupported-text-slot-topology');
  const parts: string[] = [];
  const paint = (
    value: string,
    x: number,
    y: number,
    width: number,
    size: number,
    bold = false,
  ) => {
    const lines = learnedTextLines(value, width, size, system.fontFamily, bold);
    parts.push(learnedTextSvg(lines, x, y, size, system.colors.text, bold));
    return y + lines.length * size * 1.35;
  };
  const x = Math.round(heading.box.x * system.width),
    width = Math.round(heading.box.width * system.width);
  let headerBottom: number, contentBottom: number, evidenceTop: number;
  const columnGroups: Array<{
    start: number;
    end: number;
    top: number;
    bottom: number;
    limit: number;
    x: number;
    width: number;
  }> = [];
  try {
    const takeawayHeight = takeaway
      ? learnedTextLines(takeaway, width, 24, system.fontFamily).length * 24 * 1.35 + 24
      : 0;
    const columnLimit = (slot: (typeof columns)[number]) =>
      Math.min(system.height - 48 - takeawayHeight, (slot.box.y + slot.box.height) * system.height);
    headerBottom = paint(
      input.title,
      x,
      heading.box.y * system.height,
      width,
      Math.max(30, Math.min(36, heading.fontSize ?? 32)),
      true,
    );
    contentBottom = headerBottom;
    for (const [index, slot] of columns.entries()) {
      const start = parts.length;
      const left = Math.round(slot.box.x * system.width),
        available = Math.round(slot.box.width * system.width);
      const titleSlot = slots.find(
        (s) => s.kind === 'body' && Math.abs(s.box.x - slot.box.x) < 0.03 && s.box.y < slot.box.y,
      );
      const match = groups[index].match(label);
      let cursor = Math.max(headerBottom + 32, (titleSlot?.box.y ?? slot.box.y) * system.height);
      const groupTop = cursor;
      const labelledDetail = match?.[2].match(/^([^—]{1,16})——(.+)$/u);
      if (match) {
        const heading = labelledDetail ? `${match[1]} · ${labelledDetail[1]}` : match[1];
        cursor = paint(heading, left, cursor, available, 24, true) + 18;
      } else if (titleSlot) cursor = Math.max(cursor, slot.box.y * system.height);
      const body = labelledDetail?.[2] ?? match?.[2] ?? groups[index];
      for (const paragraph of body.split(/[；\n]/u).filter(Boolean))
        cursor =
          paint(
            paragraph,
            left,
            cursor,
            available,
            Math.max(
              PRESENTATION_CONTENT_BUDGET.minBodyFontSize,
              Math.min(28, slot.fontSize ?? 24),
            ),
          ) + 16;
      cursor -= 16;
      if (cursor > columnLimit(slot)) return skip('content-exceeds-source-capacity');
      contentBottom = Math.max(contentBottom, cursor);
      columnGroups.push({
        start,
        end: parts.length,
        top: groupTop,
        bottom: cursor,
        limit: columnLimit(slot),
        x: left,
        width: available,
      });
    }
    // One common shift preserves the parallel heading baseline while balancing
    // the actual content against the available source band on sparse pages.
    const sparse = columnGroups.length > 1 && columnGroups.every((g) => g.bottom - g.top < 84);
    const shift = sparse
      ? 0
      : Math.max(0, Math.min(...columnGroups.map((g) => g.limit - g.bottom)) / 2);
    for (const group of columnGroups)
      for (let i = group.start; i < group.end; i++)
        parts[i] = parts[i].replaceAll(/ y="([\d.]+)"/gu, (_, y) => ` y="${Number(y) + shift}"`);
    if (sparse)
      for (const group of columnGroups)
        parts.push(
          `<line x1="${group.x}" y1="${group.top - 10}" x2="${group.x + group.width}" y2="${group.top - 10}" stroke="${system.colors.primary}" stroke-width="1"/>`,
        );
    contentBottom += shift;
    if (takeaway) contentBottom = paint(takeaway, x, contentBottom + 24, width, 24);
    evidenceTop = Math.min(...columnGroups.map((g) => g.top)) + shift;
  } catch {
    return skip('content-exceeds-source-capacity');
  }
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
    styleCapsuleId: style.id,
    visualStyle: style.designReference!.style!.id,
    slotIds: [
      heading.id,
      ...columns.map((s) => s.id),
      ...slots.filter((s) => s.kind === 'body').map((s) => s.id),
    ],
    adaptations: [
      'approved parallel content groups',
      ...(takeaway ? ['shared conclusion below parallel groups'] : []),
      'source column topology',
      'measured text without font shrinking',
      'source grid anchors',
      'shared content-aware vertical balance',
    ],
    metrics: {
      headerBottom,
      evidenceTop,
      evidenceBottom: contentBottom,
      contentBottom,
      sourceEvidenceBottom: Math.max(
        ...columns.map((s) => (s.box.y + s.box.height) * system.height),
      ),
      canvasHeight: system.height,
    },
  };
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" lang="zh-CN" viewBox="0 0 ${system.width} ${system.height}" font-family="${escapeSvgText(system.fontFamily)}"><rect id="learned-background" data-pptx-role="background" width="${system.width}" height="${system.height}" fill="${system.colors.background}"/>${parts.join('')}${learnedFooter(system, input.pageNumber, input.totalPages)}</svg>`,
    blocks: [] as SemanticBlock[],
    receipt,
    uses: [
      {
        capsuleId: layout.id,
        reason: 'Compiled approved parallel facts into measured source object slots.',
      },
      {
        capsuleId: style.id,
        reason: 'Applied source typography and grid without restoring source placeholder panels.',
      },
    ],
  };
}
