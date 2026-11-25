import { sha256 } from 'js-sha256';
import { useEffect, useRef, useState } from 'react';

import { runtimeClient } from '@/services/runtime/client';

import type {
  PresentationJob,
  PresentationMessageInput,
} from '../../../../packages/runtime-contracts/src';
import { canvasAtoms } from '../../../../packages/utils/src/presentationAnnotation';
import { readEditableSlide } from '../annotation/readEditableSlide';

type Entry = {
  message: PresentationMessageInput;
  base: string;
  after?: string;
  targets: Record<string, string>;
};
type Status = 'saving' | 'offline' | 'conflict' | 'failed';
class Conflict extends Error {}

// The server may reflow a table and renumber later SVG atoms. Compare their authored
// identity before translating an index from a previous local edit to a new revision.
function canvasTargetSignature(element: Element) {
  const copy = element.cloneNode(true) as Element;
  copy.removeAttribute('transform');
  copy.removeAttribute('data-canvas-object');
  return sha256(new XMLSerializer().serializeToString(copy));
}

function objectIds(message: PresentationMessageInput) {
  const cmd = message.canvasCommand;
  if (cmd?.kind === 'translate') return [cmd.object];
  if (cmd?.kind === 'moveMany') return cmd.moves.map((m) => m.object);
  if (cmd?.kind === 'resizeGroup') return cmd.objects;
  return message.annotation?.elementIndices.map((i) => 'svg:' + i) ?? [];
}

async function prepare(entry: Entry, job: PresentationJob, version: string, signal: AbortSignal) {
  const message = structuredClone(entry.message);
  if (message.target.type !== 'slide') throw new Conflict();
  const cmd = message.canvasCommand;
  if (cmd) cmd.expectedVersionId = version;
  if (message.tableDataPatch) message.tableDataPatch.expectedVersionId = version;
  if (!message.annotation && (!entry.after || !Object.keys(entry.targets).length)) return message;
  const data = await readEditableSlide(job.jobId, message.target.slideNumber, version, signal);
  const atoms = canvasAtoms(
    new DOMParser().parseFromString(data.slide.svg, 'image/svg+xml').documentElement,
  );
  const resolve = (id: string) => {
    const signature = entry.targets[id];
    if (!signature) return id;
    const i = Number(id.slice(4));
    if (atoms[i] && canvasTargetSignature(atoms[i]) === signature) return id;
    const matches = atoms.flatMap((n, index) =>
      canvasTargetSignature(n) === signature ? [index] : [],
    );
    if (matches.length !== 1) throw new Conflict();
    return 'svg:' + matches[0];
  };
  if (cmd?.kind === 'translate') cmd.object = resolve(cmd.object);
  if (cmd?.kind === 'moveMany')
    cmd.moves.forEach((m) => {
      m.object = resolve(m.object);
    });
  if (cmd?.kind === 'resizeGroup') cmd.objects = cmd.objects.map(resolve);
  const annotation = message.annotation;
  if (annotation) {
    annotation.expectedVersionId = version;
    annotation.baseSvgHash = data.hash;
    annotation.elementIndices = annotation.elementIndices.map((i) =>
      Number(resolve('svg:' + i).slice(4)),
    );
    const b = data.boxes[annotation.elementIndices[0]];
    if (!b || annotation.slideId !== data.slide.slideId) throw new Conflict();
    annotation.region = {
      x: Math.max(0, Math.min(1, b.x + b.width / 2)),
      y: Math.max(0, Math.min(1, b.y + b.height / 2)),
      width: 0,
      height: 0,
    };
  }
  return message;
}

export function useCanvasSaveQueue(jobId: string | undefined, refresh?: () => Promise<void>) {
  const key = 'qingzhou:canvas-outbox:' + jobId;
  const [items, setItems] = useState<Entry[]>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });
  const entries = useRef(items);
  const [status, setStatus] = useState<Status>('saving');
  const [attempt, setAttempt] = useState(0);
  const reload = useRef(refresh);
  reload.current = refresh;
  const replace = (next: Entry[]) => {
    if (next.length) sessionStorage.setItem(key, JSON.stringify(next));
    else sessionStorage.removeItem(key);
    entries.current = next;
    setItems(next);
  };
  const head = items[0];
  useEffect(() => {
    if (!head || !jobId) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;
    let submitted = false;
    let rejected = false;
    let delay = 600;
    const tick = async () => {
      try {
        const job = await runtimeClient.getPresentationJob(jobId, { signal });
        if (signal.aborted) return;
        if (!job) throw new Conflict();
        const receipt = job.messages?.find((m) => m.requestId === head.message.requestId);
        if (receipt?.status === 'applied') {
          await reload.current?.();
          if (!signal.aborted) replace(entries.current.slice(1));
          return;
        }
        if (
          receipt?.status === 'failed' ||
          job.state === 'failed' ||
          job.state === 'cancelled' ||
          job.state === 'waiting_input'
        ) {
          setStatus('failed');
          return;
        }
        if (job.state === 'completed' && !receipt) {
          const expected = head.after
            ? job.messages?.find((m) => m.requestId === head.after && m.status === 'applied')
                ?.versionId
            : head.base;
          if (!expected || job.versionId !== expected) throw new Conflict();
          if (rejected) {
            setStatus('failed');
            return;
          }
          if (!submitted) {
            const message = await prepare(head, job, expected, signal);
            if (signal.aborted) return;
            try {
              await runtimeClient.sendPresentationMessage(jobId, message);
              submitted = true;
            } catch (error) {
              // A lost response can still have committed. Always check the receipt first.
              if (!(error instanceof TypeError)) rejected = true;
              throw error;
            }
          }
        }
        if (!signal.aborted) setStatus('saving');
        delay = 600;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof Conflict) {
          setStatus('conflict');
          return;
        }
        if (error instanceof Error && error.message === 'presentationAnnotation.unsupported') {
          setStatus('failed');
          return;
        }
        setStatus('offline');
        delay = Math.min(delay * 2, 8000);
      }
      if (!signal.aborted) timer = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [head, jobId, attempt, key]);

  return {
    pending: !!head,
    status,
    retry: () => setAttempt((n) => n + 1),
    discard: () => replace([]),
    enqueue(message: PresentationMessageInput, base: string, source: Document, after?: string) {
      const atoms = canvasAtoms(source.documentElement);
      const targets: Record<string, string> = {};
      for (const id of objectIds(message)) {
        if (!id.startsWith('svg:')) continue;
        const atom = atoms[Number(id.slice(4))];
        if (!atom) return false;
        targets[id] = canvasTargetSignature(atom);
      }
      try {
        replace([
          ...entries.current,
          { message, base, after: entries.current.at(-1)?.message.requestId ?? after, targets },
        ]);
        if (!head) setStatus('saving');
        return true;
      } catch {
        return false;
      }
    },
  };
}
