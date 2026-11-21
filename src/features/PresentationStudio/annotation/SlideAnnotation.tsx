import { ArrowUp, Scan, X } from 'lucide-react';
import {
  type CSSProperties,
  type PointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { glassSelection } from '@/features/GlassMotion/selectionStyle';
import { glassSurface } from '@/styles/liquidGlass';
import type {
  PresentationMessageInput,
  PresentationSlidePlan,
} from '../../../../packages/runtime-contracts/src';
import {
  type AnnotationDataSelection,
  type SvgAnnotationElement,
  annotationDataSelection,
} from '../../../../packages/utils/src/presentationAnnotation';
import { type AnnotationRegion, type ElementBox, selectAnnotationElements } from './geometry';

import { readEditableSlide } from './readEditableSlide';
import { styles } from './style';

type Point = { x: number; y: number };
type Selection = { region: AnnotationRegion; indices: number[] };
const MAX_TARGETS = 40; // presentation.page annotation contract
const bounded = (v: number) => Math.max(0, Math.min(1, v));
const boxStyle = (r: AnnotationRegion): CSSProperties => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.width * 100}%`,
  height: `${r.height * 100}%`,
});
const rectangle = (a: Point, b: Point): AnnotationRegion => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(b.x - a.x),
  height: Math.abs(b.y - a.y),
});
const normalized = (event: PointerEvent<HTMLDivElement>, bounds: DOMRect): Point => ({
  x: bounded((event.clientX - bounds.left) / bounds.width),
  y: bounded((event.clientY - bounds.top) / bounds.height),
});

export function SlideAnnotation({
  jobId,
  page,
  versionId,
  onSend,
  onClose,
  dock,
  getDataEditor,
}: {
  jobId: string;
  page: number;
  versionId: string;
  onSend: (jobId: string, input: PresentationMessageInput) => Promise<boolean>;
  onClose: () => void;
  dock?: HTMLDivElement | null;
  getDataEditor?: (
    selection: Exclude<AnnotationDataSelection, { kind: 'mixed' }>,
  ) => (() => void) | undefined;
}) {
  const { t } = useTranslation('common');
  const overlay = useRef<HTMLDivElement>(null),
    field = useRef<HTMLInputElement>(null);
  const [viewport, setViewport] = useState<CSSProperties>();
  const [data, setData] = useState<{
    slide: PresentationSlidePlan;
    versionId: string;
    hash: string;
    boxes: ElementBox[];
    elements: SvgAnnotationElement[];
  }>();
  const [selection, setSelection] = useState<Selection>(),
    [marquee, setMarquee] = useState<AnnotationRegion>(),
    [hover, setHover] = useState<number>();
  const [comment, setComment] = useState(''),
    [error, setError] = useState(''),
    [sending, setSending] = useState(false);
  const drag = useRef<{ id: number; point: Point; client: Point }>(undefined);
  const busy = useRef(false),
    composing = useRef(false),
    focusComment = useRef(false),
    requestId = useRef<string>(undefined);
  const opener = useRef<HTMLElement | null>(null);
  const exit = () => {
    onClose();
    if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
  };
  const statusId = useId(),
    keysId = useId();
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined);
    setSelection(undefined);
    setComment('');
    setError('');
    setHover(undefined);
    setMarquee(undefined);
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.current?.focus({ preventScroll: true });
    void (async () => {
      const result = await readEditableSlide(jobId, page, versionId, controller.signal);
      if (!controller.signal.aborted) setData(result);
    })().catch((err) => {
      if (!controller.signal.aborted)
        setError(
          t(
            err.message?.startsWith('presentationAnnotation.')
              ? err.message
              : 'presentationAnnotation.readFailed',
          ),
        );
    });
    return () => controller.abort();
  }, [jobId, page, versionId, t]);

  useLayoutEffect(() => {
    const frame = overlay.current?.parentElement;
    if (!frame) return;
    const box = data?.slide.svg
      .match(/viewBox=["']([^"']+)["']/)?.[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (!box || !(box[2] > 0 && box[3] > 0)) return;
    const ratio = box[2] / box[3];
    const resize = () => {
      const width = Math.min(frame.clientWidth, frame.clientHeight * ratio),
        height = width / ratio;
      setViewport({
        width,
        height,
        left: (frame.clientWidth - width) / 2,
        top: (frame.clientHeight - height) / 2,
      });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [data]);

  useLayoutEffect(() => {
    if (
      selection?.indices.length &&
      selection.indices.length <= MAX_TARGETS &&
      focusComment.current
    )
      field.current?.focus({ preventScroll: true });
    focusComment.current = false;
  }, [selection]);
  const choose = (region: AnnotationRegion, indices: number[], focus = false) => {
    requestId.current = undefined;
    setError('');
    setHover(undefined);
    focusComment.current = focus;
    setSelection({ region, indices });
  };
  const clearDrag = () => {
    drag.current = undefined;
    setMarquee(undefined);
  };
  const reselect = () => {
    clearDrag();
    setSelection(undefined);
    setHover(undefined);
    setError('');
    overlay.current?.focus({ preventScroll: true });
  };
  const hits =
    data && marquee ? selectAnnotationElements(data.boxes, marquee) : (selection?.indices ?? []);
  const dataTarget =
    data && annotationDataSelection(data.elements, hits, data.slide.metadata?.contentBlocks);
  const editData =
    dataTarget && dataTarget.kind !== 'mixed' ? getDataEditor?.(dataTarget) : undefined;
  const send = async () => {
    if (
      busy.current ||
      drag.current ||
      dataTarget ||
      composing.current ||
      !data ||
      data.versionId !== versionId ||
      !selection?.indices.length ||
      selection.indices.length > MAX_TARGETS ||
      !comment.trim()
    )
      return;
    busy.current = true;
    setSending(true);
    setError('');
    try {
      const accepted = await onSend(jobId, {
        content: comment.trim(),
        requestId: (requestId.current ??= crypto.randomUUID()),
        target: { type: 'slide', slideNumber: page },
        annotation: {
          slideId: data.slide.slideId,
          expectedVersionId: data.versionId,
          baseSvgHash: data.hash,
          elementIndices: selection.indices,
          region: selection.region,
        },
      });
      if (accepted) exit();
      else setError(t('presentationAnnotation.sendFailed'));
    } catch {
      setError(t('presentationAnnotation.sendFailed'));
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  const hitSet = new Set(hits);
  const selected = data?.boxes.filter((b) => hitSet.has(b.index)) ?? [];
  const first = selected[0];
  const summary =
    [...new Set(selected.map((box) => box.label).filter(Boolean))].slice(0, 2).join(' · ') ||
    (first ? t(`presentationAnnotation.${first.kind ?? 'shape'}` as const) : '');
  const status =
    error ||
    (!data
      ? t('presentationAnnotation.loading')
      : dataTarget
        ? t(
            dataTarget.kind === 'mixed'
              ? 'presentationAnnotation.mixedData'
              : editData
                ? dataTarget.kind === 'table'
                  ? 'presentationAnnotation.tableSelected'
                  : 'presentationAnnotation.chartSelected'
                : 'presentationAnnotation.dataUnavailable',
            { count: hits.length },
          )
        : hits.length > MAX_TARGETS
          ? t('presentationAnnotation.tooMany', { count: hits.length, max: MAX_TARGETS })
          : hits.length || marquee
            ? t('presentationAnnotation.selected', { count: hits.length }) +
              (summary ? ' · ' + summary : '')
            : selection
              ? t('presentationAnnotation.noHit')
              : t('presentationAnnotation.hint'));
  const tooMany = !dataTarget && hits.length > MAX_TARGETS;
  const dockContent = (
    <section
      className={`${glassSurface} ${styles.dock}`}
      aria-label={t('presentationAnnotation.name')}
      data-testid="annotation-dock"
    >
      <div className={styles.row}>
        <span id={statusId} title={status} role={error || tooMany ? 'alert' : 'status'}>
          {status}
        </span>
        {selection && (
          <button
            aria-label={t('presentationAnnotation.reselect')}
            title={t('presentationAnnotation.reselect')}
            type="button"
            disabled={sending}
            onClick={reselect}
          >
            <Scan size={16} />
          </button>
        )}
        <button
          aria-label={t('presentationAnnotation.cancel')}
          title={t('presentationAnnotation.cancel')}
          type="button"
          disabled={sending}
          onClick={exit}
        >
          <X size={17} />
        </button>
      </div>
      {dataTarget
        ? editData &&
          !marquee && (
            <div className={styles.row}>
              <button type="button" className={styles.dataAction} onClick={editData}>
                {t(
                  dataTarget.kind === 'table'
                    ? 'presentationCanvas.editTableData'
                    : 'presentationCanvas.editData',
                )}
              </button>
            </div>
          )
        : (data || comment) && (
            <form
              className={styles.row}
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <input
                aria-label={t('presentationAnnotation.comment')}
                className={styles.input}
                disabled={sending}
                maxLength={4000}
                placeholder={t('presentationAnnotation.placeholder')}
                value={comment}
                ref={field}
                onChange={(event) => {
                  setComment(event.target.value);
                  requestId.current = undefined;
                }}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (composing.current ||
                      event.nativeEvent.isComposing ||
                      event.nativeEvent.keyCode === 229)
                  )
                    event.preventDefault();
                  if (event.key === 'Escape' && !composing.current && !sending) {
                    event.stopPropagation();
                    event.preventDefault();
                    reselect();
                  }
                }}
              />
              <button
                aria-label={t('presentationAnnotation.send')}
                title={t('presentationAnnotation.send')}
                disabled={sending || Boolean(marquee) || !comment.trim() || !hits.length || tooMany}
                type="submit"
              >
                <ArrowUp size={18} />
              </button>
            </form>
          )}
    </section>
  );
  return (
    <>
      <div
        aria-label={t('presentationAnnotation.name')}
        aria-describedby={statusId + ' ' + keysId}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Enter Escape"
        className={styles.overlay}
        ref={overlay}
        role="application"
        style={viewport}
        tabIndex={0}
        data-testid="annotation-overlay"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            sending ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey
          )
            return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (drag.current) clearDrag();
            else if (selection) reselect();
            else exit();
            return;
          }
          if (!data) return;
          if (event.key === 'Enter' && hits.length && !tooMany) {
            event.preventDefault();
            if (editData) editData();
            else field.current?.focus();
            return;
          }
          const forward = ['ArrowRight', 'ArrowDown'].includes(event.key);
          if (!forward && !['ArrowLeft', 'ArrowUp'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          const options = data.boxes.filter(
            (b) =>
              b.width > 0 &&
              b.height > 0 &&
              b.x >= 0 &&
              b.y >= 0 &&
              b.x + b.width <= 1.00001 &&
              b.y + b.height <= 1.00001,
          );
          if (!options.length) return;
          const i = options.findIndex((b) => b.index === hits[0]);
          const item =
            options[
              i < 0
                ? forward
                  ? 0
                  : options.length - 1
                : (i + (forward ? 1 : -1) + options.length) % options.length
            ];
          choose({ x: item.x, y: item.y, width: item.width, height: item.height }, [item.index]);
        }}
        onPointerDown={(e) => {
          if (!data || sending) return;
          if (e.isPrimary === false || (drag.current && drag.current.id !== e.pointerId)) {
            clearDrag();
            return;
          }
          if (e.button !== 0) return;
          const bounds = e.currentTarget.getBoundingClientRect();
          if (!bounds.width || !bounds.height) return;
          e.preventDefault();
          overlay.current?.focus({ preventScroll: true });
          setError('');
          drag.current = {
            id: e.pointerId,
            point: normalized(e, bounds),
            client: { x: e.clientX, y: e.clientY },
          };
          setHover(undefined);
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!data || sending) return;
          const bounds = e.currentTarget.getBoundingClientRect();
          if (!bounds.width || !bounds.height) return;
          const p = normalized(e, bounds);
          if (drag.current?.id === e.pointerId && drag.current)
            setMarquee(rectangle(drag.current.point, p));
          else if (!drag.current && e.pointerType === 'mouse')
            setHover(
              selectAnnotationElements(
                data.boxes,
                { ...p, width: 0, height: 0 },
                { x: 3 / bounds.width, y: 3 / bounds.height },
              )[0],
            );
        }}
        onPointerLeave={() => setHover(undefined)}
        onPointerUp={(e) => {
          const start = drag.current;
          if (!data || !start || start.id !== e.pointerId) return;
          clearDrag();
          const bounds = e.currentTarget.getBoundingClientRect();
          if (!bounds.width || !bounds.height) return;
          const p = normalized(e, bounds);
          const tolerance = e.pointerType === 'touch' ? 8 : 4;
          const region =
            Math.hypot(e.clientX - start.client.x, e.clientY - start.client.y) <= tolerance
              ? { ...p, width: 0, height: 0 }
              : rectangle(start.point, p);
          choose(
            region,
            selectAnnotationElements(data.boxes, region, {
              x: tolerance / bounds.width,
              y: tolerance / bounds.height,
            }),
            e.pointerType !== 'touch',
          );
        }}
        onPointerCancel={(e) => {
          if (drag.current?.id === e.pointerId) clearDrag();
        }}
        onLostPointerCapture={(e) => {
          if (drag.current?.id === e.pointerId) clearDrag();
        }}
      >
        <span id={keysId} hidden>
          {t('presentationAnnotation.keyboard')}
        </span>
        {data?.boxes
          .filter((box) => hitSet.has(box.index) || box.index === hover)
          .map((b) => (
            <span
              key={b.index}
              aria-hidden
              className={`${glassSelection} ${styles.box}`}
              style={boxStyle(b)}
              data-annotation-element={b.index}
              data-preview={!hitSet.has(b.index)}
            />
          ))}
        {(marquee || (selection && selection.region.width > 0 && selection.region.height > 0)) && (
          <span
            aria-hidden
            className={`${glassSelection} ${styles.region}`}
            style={boxStyle(marquee ?? selection!.region)}
          />
        )}
      </div>
      {dock ? createPortal(dockContent, dock) : dock === undefined ? dockContent : null}
    </>
  );
}
