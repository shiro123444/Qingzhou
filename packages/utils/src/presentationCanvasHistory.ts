import type { PresentationJob } from '../../runtime-contracts/src';

type Step = { id: string; before: string; after: string; page: number };
export function canvasHistory(job: Pick<PresentationJob, 'messages' | 'versionId'>) {
  const undo: Step[] = [],
    redo: Step[] = [];
  let last: string | undefined;
  for (const m of job.messages ?? []) {
    if (m.status !== 'applied' || !m.versionId) continue;
    const before = (
      m.canvasCommand ??
      m.objectPositionPatch ??
      m.tableDataPatch ??
      m.chartDataPatch ??
      (m.annotation?.textRuns ? m.annotation : undefined)
    )?.expectedVersionId;
    if (!before || m.target.type !== 'slide' || (last && last !== before)) {
      undo.length = 0;
      redo.length = 0;
    }
    last = m.versionId;
    if (!before || m.target.type !== 'slide') continue;
    const cmd = m.canvasCommand;
    if (cmd?.kind === 'restore') {
      const [from, to] = cmd.direction === 'undo' ? [undo, redo] : [redo, undo];
      if (from.at(-1)?.id === cmd.operationId) to.push(from.pop()!);
      else {
        undo.length = 0;
        redo.length = 0;
      }
    } else {
      undo.push({ id: m.requestId, before, after: m.versionId, page: m.target.slideNumber });
      redo.length = 0;
    }
  }
  if (job.versionId && last !== job.versionId) return { undo: [], redo: [] };
  return { undo, redo };
}
