import { glassSelection } from '@/features/GlassMotion/selectionStyle';
import { createStaticStyles } from 'antd-style';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PresentationMessageInput } from '../../../../packages/runtime-contracts/src';
import {
  annotationDataSelection,
  canvasAtoms,
  editableTextNodes,
} from '../../../../packages/utils/src/presentationAnnotation';
import { type ElementBox, selectAnnotationElements } from '../annotation/geometry';
import { type EditableSlide, readEditableSlide } from '../annotation/readEditableSlide';
import { styles as annotationStyles } from '../annotation/style';
import type { EditableTable } from './TableDataEditor';

type Cell = {
  table: EditableTable;
  row: number;
  col: number;
  lines: number[];
  right: number;
  bottom: number;
  placeholder: ElementBox;
};
type Field = { box: ElementBox; values: string[]; cell?: Cell; activeRun: number };

function cellAt(
  data: EditableSlide,
  index: number,
  table: EditableTable,
  point: { x: number; y: number },
): Cell | undefined {
  // Older decks have no cell IDs. The native projection includes one backing rectangle
  // per row and column-aligned text, including additional lines of wrapped cells.
  const marker = data.elements[index].dataGroup;
  if (!marker || marker.kind !== 'table') return;
  const elements = data.elements.filter((e) => e.dataGroup?.start === marker.start);
  const rows = elements.filter((e) => e.tag === 'rect');
  if (rows.length !== table.rows.length + 1) return;
  const row = rows.findIndex((e) => {
    const b = data.boxes[e.index];
    return point.y >= b.y && point.y <= b.y + b.height;
  });
  if (row < 0) return;
  const x = (source: string) =>
    new DOMParser().parseFromString(source, 'image/svg+xml').documentElement.getAttribute('x');
  const headings = elements.filter(
    (e) => e.tag === 'text' && e.index < (rows[1]?.index ?? Infinity),
  );
  const columns = [...new Set(headings.map((e) => x(e.source)))];
  const headerBoxes = columns.map(
    (c) => data.boxes[headings.find((e) => x(e.source) === c)!.index],
  );
  const inset = (headerBoxes[0]?.x ?? 0) - data.boxes[rows[0].index].x;
  const col = headerBoxes.findLastIndex((b) => point.x >= b.x - inset - 0.001);
  if (row < 0 || col < 0 || columns.length !== table.columns.length) return;
  const rowBox = data.boxes[rows[row].index];
  const next = rows[row + 1]?.index ?? Infinity;
  const lines = elements
    .filter(
      (e) =>
        e.index > rows[row].index &&
        e.index < next &&
        e.tag === 'text' &&
        x(e.source) === columns[col],
    )
    .map((e) => e.index);
  return {
    row,
    col,
    table,
    lines,
    right:
      col + 1 < columns.length
        ? data.boxes[headings.find((e) => x(e.source) === columns[col + 1])!.index].x
        : rowBox.x + rowBox.width,
    bottom: rowBox.y + rowBox.height,
    placeholder: {
      ...headerBoxes[col],
      x: headerBoxes[col].x,
      y: rowBox.y + (rowBox.height - headerBoxes[col].height) / 2,
      runs: undefined,
    },
  };
}

