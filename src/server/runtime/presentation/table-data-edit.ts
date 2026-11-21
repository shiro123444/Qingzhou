import { z } from 'zod';

import type {
  PresentationJobInput,
  PresentationMessageInput,
  PresentationPlan,
} from '../../../../packages/runtime-contracts/src';
import { diagramSourceSpan } from '../../../../packages/utils/src/presentationAnnotation';
import { prepareNativeDataExport } from './native-data-export';
import { layoutReportTable, reportTableSchema } from './report-table';
import { renderScientificDiagram, semanticBlockSchema } from './semantic-blocks';

export const tableDataPatchSchema = z
  .object({
    blockId: z.string().regex(/^[\w-]{1,80}$/u),
    expectedVersionId: z.string().min(1).max(128),
    columns: reportTableSchema.shape.columns,
    rows: reportTableSchema.shape.rows,
  })
  .strict();

type TableDataPatch = z.infer<typeof tableDataPatchSchema>;
const invalid = (message: string) =>
  Object.assign(new Error(message), { code: 'PRESENTATION_INVALID' });

export function assertTableDataPatchTarget(
  plan: PresentationPlan | undefined,
  target: PresentationMessageInput['target'],
  patch: TableDataPatch,
) {
  const index = target.type === 'slide' ? target.slideNumber - 1 : -1;
  const slide = plan?.slides[index];
  const raw = slide?.metadata?.contentBlocks;
  const matches = Array.isArray(raw) ? raw.filter((block) => block?.id === patch.blockId) : [];
  const parsed = matches.length === 1 ? semanticBlockSchema.safeParse(matches[0]) : undefined;
  if (
    !plan ||
    !slide ||
    !parsed?.success ||
    parsed.data.kind !== 'scientific-diagram' ||
    parsed.data.spec.type !== 'table'
  )
    throw invalid('此页没有带完整源数据的可编辑表格');
  const block = parsed.data;
  const table = parsed.data.spec;
  if (
    patch.columns.length !== table.columns.length ||
    patch.rows.length !== table.rows.length ||
    patch.rows.some((row) => row.length !== table.columns.length)
  )
    throw invalid('请保留原表格的行数和列数');
  const span = diagramSourceSpan(slide.svg, patch.blockId);
  const native = prepareNativeDataExport(plan.slides)[index].tables.some(
    (t) => t.blockId === patch.blockId,
  );
  if (!span || !native)
    throw invalid('此版本的表格预览与原生数据无法对应，请重新打开支持编辑的原生表格');

  const scale = block.canvasScale ?? 1;
  const current = layoutReportTable(table, block.rect.width / scale, block.rect.height / scale);
  const fixedGrid = {
    widths: current.widths,
    heights: current.heights,
    verticalPadding: current.verticalPadding,
  };
  const updated = {
    ...block,
    spec: { ...table, columns: patch.columns, rows: patch.rows, fixedGrid },
  };
  let group: string;
  try {
    group = renderScientificDiagram(updated);
    const membership = slide.svg
      .slice(span.start, span.end)
      .split('>')[0]
      .match(/ data-canvas-group="(canvas-group-[a-f0-9]{16}(?: canvas-group-[a-f0-9]{16})*)"/u);
    if (membership) group = group.replace('<g ', '<g' + membership[0] + ' ');
  } catch (error) {
    const detail =
      error instanceof Error && error.message.startsWith('第 ')
        ? error.message
        : '修改后的文字放不进原有单元格，请缩短文字';
    throw invalid(detail);
  }
  const revised = {
    ...slide,
    svg: slide.svg.slice(0, span.start) + group + slide.svg.slice(span.end),
    metadata: {
      ...slide.metadata,
      contentBlocks: (raw as { id?: string }[]).map((item) =>
        item?.id === patch.blockId ? updated : item,
      ),
    },
  };
  if (!prepareNativeDataExport([revised])[0].tables.some((item) => item.blockId === patch.blockId))
    throw invalid('原表格内没有足够空间容纳修改后的内容，请缩短单元格文字');
  return { index, revised };
}

export function applyTableDataPatch(
  plan: PresentationPlan,
  input: PresentationJobInput,
  message: Pick<PresentationMessageInput, 'tableDataPatch' | 'target'>,
) {
  const patch = tableDataPatchSchema.parse(message.tableDataPatch);
  const { index, revised } = assertTableDataPatchTarget(plan, message.target, patch);
  return {
    input,
    slideId: revised.slideId,
    plan: { ...plan, slides: plan.slides.map((slide, i) => (i === index ? revised : slide)) },
  };
}
