import { useEffect, useRef } from 'react';
import type { CanvasCommand, PresentationJob } from '../../../../packages/runtime-contracts/src';

import { canvasHistory } from '../../../../packages/utils/src/presentationCanvasHistory';

type Clip = {
  job: string;
  page: number;
  version: string;
  object?: string;
  objects?: string[];
  dx?: number;
  dy?: number;
};
function pasteCommand(clip: Clip, version: string): CanvasCommand | undefined {
  if (
    Array.isArray(clip.objects) &&
    clip.objects.length > 1 &&
    clip.objects.every((id) => typeof id === 'string')
  )
    return {
      kind: 'pasteMany',
      objects: clip.objects,
      dx: clip.dx ?? 12,
      dy: clip.dy ?? 12,
      sourceVersion: clip.version,
      sourcePage: clip.page,
      expectedVersionId: version,
    };
  if (typeof clip.object === 'string')
    return {
      kind: 'paste',
      object: clip.object,
      sourceVersion: clip.version,
      sourcePage: clip.page,
      expectedVersionId: version,
    };
}
function removeCommand(ids: string[], version: string): CanvasCommand {
  return ids.length === 1
    ? { kind: 'remove', object: ids[0], expectedVersionId: version }
    : { kind: 'removeMany', objects: ids, expectedVersionId: version };
}

const mime = 'application/x-qingzhou-slide-object';
let internalClip: Clip | undefined;
export function useCanvasShortcuts(props: {
  root: React.RefObject<HTMLElement | null>;
  job?: PresentationJob;
  version?: string;
  page: number;
  selected: string[];
  pasteOffset: { dx: number; dy: number };
  canSubmit: boolean;
  send: (operation: CanvasCommand, page: number, label: string) => Promise<boolean>;
  draftUndo: (redo: boolean) => boolean;
}) {
  const latest = useRef(props);
  latest.current = props;
  type Direction = 'undo' | 'redo';
  const queue = useRef<Direction[]>([]);
  const pendingVersion = useRef<string | undefined>(undefined);
  const send = (cmd: CanvasCommand, page: number, label: string) => {
    if (pendingVersion.current) return;
    const current = latest.current;
    pendingVersion.current = cmd.expectedVersionId;
    const reject = () => {
      if (
        latest.current.job?.jobId !== current.job?.jobId ||
        pendingVersion.current !== cmd.expectedVersionId
      )
        return;
      pendingVersion.current = undefined;
      queue.current = [];
    };
    void current.send(cmd, page, label).then((ok) => {
      if (!ok) reject();
    }, reject);
  };
  const restore = (direction: Direction) => {
    const p = latest.current;
    if (!p.job || !p.version) return false;
    const step = canvasHistory(p.job)[direction].at(-1);
    if (!step) return false;
    send(
      {
        kind: 'restore',
        direction,
        operationId: step.id,
        version: direction === 'undo' ? step.before : step.after,
        expectedVersionId: p.version,
      },
      step.page,
      direction === 'undo' ? '撤销画布修改' : '重做画布修改',
    );
    return true;
  };
  const historyAction = (direction: Direction) => {
    const p = latest.current;
    if (p.draftUndo(direction === 'redo') || !p.job || !p.version) return;
    if (!p.canSubmit || pendingVersion.current) {
      // A completed pointer gesture is a single transaction, even if the next
      // key arrives while the server is still publishing its previous revision.
      if (
        p.job.state === 'running' ||
        p.job.state === 'queued' ||
        pendingVersion.current ||
        p.job.state === 'completed'
      )
        queue.current.push(direction);
      return;
    }
    restore(direction);
  };
  useEffect(() => {
    pendingVersion.current = undefined;
    queue.current = [];
  }, [props.job?.jobId]);
  useEffect(() => {
    if (props.job?.state === 'failed' || props.job?.state === 'cancelled') {
      queue.current = [];
      pendingVersion.current = undefined;
      return;
    }
    if (!props.canSubmit) return;
    if (pendingVersion.current === props.version) return;
    pendingVersion.current = undefined;
    while (queue.current.length) {
      if (restore(queue.current.shift()!)) break;
    }
  }, [props.canSubmit, props.version, props.job?.state]);
  useEffect(() => {
    function accepts(target: EventTarget | null) {
      const root = latest.current.root.current;
      if (
        !root ||
        !(target instanceof Element) ||
        target.closest(
          'input,textarea,select,[contenteditable=true],[role=dialog],[role=menu],[data-studio-layers]',
        )
      )
        return false;
      return (
        root.contains(target) ||
        Boolean(
          root.closest('[data-testid="presentation-completed-workspace"]')?.contains(target),
        ) ||
        (target === document.body && root.closest('[data-focused="true"]'))
      );
    }
    const copy = (e: ClipboardEvent) => {
      const p = latest.current;
      if (!accepts(e.target) || !p.selected.length || !p.job || !p.version || !p.canSubmit) return;
      const clip = {
        job: p.job.jobId,
        page: p.page,
        version: p.version,
        ...(p.selected.length === 1
          ? { object: p.selected[0] }
          : { objects: p.selected, ...p.pasteOffset }),
      };
      e.preventDefault();
      internalClip = clip;
      e.clipboardData?.setData(mime, JSON.stringify(clip));
      if (e.type === 'cut') send(removeCommand(p.selected, p.version), p.page, '剪切组件');
    };
    const paste = (e: ClipboardEvent) => {
      const p = latest.current;
      if (!accepts(e.target) || !p.canSubmit || !p.job || !p.version) return;
      let clip: Clip | undefined;
      const raw = e.clipboardData?.getData(mime);
      if (raw) {
        try {
          clip = JSON.parse(raw);
        } catch {
          return;
        }
      } else if (!e.clipboardData?.types.length) clip = internalClip;
      if (
        !clip ||
        clip.job !== p.job.jobId ||
        !Number.isInteger(clip.page) ||
        typeof clip.version !== 'string'
      )
        return;
      const cmd = pasteCommand(clip, p.version);
      if (!cmd) return;
      e.preventDefault();
      send(cmd, p.page, '粘贴组件');
    };
    const key = (e: KeyboardEvent) => {
      const p = latest.current;
      if (
        !accepts(e.target) ||
        e.defaultPrevented ||
        e.isComposing ||
        e.altKey ||
        !p.job ||
        !p.version
      )
        return;
      const mod = e.metaKey || e.ctrlKey,
        k = e.key.toLowerCase();
      if (mod && (k === 'z' || k === 'y')) {
        e.preventDefault();
        if (!e.repeat) historyAction(k === 'y' || e.shiftKey ? 'redo' : 'undo');
        return;
      }
      if (!p.selected.length || !p.canSubmit) return;
      if (mod && k === 'd') {
        e.preventDefault();
        if (!e.repeat)
          send(
            pasteCommand(
              {
                job: p.job.jobId,
                page: p.page,
                version: p.version,
                object: p.selected[0],
                objects: p.selected,
                ...p.pasteOffset,
              },
              p.version,
            )!,
            p.page,
            '复制组件',
          );
      }
      if (!mod && (k === 'delete' || k === 'backspace')) {
        e.preventDefault();
        if (!e.repeat) send(removeCommand(p.selected, p.version), p.page, '删除组件');
      }
    };
    document.addEventListener('copy', copy);
    document.addEventListener('cut', copy);
    document.addEventListener('paste', paste);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('copy', copy);
      document.removeEventListener('cut', copy);
      document.removeEventListener('paste', paste);
      document.removeEventListener('keydown', key);
    };
  }, []);
}