export function useDirectCanvasEdit(
  jobId: string | undefined,
  page: number,
  versionId: string | undefined,
  enabled: boolean,
  tables: EditableTable[],
  openData: (id: string) => void,
  chartIds: string[],
) {
  const [loaded, setLoaded] = useState<{ jobId: string; page: number; data: EditableSlide }>();
  const [field, setField] = useState<Field>();
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setField(undefined);
    setEditing(false);
    setLoaded(undefined);
    if (!enabled || !jobId || !versionId) return;
    const controller = new AbortController();
    void readEditableSlide(jobId, page, versionId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setLoaded({ jobId, page, data });
      })
      .catch(() => {
        /* Slides without measurable SVG retain their normal preview and object editor. */
      });
    return () => controller.abort();
  }, [jobId, page, versionId, enabled]);
  const data =
    enabled &&
    loaded?.jobId === jobId &&
    loaded?.page === page &&
    loaded?.data.versionId === versionId
      ? loaded?.data
      : undefined;
  const hit = (point: { x: number; y: number }, activate: boolean) => {
    if (!data) return false;
    const [index] = selectAnnotationElements(data.boxes, { ...point, width: 0, height: 0 });
    const el = data.elements[index];
    const box = data.boxes[index];
    const clear = () => {
      setEditing(false);
      setField(undefined);
    };
    if (!el || !box) {
      clear();
      return false;
    }
    const target = annotationDataSelection(
      data.elements,
      [index],
      data.slide.metadata?.contentBlocks,
    );
    let cell: Cell | undefined;
    if (target) {
      if (target.kind === 'mixed') {
        clear();
        return false;
      }
      const table = tables.find((t) => t.id === target.blockId);
      if (table) cell = cellAt(data, index, table, point);
      if (!cell) {
        clear();
        if (activate && chartIds.includes(target.blockId)) {
          openData(target.blockId);
          return true;
        }
        return false;
      }
    }
    if (!cell && el.tag !== 'text') {
      clear();
      return false;
    }
    const values = cell
      ? [(cell.row === 0 ? cell.table.columns : cell.table.rows[cell.row - 1])[cell.col]]
      : editableTextNodes(
          new DOMParser().parseFromString(el.source, 'image/svg+xml').documentElement,
        ).map((n) => n.data);
    if (!values.length) return false;
    const displayBox = cell ? (data.boxes[cell.lines[0]] ?? cell.placeholder) : box;
    const activeRun = cell
      ? 0
      : Math.max(
          0,
          displayBox.runs?.findIndex(
            (r) =>
              point.x >= r.x &&
              point.x <= r.x + r.width &&
              point.y >= r.y &&
              point.y <= r.y + r.height,
          ) ?? 0,
        );
    setField({ box: displayBox, values, cell, activeRun });
    setEditing(activate);
    return true;
  };
  return {
    data,
    field: data ? field : undefined,
    editing,
    hit,
    clear: () => {
      if (!field || !data) return false;
      setField(undefined);
      setEditing(false);
      return true;
    },
    open: () => {
      if (!data || !field) return false;
      setEditing(true);
      return true;
    },
    close: () => setEditing(false),
  };
}

const nativeStyles = createStaticStyles(({ css, cssVar }) => ({
  layer: css`
    position: absolute;
    inset: 0;
    z-index: 5;
    pointer-events: none;
    container-type: inline-size;
  `,
  input: css`
    pointer-events: auto;
    position: absolute;
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    outline: 1px solid var(--qz-glass-tint, #648c85);
    outline-offset: 2px;
    background: transparent;
    appearance: none;
    resize: none;
    overflow: hidden;
    caret-color: currentColor;
    user-select: text;
    touch-action: manipulation;
    min-width: 1ch;
    field-sizing: content;
    &:not(:focus) {
      outline: none;
    }
  `,
  error: css`
    position: absolute;
    bottom: 0;
    inset-inline: 0;
    color: ${cssVar.colorErrorText};
    background: ${cssVar.colorBgContainer};
    font-size: 12px;
  `,
}));

/** Remove just the glyphs being edited from the inert image. Everything behind
 * the caret, including an image, gradient or table band, remains the real slide. */
export function useEditingImage(
  document: Document | undefined,
  field: Field | undefined,
  editing: boolean,
) {
  return useMemo(() => {
    if (!document || !field || !editing) return;
    const root = document.documentElement.cloneNode(true) as Element,
      atoms = canvasAtoms(root);
    for (const index of field.cell?.lines ?? [field.box.index]) atoms[index]?.remove();
    return (
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(new XMLSerializer().serializeToString(root))
    );
  }, [document, field, editing]);
}

