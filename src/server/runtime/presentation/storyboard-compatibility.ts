import { selectedLayoutStyle } from './selected-style-layout';
import type {
  PresentationJobInput,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import {
  approvedReportColumns,
  describesReportTable,
  readApprovedReportRows,
} from './approved-report-data';
import type { CapabilityCapsule } from './capability-memory';
import { isRasterVisual, readContentIntents, visualRequirements } from './content-intent';
import { readDeckVisualSystem } from './deck-visual-system';
import { designFingerprint, designReferencePayload } from './design-evidence';
import { measureFormula } from './formula-renderer';
import { learnedTextLines } from './learned-layout-primitives';
import type { MultimodalChatPort } from './multimodal-chat-provider';
import { layoutReportTable } from './report-table';
import { completeStructuredJson } from './structured-json-chat';

type Unit = {
  kind: 'picture' | 'formula' | 'table' | 'chart' | 'graph' | 'object';
  width: number;
  height: number;
};
export interface StoryboardPageCompatibility {
  readonly layoutIds: readonly string[];
  readonly preferredLayoutId?: string;
  readonly requirements: readonly Unit[];
  readonly slideId: string;
}

export interface StoryboardCompatibility {
  readonly inputVersion: string;
  readonly pages: readonly StoryboardPageCompatibility[];
  readonly previousStyleId?: string;
  readonly schemaVersion: 1;
  readonly styleId?: string;
}

export const isExhaustedLearnedLayout = (evidence: string) =>
  /^Learned layout compilation failed: (?:.*capacity|source-slots-incomplete)$/u.test(evidence);

const measuredStyle = (capsule: CapabilityCapsule) => {
  const style = capsule.designReference?.style;
  return capsule.kind === 'style' && Boolean(style?.flat || style?.grid || style?.sparseDecoration);
};

/** A necessary structural check. Final compilation still measures the authored
 * blocks and actual image bytes, which may be larger than this reservation. */
export async function checkStoryboardCompatibility(
  input: PresentationJobInput,
  selected: CapabilityCapsule[],
  alternatives: CapabilityCapsule[],
): Promise<StoryboardCompatibility | undefined> {
  const system = readDeckVisualSystem(input);
  const intents = readContentIntents(input);
  if (
    system?.schemaVersion !== 3 ||
    !selected.length ||
    !intents.length ||
    input.options?.lessonPlan
  )
    return undefined;
  const pool = [
    ...new Map([...selected, ...alternatives].map((capsule) => [capsule.id, capsule])).values(),
  ];
  const layouts = pool.filter(
    (capsule) =>
      capsule.kind === 'layout' &&
      capsule.designReference?.slots?.length &&
      (!capsule.source.aspectRatio || capsule.source.aspectRatio === (input.aspectRatio ?? '16:9')),
  );
  const priorStyle = selected.find((capsule) => capsule.kind === 'style');
  const style =
    pool.find((capsule) => selectedLayoutStyle(capsule, system)) ??
    pool.find(
      (capsule) => measuredStyle(capsule) && capsule.designReference?.style?.background !== 'dark',
    );
  const outline = Array.isArray(input.options?.outline) ? input.options.outline : [];
  const pages: StoryboardPageCompatibility[] = [];
  for (const [index, intent] of intents.entries()) {
    const requirements: Unit[] = visualRequirements(intent)
      .filter((visual) => visual.required)
      .map((visual) => {
        if (visual.kind === 'source-figure' || isRasterVisual(visual))
          return { kind: 'picture', width: 120, height: 100 };
        if (describesReportTable(visual.brief)) return { kind: 'table', width: 280, height: 96 };
        if (
          visual.kind === 'scientific-diagram' &&
          /流程图|时间[线轴]|节点.{0,120}(?:箭头|连线)|\b(?:workflow|timeline|graph)\b/iu.test(
            visual.brief,
          )
        )
          return { kind: 'graph', width: 280, height: 96 };
        return { kind: visual.kind === 'chart' ? 'chart' : 'object', width: 280, height: 180 };
      });
    for (const formula of intent.formulas.filter((formula) => formula.placement !== 'notes')) {
      const measured = await measureFormula({
        latex: formula.latex,
        display: formula.display ?? true,
        fontSize: formula.fontSize ?? 28,
      });
      requirements.push({
        kind: 'formula',
        width: measured.minRectWidth,
        height: measured.minRectHeight,
      });
    }
    if (!requirements.length) continue;
    const title = String(outline[index]?.title ?? input.title);
    const rows = readApprovedReportRows(outline[index]?.keyPoints ?? []);
    const table = rows && {
      type: 'table' as const,
      columns: approvedReportColumns(rows),
      rows: rows.map(({ row }) => row),
      fontSize: 20,
      fontFamily: system.fontFamily,
      headerFill: system.colors.background,
    };
    const fit = (capsule: CapabilityCapsule) => {
      const slots = capsule.designReference!.slots!;
      const heading = slots.find((slot) => slot.kind === 'title');
      if (
        !heading ||
        (!style &&
          (requirements.length !== 1 ||
            requirements[0].kind !== 'picture' ||
            !capsule.source.evidencePages?.length))
      )
        return false;
      const width = system.width;
      const height = system.height;
      const font = Math.max(30, Math.min(36, heading.fontSize ?? 32));
      let headingBottom: number;
      try {
        headingBottom =
          heading.box.y * height +
          learnedTextLines(title, heading.box.width * width, font, system.fontFamily, true).length *
            font *
            1.35;
      } catch {
        return false;
      }
      const lanes = slots
        .filter((slot) => ['picture', 'table', 'chart', 'object'].includes(slot.kind))
        .map((slot) => {
          const overlapsHeading =
            slot.box.x < heading.box.x + heading.box.width &&
            slot.box.x + slot.box.width > heading.box.x;
          const top = Math.max(slot.box.y * height, overlapsHeading ? headingBottom + 24 : 0);
          return {
            kind: slot.kind,
            width: slot.box.width * width,
            height: Math.min((slot.box.y + slot.box.height) * height, height - 48) - top,
            count: 0,
          };
        });
      // A standalone native graph spans its observed sequence of node slots.
      // Media pages place their objects independently, so do not add this band
      // to a layout that also has to contain an image, formula or second graph.
      if (
        requirements.length === 1 &&
        requirements[0].kind === 'graph' &&
        capsule.layout?.roles.includes('process')
      ) {
        const nodes = slots.filter((slot) => slot.kind === 'object');
        if (nodes.length) {
          const left = Math.min(...nodes.map((slot) => slot.box.x));
          const right = Math.max(...nodes.map((slot) => slot.box.x + slot.box.width));
          const top = Math.max(
            headingBottom + 24,
            Math.min(...nodes.map((slot) => slot.box.y)) * height,
          );
          const bottom = Math.min(
            height - 48,
            Math.max(...nodes.map((slot) => slot.box.y + slot.box.height)) * height,
          );
          if (
            (right - left) * width >= requirements[0].width &&
            bottom - top >= requirements[0].height
          )
            return true;
        }
      }
      if (requirements.length > 8) return false;
      const units = [...requirements].sort((a, b) => b.width - a.width || b.height - a.height);
      let attempts = 0;
      const place = (unitIndex: number): boolean => {
        if (unitIndex === units.length) return true;
        if (++attempts > 500) return false;
        const unit = units[unitIndex];
        return lanes.some((lane) => {
          if (lane.kind !== unit.kind && !(style && lane.kind === 'object')) return false;
          if ((lane.kind !== 'object' && lane.count) || lane.width < unit.width) return false;
          let height = unit.height;
          if (unit.kind === 'table' && table) {
            try {
              height = layoutReportTable(table, lane.width).height;
            } catch {
              return false;
            }
          }
          const needed = height + (lane.count ? 20 : 0);
          if (lane.height < needed) return false;
          lane.height -= needed;
          lane.count++;
          const found = place(unitIndex + 1);
          lane.height += needed;
          lane.count--;
          return found;
        });
      };
      return place(0);
    };
    const preferred = selected.find(
      (capsule) => capsule.kind === 'layout' && !capsule.layout?.roles.includes('cover'),
    );
    const exactSlots = (capsule: CapabilityCapsule) =>
      requirements.filter((unit) =>
        unit.kind === 'graph'
          ? capsule.layout?.roles.includes('process')
          : capsule.designReference?.slots?.some((slot) => slot.kind === unit.kind),
      ).length;
    pages.push({
      slideId: intent.slideId,
      requirements,
      preferredLayoutId: preferred?.id,
      layoutIds: layouts
        .filter(fit)
        .sort((a, b) => exactSlots(b) - exactSlots(a))
        .map(({ id }) => id),
    });
  }
  if (!pages.length) return undefined;
  return {
    schemaVersion: 1,
    inputVersion: designFingerprint([
      intentLayoutInputs(input),
      designReferencePayload(pool),
      system,
    ]),
    previousStyleId: priorStyle?.id,
    styleId: style?.id,
    pages,
  };
}

export const intentLayoutInputs = (input: PresentationJobInput) => ({
  aspectRatio: input.aspectRatio,
  outline: input.options?.outline,
  intents: readContentIntents(input),
});

export function storyboardPageCapsules(
  compatibility: unknown,
  slideId: string,
  capsules: CapabilityCapsule[],
  authoredBlocks?: unknown,
): CapabilityCapsule[] {
  const report = compatibility as StoryboardCompatibility | undefined;
  const page: StoryboardPageCompatibility | undefined =
    report?.schemaVersion === 1 && Array.isArray(report.pages)
      ? report.pages.find((item) => item?.slideId === slideId)
      : undefined;
  if (!page || !Array.isArray(page.layoutIds) || !page.layoutIds.length) return capsules;
  // An existing storyboard may have reserved a chart slot before an editable
  // table was authored. Honor the actual block type without rewriting the deck
  // handoff or invalidating completed sibling pages.
  const needsTable =
    Array.isArray(authoredBlocks) &&
    authoredBlocks.some(
      (block) => block?.kind === 'scientific-diagram' && block.spec?.type === 'table',
    ) &&
    !page.requirements?.some((unit) => unit.kind === 'table');
  const needsGraph =
    Array.isArray(authoredBlocks) &&
    authoredBlocks.length === 1 &&
    authoredBlocks[0]?.kind === 'scientific-diagram' &&
    authoredBlocks[0]?.spec?.type === 'graph' &&
    !page.requirements?.some((unit) => unit.kind === 'graph');
  return capsules.filter(
    (capsule) =>
      capsule.kind !== 'layout' ||
      page.layoutIds.includes(capsule.id) ||
      (needsTable && capsule.designReference?.slots?.some((slot) => slot.kind === 'table')) ||
      (needsGraph &&
        capsule.layout?.roles.includes('process') &&
        capsule.designReference?.slots?.some((slot) => slot.kind === 'object')),
  );
}

export async function diagnoseStoryboardLayout(
  chat: MultimodalChatPort,
  evidence: unknown,
  context: { idempotencyKey: string; scope: RuntimeScope; signal?: AbortSignal },
) {
  return (
    await completeStructuredJson({
      chat,
      context,
      request: {
        messages: [
          {
            role: 'system',
            content:
              '诊断一个PPT页面在自动重选版式后仍然放不下的原因。输入只有结构证据。用JSON返回 reason 和 repairInstruction 两个短字符串。保持事实、公式、行列、图片、页数与字号。建议用于单页修复，不能发起生成或导出。',
          },
          { role: 'user', content: JSON.stringify(evidence) },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 800,
        temperature: 0,
      },
      emptyError: 'GPT 没有返回版式诊断',
      parse: (answer) => {
        const result = answer as { reason?: unknown; repairInstruction?: unknown };
        if (
          typeof result?.reason !== 'string' ||
          !result.reason.trim() ||
          typeof result.repairInstruction !== 'string' ||
          !result.repairInstruction.trim()
        )
          throw new Error('诊断结果结构无效');
        return {
          reason: result.reason.slice(0, 400),
          repairInstruction: result.repairInstruction.slice(0, 600),
        };
      },
    })
  ).value;
}