export function DirectCanvasEditor({
  field,
  draftKey,
  onCommitPreview,
  data,
  editing,
  page,
  close,
  send,
}: {
  field: Field;
  draftKey?: string;
  onCommitPreview?: (values: string[]) => void;
  data: EditableSlide;
  editing: boolean;
  page: number;
  close: () => void;
  send: (message: PresentationMessageInput) => Promise<boolean>;
}) {
  const { t } = useTranslation('common');
  const storageKey = draftKey ? 'qingzhou:slide-text:' + draftKey : undefined;
  const [values, setValues] = useState<string[]>(() => {
    try {
      const saved = storageKey && JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (
        Array.isArray(saved) &&
        saved.length === field.values.length &&
        saved.every((v) => typeof v === 'string')
      )
        return saved;
    } catch {
      /* Storage may be unavailable in private windows. */
    }
    return field.values;
  });
  const storeDraft = (next?: string[]) => {
    if (!storageKey) return;
    try {
      if (next) localStorage.setItem(storageKey, JSON.stringify(next));
      else localStorage.removeItem(storageKey);
    } catch {
      /* The active editor retains the draft. */
    }
  };
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const request = useRef<string>(undefined);
  const input = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const cancelled = useRef(false);
  useLayoutEffect(() => {
    if (editing) {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    }
  }, [editing]);
  const b = field.box;
  const label = t(field.cell ? 'presentationCanvas.editTableData' : 'presentationCanvas.editText');
  const valid = values.some((v) => v.trim()) || Boolean(field.cell?.row);
  const changed = values.some((v, i) => v !== field.values[i]);
  const anchor = useRef<HTMLDivElement>(null);
  const cancel = () => {
    if (busy.current) return;
    const canvas = anchor.current?.closest<HTMLElement>('[data-canvas-page]')?.parentElement;
    cancelled.current = true;
    storeDraft();
    close();
    canvas?.focus({ preventScroll: true });
  };
  const save = async () => {
    if (cancelled.current || busy.current) return;
    if (!changed) {
      storeDraft();
      close();
      return;
    }
    if (!valid) {
      setFailed(true);
      input.current?.focus({ preventScroll: true });
      return;
    }
    busy.current = true;
    setSaving(true);
    setFailed(false);
    const common = {
      content: label,
      requestId: (request.current ??= crypto.randomUUID()),
      target: { type: 'slide' as const, slideNumber: page },
    };
    try {
      const cell = field.cell;
      const message: PresentationMessageInput = cell
        ? {
            ...common,
            tableDataPatch: {
              blockId: cell.table.id,
              expectedVersionId: data.versionId,
              columns: cell.table.columns.map((v, c) =>
                cell.row === 0 && c === cell.col ? values[0] : v,
              ),
              rows: cell.table.rows.map((r, i) =>
                i + 1 === cell.row ? r.map((v, c) => (c === cell.col ? values[0] : v)) : r,
              ),
            },
          }
        : {
            ...common,
            annotation: {
              expectedVersionId: data.versionId,
              slideId: data.slide.slideId,
              baseSvgHash: data.hash,
              elementIndices: [b.index],
              region: {
                x: Math.min(1, Math.max(0, b.x + b.width / 2)),
                y: Math.min(1, Math.max(0, b.y + b.height / 2)),
                width: 0,
                height: 0,
              },
              textRuns: values,
            },
          };
      onCommitPreview?.(values);
      if (await send(message)) {
        storeDraft();
        close();
      } else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  if (!editing)
    return (
      <span
        aria-hidden
        className={`${glassSelection} ${annotationStyles.box}`}
        data-testid="direct-canvas-selection"
        style={{
          left: b.x * 100 + '%',
          top: b.y * 100 + '%',
          width: b.width * 100 + '%',
          height: b.height * 100 + '%',
        }}
      />
    );
  return (
    <div
      ref={anchor}
      className={nativeStyles.layer}
      data-testid="direct-canvas-editor"
      onBlur={(e) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)))
          void save();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          void save();
        }
      }}
    >
      {values.map((value, i) => {
        const run = b.runs?.[i],
          r = run ?? b,
          cell = field.cell;
        const width = cell
          ? Math.max(0.015, cell.right - r.x - 0.008)
          : values.length === 1
            ? Math.max(0.015, 1 - r.x - 0.008)
            : Math.max(r.width, 0.02);
        const height = cell ? Math.max(r.height, cell.bottom - r.y - 0.004) : r.height;
        const font = run?.size ?? b.height * 0.5;
        const props = {
          'aria-label': label + (values.length > 1 ? ' ' + (i + 1) : ''),
          'readOnly': saving,
          value,
          'className': nativeStyles.input,
          'maxLength': cell ? (cell.row === 0 ? 40 : 240) : 4000,
          'style': {
            left: r.x * 100 + '%',
            top: r.y * 100 + '%',
            width: cell ? width * 100 + '%' : 'auto',
            minWidth: Math.max(0.01, r.width) * 100 + '%',
            maxWidth: (cell ? width : 1 - r.x) * 100 + '%',
            height: height * 100 + '%',
            fontFamily: run?.family,
            fontWeight: run?.weight,
            fontStyle: run?.italic,
            fontSize: font * 100 + 'cqw',
            color: run?.color ?? 'black',
            lineHeight: cell ? '1.3' : '1',
            letterSpacing: run?.spacing,
          },
          'onChange': (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            const text = e.target.value;
            request.current = undefined;
            setFailed(false);
            const next = values.map((v, j) => (i === j ? text : v));
            setValues(next);
            storeDraft(next);
          },
          'ref': (el: HTMLInputElement | HTMLTextAreaElement | null) => {
            if (i === field.activeRun) input.current = el;
          },
        };
        return cell ? (
          <textarea rows={1} key={i} {...props} />
        ) : (
          <input key={i} type="text" {...props} />
        );
      })}
      {failed && (
        <span role="alert" className={nativeStyles.error}>
          {t('presentationCanvas.saveFailed')}
        </span>
      )}
    </div>
  );
}
