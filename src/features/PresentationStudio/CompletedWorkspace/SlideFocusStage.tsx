import { Button, Icon } from '@lobehub/ui';
import { InputNumber, Tooltip } from 'antd';
import {
  ChartScatter,
  ChevronLeft,
  ChevronRight,
  FileQuestion,
  Hand,
  ImageIcon,
  MessageSquarePlus,
  MousePointer2,
  Play,
} from 'lucide-react';
import {
  type CSSProperties,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
} from 'react';
import { useTranslation } from 'react-i18next';

import {
  alignmentEdges,
  alignSelection,
  selectionBounds,
  distributeSelection,
} from '@/features/SpatialCanvas/selection';
import { GlassToolbar } from '@/features/GlassMotion/Toolbar';
import { type CanvasControls, CanvasSurface } from '@/features/SpatialCanvas';
import { glassSurface } from '@/styles/liquidGlass';

import {
  canvasAtoms,
  canvasNode,
  editableTextNodes,
} from '../../../../packages/utils/src/presentationAnnotation';
import { translateInPage, scaleInPage } from '../../../utils/presentationCanvasTransform';
import { moveCanvasObject } from '../../../../packages/runtime-contracts/src/canvas';
import type {
  ArtifactSnapshot,
  CanvasCommand,
  PresentationMessageInput,
  PresentationJob,
} from '../../../../packages/runtime-contracts/src/index';
import { SlideAnnotation } from '../annotation/SlideAnnotation';
import { type SlideCanvasObject, presentationCanvasObjects } from './canvasObjects';
import { CanvasZoomControl } from './CanvasZoomControl';
import { ChartDataEditor } from './ChartDataEditor';
import { DirectCanvasEditor, useDirectCanvasEdit, useEditingImage } from './DirectCanvasEditor';
import { DeckPlayback } from './DeckPlayback';
import SlideGenerationOverlay from './SlideGenerationOverlay';
import { styles } from './style';
import { TableDataEditor } from './TableDataEditor';
import { useCanvasShortcuts } from './useCanvasShortcuts';
import { useCanvasDocument, useDragPreview, usePositionPreview } from './useCanvasDocument';

export interface SlideFocusStageProps {
  annotating: boolean;
  annotationDock: HTMLDivElement | null;
  canEditObjects?: boolean;
  canvas: RefObject<CanvasControls | null>;
  currentIndex: number;
  dataError?: string;
  jobId?: string;
  job?: PresentationJob;
  onFocusPage?: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSelectSlide: (id: string) => void;
  onSendMessage?: (jobId: string, input: PresentationMessageInput) => Promise<boolean>;
  painting?: boolean;
  paintInterrupted?: boolean;
  selectedSlide: ArtifactSnapshot | null;
  setAnnotating: (active: boolean) => void;
  slides: ArtifactSnapshot[];
  totalSlides: number;
  versionId?: string;
}

const getSlideStatusZh = (status?: string): string => {
  switch (status) {
    case 'ready': {
      return '已就绪';
    }
    case 'generating': {
      return '生成中';
    }
    case 'failed': {
      return '生成失败';
    }
    case 'cancelled': {
      return '已取消';
    }
    default: {
      return '排队中';
    }
  }
};

export const SlideFocusStage = memo<SlideFocusStageProps>(
  ({
    annotationDock,
    annotating,
    setAnnotating,
    canEditObjects = false,
    currentIndex,
    job,
    jobId,
    onFocusPage,
    onNext,
    canvas,
    onPrev,
    onSendMessage,
    dataError,
    paintInterrupted = false,
    painting = false,
    selectedSlide,
    totalSlides,
    slides,
    onSelectSlide,
    versionId,
  }) => {
    const { t } = useTranslation('common');
    const [mode, setMode] = useState<'select' | 'pan'>('select');
    const [zoom, setZoom] = useState<number>();
    const [draft, setDraft] = useState<{
      blockId: string;
      x: number;
      y: number;
      requestId: string;
    }>();
    const [optimistic, setOptimistic] = useState<{ page: string; version?: string; uri: string }>();
    const mainImage = useRef<HTMLImageElement>(null);
    const [drop, setDrop] = useState<{
      jobId: string;
      pageId: string;
      baseArtifact: string;
      requestId: string;
      baseVersion: string;
      uri: string;
      objects: SlideCanvasObject[];
      selected: string[];
    }>();
    const [positionSaving, setPositionSaving] = useState(false);
    const [positionFailed, setPositionFailed] = useState(false);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const selection = selectedIds.at(-1);
    const setSelection = useCallback((id?: string) => setSelectedIds(id ? [id] : []), []);
    const [dataEditor, setDataEditor] = useState<{ id: string; versionId: string; page: number }>();
    const [playback, setPlayback] = useState<{ slides: ArtifactSnapshot[]; startIndex: number }>();
    const exitPlayback = useCallback(() => setPlayback(undefined), []);
    useEffect(() => {
      setDrop(undefined);
    }, [currentIndex, jobId]);
    useEffect(() => {
      setAnnotating(false);
      setSelection(undefined);
      setDataEditor(undefined);
      setDraft(undefined);
      setPositionFailed(false);
    }, [currentIndex, jobId, versionId, setAnnotating]);
    const {
      objects: semanticObjects,
      charts,
      tables,
    } = useMemo(
      () =>
        presentationCanvasObjects(
          selectedSlide?.metadata?.contentBlocks,
          selectedSlide?.metadata?.nativeData,
        ),
      [selectedSlide?.metadata?.contentBlocks, selectedSlide?.metadata?.nativeData],
    );
    const selectedChart = charts.find((chart) => chart.id === (selection ?? charts[0]?.id));
    const pages = useMemo(
      () =>
        slides.map((slide, i) => ({
          id: String(slide.metadata?.slideNumber || i + 1),
          label: t('presentationConversation.page', {
            number: slide.metadata?.slideNumber || i + 1,
          }),
          preview: slide.uri,
          width: 960,
          height: slide.metadata?.aspectRatio === '4:3' ? 720 : 540,
        })),
      [slides, t],
    );
    const pageId = pages[currentIndex]?.id ?? String(currentIndex + 1);
    const pageNumber = Number(pageId);
    const openDataEditor = (id?: string) => {
      if (id && versionId) setDataEditor({ id, versionId, page: pageNumber });
    };
    const editorId =
      dataEditor?.page === pageNumber && dataEditor.versionId === versionId
        ? dataEditor.id
        : undefined;
    const editingTable = tables.find((table) => table.id === editorId);
    const editing = charts.find((chart) => chart.id === editorId);
    const aspectRatio = selectedSlide?.metadata?.aspectRatio === '4:3' ? '4:3' : '16:9';
    const [slideAw, slideAh] = aspectRatio === '4:3' ? [4, 3] : [16, 9];
    const ready = selectedSlide?.status === 'ready' && Boolean(selectedSlide?.uri);

    const direct = useDirectCanvasEdit(
      jobId,
      pageNumber,
      versionId,
      Boolean(
        ready && canEditObjects && onSendMessage && !painting && !annotating && mode === 'select',
      ),
      tables,
      openDataEditor,
      charts.map((chart) => chart.id),
    );
    const source = useCanvasDocument(
      selectedSlide?.uri,
      ready && Boolean(onSendMessage),
      jobId,
      pageNumber,
      versionId,
    );
    const editingImage = useEditingImage(source?.document, direct.field, direct.editing);
    const objects = useMemo(() => {
      if (!source || !direct.data) return semanticObjects;
      const { elements, boxes } = direct.data;
      const extra = boxes
        .filter((box) => {
          const element = elements[box.index];
          if (
            !element ||
            element.diagramId ||
            element.dataGroup ||
            box.kind === 'background' ||
            box.width <= 0 ||
            box.height <= 0 ||
            box.width * box.height > 0.94
          )
            return false;
          return true;
        })
        .map((box) => ({
          id: 'svg:' + box.index,
          label: box.label ?? box.kind ?? '',
          x: source.x + box.x * source.width,
          y: source.y + box.y * source.height,
          width: box.width * source.width,
          height: box.height * source.height,
        }));
      const order = new Map<string, number>();
      for (const el of elements) {
        order.set('svg:' + el.index, el.index);
        if (el.diagramId) order.set(el.diagramId, el.index);
      }
      return [...extra, ...semanticObjects].sort(
        (a, b) => (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1),
      );
    }, [source, direct.data, semanticObjects]);
    const families = useMemo(() => {
      const byId = new Map<string, string>();
      if (source) {
        const atoms = canvasAtoms(source.document.documentElement);
        for (const o of objects) {
          const node = o.id.startsWith('svg:')
            ? atoms[Number(o.id.slice(4))]
            : canvasNode(source.document.documentElement, o.id);
          const group = node?.getAttribute('data-canvas-group')?.split(' ')[0];
          if (group) byId.set(o.id, group);
        }
      }
      return byId;
    }, [objects, source]);
    const expand = useCallback(
      (ids: string[]) => {
        const groups = new Set(ids.map((id) => families.get(id)).filter(Boolean));
        return [
          ...new Set([
            ...ids,
            ...objects.filter((o) => groups.has(families.get(o.id))).map((o) => o.id),
          ]),
        ];
      },
      [objects, families],
    );
    const grouped =
      selectedIds.length > 1 &&
      !!families.get(selectedIds[0]) &&
      selectedIds.every((id) => families.get(id) === families.get(selectedIds[0]));
    const selectedRevision = useRef(versionId);
    useEffect(() => {
      if (!versionId || selectedRevision.current === versionId || !direct.data || !source) return;
      selectedRevision.current = versionId;
      const message = job?.messages?.findLast(
        (m) => m.status === 'applied' && m.versionId === versionId,
      );
      if (message?.target.type !== 'slide' || message.target.slideNumber !== pageNumber) return;
      const saved = direct.data.slide.metadata?.canvasSelection as
        { requestId?: string; ids?: string[] } | undefined;
      if (saved?.requestId === message.requestId && Array.isArray(saved.ids)) {
        setSelectedIds(saved.ids.filter((id) => objects.some((o) => o.id === id)));
        return;
      }
      const cmd = message.canvasCommand;
      let id = message.objectPositionPatch?.blockId;
      if (cmd?.kind === 'translate') id = cmd.object;
      if (cmd?.kind === 'paste') {
        const blocks = direct.data.slide.metadata?.contentBlocks;
        id = cmd.object.startsWith('svg:')
          ? 'svg:' + direct.data.elements.at(-1)?.index
          : Array.isArray(blocks)
            ? blocks.at(-1)?.id
            : undefined;
      }
      if (id && objects.some((object) => object.id === id)) setSelection(id);
    }, [direct.data, source, objects, versionId, job?.messages, pageNumber]);
    const pendingDrop = drop?.pageId === pageId && drop.jobId === jobId ? drop : undefined;
    const selectedObject = objects.find(({ id }) => id === selection);
    const selectedItems = objects.filter((o) => selectedIds.includes(o.id));
    const units = new Map<string, typeof selectedItems>();
    for (const item of selectedItems) {
      const id = families.get(item.id) ?? item.id;
      const unit = units.get(id);
      if (unit) unit.push(item);
      else units.set(id, [item]);
    }
    const unitBoxes = [...units].map(([id, members]) => ({ id, ...selectionBounds(members) }));
    const memberMoves = (moves: ReturnType<typeof alignSelection>) =>
      moves.flatMap((m) => units.get(m.object)!.map((o) => ({ ...m, object: o.id })));
    const bounds = selectedItems.length ? selectionBounds(selectedItems) : undefined;
    const multiple = selectedIds.length > 1;
    const currentId =
      direct.field?.cell?.table.id ?? (direct.field ? 'svg:' + direct.field.box.index : selection);
    const sourceObject = objects.find(({ id }) => id === draft?.blockId);
    const draftUri = usePositionPreview(source?.document, sourceObject, draft);
    const dragPreview = useDragPreview(
      jobId + ':' + pageId,
      source,
      draft,
      sourceObject,
      selectedIds,
      expand,
    );
    const { end: endDrag } = dragPreview;
    const receipt =
      pendingDrop && job?.messages?.findLast((m) => m.requestId === pendingDrop.requestId);
    const published = job?.revisions?.find((revision) => revision.versionId === versionId);
    useEffect(() => {
      if (!pendingDrop) return;
      if (receipt?.status === 'failed' || job?.state === 'failed' || job?.state === 'cancelled') {
        endDrag();
        setDrop(undefined);
        setPositionFailed(true);
        return;
      }
      const image = mainImage.current;
      if (
        !image ||
        !source ||
        (!direct.data && mode === 'select' && !annotating) ||
        receipt?.status !== 'applied' ||
        pendingDrop.baseVersion === versionId ||
        (published
          ? !published.artifactIds.includes(selectedSlide?.artifactId ?? '')
          : receipt.versionId !== versionId) ||
        selectedSlide?.artifactId === pendingDrop.baseArtifact ||
        !selectedSlide?.uri ||
        image.src !== new URL(selectedSlide.uri, window.location.href).href
      )
        return;
      let cancelled = false;
      // The acknowledgement and the replacement slide arrive independently.
      // Keep the dropped pixels on screen until the actual published image can paint.
      const complete = () => {
        if (cancelled || !image.complete || !image.naturalWidth) return;
        endDrag();
        setDrop((current) => (current === pendingDrop ? undefined : current));
      };
      image.addEventListener('load', complete);
      if (image.decode) void image.decode().then(complete, () => {});
      else complete();
      return () => {
        cancelled = true;
        image.removeEventListener('load', complete);
      };
    }, [
      pendingDrop,
      receipt?.status,
      receipt?.versionId,
      job?.state,
      versionId,
      selectedSlide?.artifactId,
      selectedSlide?.uri,
      source,
      direct.data,
      endDrag,
      published,
      mode,
      annotating,
    ]);
    const canMove = Boolean(
      source && canEditObjects && onSendMessage && jobId && versionId && ready && !pendingDrop,
    );
    const showObjectBar =
      ready &&
      !annotating &&
      mode === 'select' &&
      (semanticObjects.length > 0 || Boolean(selection));
    const canvasObjects = useMemo(
      () =>
        pendingDrop?.objects ??
        (sourceObject && draft ? [{ ...sourceObject, x: draft.x, y: draft.y }] : objects),
      [draft, objects, sourceObject, pendingDrop],
    );
    const select = useCallback(
      (id?: string) => {
        if (!draft) setSelectedIds(id ? expand([id]) : []);
      },
      [draft, expand],
    );
    const move = useCallback(
      (blockId: string, x: number, y: number) => {
        if (positionSaving) return;
        const object = objects.find(({ id }) => id === blockId);
        if (!object || !Number.isFinite(x) || !Number.isFinite(y)) return;
        const position = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
        setSelection(blockId);
        setPositionFailed(false);
        setDraft(
          position.x === object.x && position.y === object.y
            ? undefined
            : { ...position, blockId, requestId: crypto.randomUUID() },
        );
      },
      [objects, positionSaving],
    );
    const positionIsInvalid = (position: NonNullable<typeof draft>) => {
      if (!source) return true;
      try {
        moveCanvasObject({
          bounds: source,
          objects: position.blockId.startsWith('svg:')
            ? objects.filter((o) => o.id === position.blockId)
            : semanticObjects,
          id: position.blockId,
          x: position.x,
          y: position.y,
        });
        return false;
      } catch {
        return true;
      }
    };
    const invalidPosition = !!draft && positionIsInvalid(draft);
    const root = useRef<HTMLElement>(null);
    const redoDraft = useRef<typeof draft>(undefined);
    useEffect(() => {
      redoDraft.current = undefined;
    }, [pageNumber, versionId]);
    useCanvasShortcuts({
      root,
      job,
      version: versionId,
      page: pageNumber,
      canSubmit: canEditObjects && ready && !!onSendMessage && !positionSaving,
      selected: multiple ? selectedIds : currentId ? [currentId] : [],
      pasteOffset: {
        dx: bounds && source ? Math.min(12, source.x + source.width - bounds.x - bounds.width) : 12,
        dy:
          bounds && source ? Math.min(12, source.y + source.height - bounds.y - bounds.height) : 12,
      },
      draftUndo: (redo) => {
        if (!redo && draft && !positionSaving) {
          redoDraft.current = draft;
          setDraft(undefined);
          return true;
        }
        if (redo && redoDraft.current && !draft) {
          setDraft(redoDraft.current);
          redoDraft.current = undefined;
          return true;
        }
        return false;
      },
      send: async (canvasCommand, slideNumber, content) =>
        !!(
          jobId &&
          onSendMessage &&
          (await onSendMessage(jobId, {
            canvasCommand,
            target: { type: 'slide', slideNumber },
            requestId: crypto.randomUUID(),
            content,
          }))
        ),
    });
    const savePosition = async (position = draft) => {
      if (
        !position ||
        !canMove ||
        !jobId ||
        !versionId ||
        !onSendMessage ||
        positionIsInvalid(position) ||
        positionSaving
      )
        return;
      const original = objects.find((o) => o.id === position.blockId);
      if (!original) return;
      setPositionSaving(true);
      setPositionFailed(false);
      try {
        const saved = await onSendMessage(jobId, {
          ...(position.blockId.startsWith('svg:')
            ? {
                canvasCommand: {
                  kind: 'translate' as const,
                  object: position.blockId,
                  dx: position.x - original.x,
                  dy: position.y - original.y,
                  expectedVersionId: versionId,
                },
              }
            : {
                objectPositionPatch: {
                  blockId: position.blockId,
                  expectedVersionId: versionId,
                  x: position.x,
                  y: position.y,
                },
              }),
          content: t('presentationCanvas.moveObject'),
          requestId: position.requestId,
          target: { type: 'slide', slideNumber: pageNumber },
        });
        if (saved) setDraft(undefined);
        else setPositionFailed(true);
      } catch {
        setPositionFailed(true);
      } finally {
        setPositionSaving(false);
      }
    };

    const commitCanvas = async (command: CanvasCommand, label: string) => {
      if (
        !canMove ||
        !versionId ||
        !jobId ||
        !onSendMessage ||
        positionSaving ||
        (command.kind === 'moveMany' && !command.moves.some((m) => m.dx || m.dy))
      )
        return;
      const requestId = crypto.randomUUID();
      if (
        source &&
        selectedSlide &&
        (command.kind === 'moveMany' ||
          command.kind === 'resizeGroup' ||
          command.kind === 'translate')
      ) {
        const root = source.document.documentElement.cloneNode(true) as Element;
        const moves =
          command.kind === 'moveMany'
            ? command.moves
            : command.kind === 'translate'
              ? [command]
              : command.objects.map((object) => ({ object, dx: 0, dy: 0 }));
        for (const move of moves) {
          const n = canvasNode(root, move.object);
          if (!n) continue;
          if (command.kind === 'resizeGroup')
            scaleInPage(n, command.anchorX, command.anchorY, command.factor);
          else translateInPage(n, move.dx, move.dy);
        }
        const byId = new Map(moves.map((m) => [m.object, m]));
        const geometry = objects.map((o) => {
          const m = byId.get(o.id);
          if (!m) return o;
          if (command.kind === 'resizeGroup')
            return {
              ...o,
              x: command.anchorX + (o.x - command.anchorX) * command.factor,
              y: command.anchorY + (o.y - command.anchorY) * command.factor,
              width: o.width * command.factor,
              height: o.height * command.factor,
            };
          return { ...o, x: o.x + m.dx, y: o.y + m.dy };
        });
        dragPreview.hold();
        setDrop({
          jobId,
          pageId,
          baseVersion: versionId,
          baseArtifact: selectedSlide.artifactId,
          requestId,
          objects: geometry,
          selected: moves.map((m) => m.object),
          uri:
            'data:image/svg+xml;charset=utf-8,' +
            encodeURIComponent(new XMLSerializer().serializeToString(root)),
        });
      }
      setPositionSaving(true);
      setPositionFailed(false);
      try {
        const saved = await onSendMessage(jobId, {
          canvasCommand: command,
          requestId,
          target: { type: 'slide', slideNumber: pageNumber },
          content: label,
        });
        setPositionFailed(!saved);
        if (!saved) {
          dragPreview.end();
          setDrop(undefined);
        }
      } catch {
        dragPreview.end();
        setDrop(undefined);
        setPositionFailed(true);
      } finally {
        setPositionSaving(false);
      }
    };
    const moveMany = (moves: { object: string; dx: number; dy: number }[], label: string) =>
      versionId && commitCanvas({ kind: 'moveMany', moves, expectedVersionId: versionId }, label);
    const groupAction = (ungroup: boolean) => {
      if (!versionId || selectedIds.length < 2 || ungroup !== grouped) return;
      void commitCanvas(
        { kind: ungroup ? 'ungroup' : 'group', objects: selectedIds, expectedVersionId: versionId },
        t(ungroup ? 'presentationCanvas.ungroup' : 'presentationCanvas.group'),
      );
    };
    const finishMove = (blockId: string, x: number, y: number) => {
      const original = objects.find((o) => o.id === blockId);
      if (!original || positionSaving) return;
      const movingIds = selectedIds.includes(blockId) ? selectedIds : expand([blockId]);
      const bounds = selectionBounds(objects.filter((o) => movingIds.includes(o.id)));
      if (movingIds.length > 1 && source) {
        const dx = Math.max(
          source.x - bounds.x,
          Math.min(x - original.x, source.x + source.width - bounds.x - bounds.width),
        );
        const dy = Math.max(
          source.y - bounds.y,
          Math.min(y - original.y, source.y + source.height - bounds.y - bounds.height),
        );
        void moveMany(
          movingIds.map((object) => ({ object, dx, dy })),
          t('presentationCanvas.moveObject'),
        );
        return;
      }
      const dx = x - original.x,
        dy = y - original.y;
      if ((Math.abs(dx) < 1e-7 && Math.abs(dy) < 1e-7) || !versionId) return;
      direct.clear();
      redoDraft.current = undefined;
      setDraft(undefined);
      setSelection(blockId);
      void commitCanvas(
        { kind: 'translate', object: blockId, dx, dy, expectedVersionId: versionId },
        t('presentationCanvas.moveObject'),
      );
    };
    const pagePillText =
      totalSlides > 0
        ? `${String(currentIndex + 1).padStart(2, '0')} / ${String(totalSlides).padStart(2, '0')}`
        : '00 / 00';

    return (
      <section
        ref={root}
        data-editable-version={direct.data && canMove ? versionId : undefined}
        aria-busy={
          painting ||
          positionSaving ||
          (!direct.data && canMove && mode === 'select' && !annotating)
        }
        aria-label={t('presentationCanvas.viewport')}
        className={styles.stageArea}
        data-testid="slide-preview"
        onKeyDown={(event) => {
          const target = event.target;
          if (
            event.defaultPrevented ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            !(target instanceof HTMLElement) ||
            target.closest('input, textarea, select, [contenteditable=true], [role=toolbar]') ||
            !target.closest('[data-testid="spatial-canvas"], [data-page-navigation]')
          )
            return;
          if (event.key === 'ArrowLeft' && currentIndex > 0) {
            event.preventDefault();
            onPrev();
          } else if (event.key === 'ArrowRight' && currentIndex < totalSlides - 1) {
            event.preventDefault();
            onNext();
          }
        }}
        onKeyDownCapture={(event) => {
          if (
            event.key === 'Escape' &&
            draft &&
            !positionSaving &&
            event.target instanceof HTMLElement &&
            event.target.closest('[data-testid="spatial-canvas"]')
          ) {
            event.preventDefault();
            event.stopPropagation();
            setDraft(undefined);
            setPositionFailed(false);
          }
        }}
      >
        <div className={styles.focusCanvas}>
          <div className={styles.canvasTools}>
            <GlassToolbar
              portalTips
              label={t('presentationCanvas.toolbar')}
              items={[
                {
                  id: 'select',
                  label: t('presentationCanvas.select'),
                  icon: MousePointer2,
                  active: mode === 'select' && !annotating,
                  onClick: () => {
                    setAnnotating(false);
                    setMode('select');
                  },
                },
                {
                  id: 'pan',
                  label: t('presentationCanvas.pan'),
                  icon: Hand,
                  active: mode === 'pan' && !annotating,
                  disabled: !!draft,
                  onClick: () => {
                    setAnnotating(false);
                    setMode('pan');
                  },
                },
                ...(onSendMessage
                  ? [
                      {
                        id: 'annotate',
                        label: t(
                          annotating
                            ? 'presentationCanvas.leaveAnnotation'
                            : 'presentationCanvas.annotate',
                        ),
                        icon: MessageSquarePlus,
                        active: annotating,
                        disabled: !!draft || !ready || !versionId,
                        onClick: () => setAnnotating(!annotating),
                      },
                    ]
                  : []),
                ...(charts.length
                  ? [
                      {
                        id: 'data',
                        label: t('presentationCanvas.editData'),
                        icon: ChartScatter,
                        disabled: !!draft || !canEditObjects || !selectedChart || !onSendMessage,
                        onClick: () => openDataEditor(selectedChart?.id),
                      },
                    ]
                  : []),
                {
                  id: 'present',
                  label: t('presentationCanvas.present'),
                  icon: Play,
                  disabled: !ready || Boolean(draft && (!draftUri || invalidPosition)),
                  onClick: () =>
                    setPlayback({
                      slides: draftUri
                        ? slides.map((slide, index) =>
                            index === currentIndex ? { ...slide, uri: draftUri } : slide,
                          )
                        : slides,
                      startIndex: currentIndex,
                    }),
                },
              ]}
            />
          </div>
          <CanvasSurface
            boardId={jobId ?? ''}
            currentPageId={pageId}
            fitPadding={0}
            height={source?.height ?? (aspectRatio === '4:3' ? 720 : 540)}
            label={t('presentationCanvas.viewport')}
            mode={annotating || direct.editing ? 'passive' : mode}
            objects={painting || !ready ? [] : canvasObjects}
            originX={source?.x}
            originY={source?.y}
            pages={pages}
            ref={canvas}
            reservedBottom={showObjectBar ? 66 : 48}
            reservedTop={60}
            showSelectionFrame={multiple || !direct.field}
            selectedId={pendingDrop?.selected.at(-1) ?? currentId}
            selectedIds={pendingDrop?.selected ?? selectedIds}
            expandSelection={expand}
            onFocusPage={() => {
              setMode('select');
              onFocusPage?.();
            }}
            onGroupShortcut={groupAction}
            onResize={
              multiple && canMove && !positionSaving && versionId
                ? (factor, anchorX, anchorY) => {
                    void commitCanvas(
                      {
                        kind: 'resizeGroup',
                        objects: selectedIds,
                        anchorX,
                        anchorY,
                        factor,
                        expectedVersionId: versionId,
                      },
                      t('presentationCanvas.resizeGroup'),
                    );
                  }
                : undefined
            }
            resizeLabel={t('presentationCanvas.resizeGroup')}
            onSelectMany={
              canMove && !draft
                ? (ids) => {
                    direct.clear();
                    setSelectedIds(expand(ids));
                  }
                : undefined
            }
            width={source?.width ?? 960}
            onClearDocumentSelection={direct.clear}
            onDocumentTap={
              draft ? undefined : (point, edit) => (edit ? direct.hit(point, true) : false)
            }
            onEditSelection={() => {
              if (multiple) return false;
              if (direct.open()) return true;
              if (selection && canEditObjects && charts.some((c) => c.id === selection)) {
                openDataEditor(selection);
                return true;
              }
              return false;
            }}
            onDragPreview={dragPreview.update}
            onMove={canMove && !positionSaving ? finishMove : undefined}
            onSelect={select}
            onZoomChange={setZoom}
            onPageChange={(id) => {
              const index = pages.findIndex((page) => page.id === id);
              if (index !== -1) onSelectSlide(slides[index].artifactId);
            }}
          >
            <div
              aria-label={`第 ${currentIndex + 1} 页 ${aspectRatio} 大预览`}
              className={styles.focusFrame169}
              data-painting={painting ? 'true' : 'false'}
              role="group"
              style={
                {
                  '--slide-ah': slideAh,
                  '--slide-aw': slideAw,
                  'width': '100%',
                  'height': '100%',
                } as CSSProperties
              }
            >
              {ready ? (
                <img
                  alt={selectedSlide?.name ?? `第 ${currentIndex + 1} 页`}
                  className={styles.focusImage}
                  ref={mainImage}
                  data-testid="slide-preview-image"
                  draggable={false}
                  src={
                    editingImage ??
                    (optimistic?.page === pageId && optimistic.version === versionId
                      ? optimistic.uri
                      : undefined) ??
                    draftUri ??
                    selectedSlide?.uri
                  }
                />
              ) : (
                <div className={styles.focusEmpty} data-testid="slide-preview-empty">
                  <Icon icon={selectedSlide ? ImageIcon : FileQuestion} size={32} />
                  <span>
                    {selectedSlide
                      ? `产物状态为【${getSlideStatusZh(selectedSlide.status)}】— 暂无可用预览。`
                      : '请选择已就绪的幻灯片以预览 SVG 画布。'}
                  </span>
                </div>
              )}

              {pendingDrop && (
                <img
                  alt=""
                  aria-hidden
                  data-testid="canvas-drop-preview"
                  className={styles.focusImage}
                  src={pendingDrop.uri}
                  style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                />
              )}
              <img aria-hidden alt="" className={styles.dragImage} ref={dragPreview.background} />
              <img aria-hidden alt="" className={styles.dragImage} ref={dragPreview.floating} />
              <SlideGenerationOverlay
                active={painting}
                hasPreview={ready}
                interrupted={paintInterrupted}
              />

              {direct.field && direct.data && jobId && onSendMessage && (
                <DirectCanvasEditor
                  key={JSON.stringify([
                    versionId,
                    pageNumber,
                    direct.field.box.index,
                    direct.editing,
                  ])}
                  field={direct.field}
                  data={direct.data}
                  editing={direct.editing}
                  page={pageNumber}
                  draftKey={JSON.stringify([
                    jobId,
                    versionId,
                    pageNumber,
                    direct.field.cell?.table.id,
                    direct.field.cell?.row,
                    direct.field.cell?.col,
                    direct.field.box.index,
                  ])}
                  onCommitPreview={(values) => {
                    if (!source || !direct.field) return;
                    const root = source.document.documentElement.cloneNode(true) as Element;
                    const field = direct.field,
                      atoms = canvasAtoms(root);
                    const indices = field.cell?.lines ?? [field.box.index];
                    indices.forEach((index, i) => {
                      const n = atoms[index];
                      if (!n) return;
                      editableTextNodes(n).forEach((v, j) => {
                        v.data = field.cell
                          ? i === 0 && j === 0
                            ? values[0]
                            : ''
                          : (values[j] ?? v.data);
                      });
                    });
                    setOptimistic({
                      page: pageId,
                      version: versionId,
                      uri:
                        'data:image/svg+xml;charset=utf-8,' +
                        encodeURIComponent(new XMLSerializer().serializeToString(root)),
                    });
                  }}
                  close={direct.close}
                  send={(message) => onSendMessage(jobId, message)}
                />
              )}
              {annotating && ready && jobId && versionId && onSendMessage && (
                <SlideAnnotation
                  dock={annotationDock}
                  jobId={jobId}
                  page={pageNumber}
                  versionId={versionId}
                  getDataEditor={(target) => {
                    const options = target.kind === 'chart' ? charts : tables;
                    if (canEditObjects && options.some((item) => item.id === target.blockId))
                      return () => openDataEditor(target.blockId);
                  }}
                  onClose={() => setAnnotating(false)}
                  onSend={onSendMessage}
                />
              )}
            </div>
          </CanvasSurface>
          {showObjectBar && (
            <div
              aria-label={t('presentationCanvas.objects')}
              className={`${glassSurface} ${styles.objectBar}`}
              role="group"
            >
              <select
                hidden={multiple}
                aria-label={t('presentationCanvas.objects')}
                disabled={Boolean(draft)}
                value={selection ?? ''}
                onChange={(event) => select(event.target.value || undefined)}
              >
                <option value="">{t('presentationCanvas.objects')}</option>
                {objects
                  .filter((object) => !object.id.startsWith('svg:') || object.id === selection)
                  .map((object) => (
                    <option key={object.id} value={object.id}>
                      {object.label}
                    </option>
                  ))}
              </select>
              {multiple && (
                <span role="status">
                  {t('presentationCanvas.selectedCount', { count: selectedIds.length })}
                </span>
              )}
              {canMove && multiple && (
                <Button
                  size="small"
                  disabled={positionSaving}
                  onClick={() => {
                    root.current
                      ?.querySelector<HTMLElement>('[data-testid="spatial-canvas"]')
                      ?.focus({ preventScroll: true });
                    groupAction(grouped);
                  }}
                >
                  {t(grouped ? 'presentationCanvas.ungroup' : 'presentationCanvas.group')}
                </Button>
              )}
              {canMove && multiple && !grouped && (
                <select
                  aria-label={t('presentationCanvas.align')}
                  value=""
                  disabled={positionSaving}
                  onChange={(event) => {
                    const direction = event.target.value;
                    if (direction === 'horizontal' || direction === 'vertical') {
                      root.current
                        ?.querySelector<HTMLElement>('[data-testid="spatial-canvas"]')
                        ?.focus({ preventScroll: true });
                      void moveMany(
                        memberMoves(distributeSelection(unitBoxes, direction === 'vertical')),
                        t(
                          direction === 'vertical'
                            ? 'presentationCanvas.distributeVertical'
                            : 'presentationCanvas.distributeHorizontal',
                        ),
                      );
                      return;
                    }
                    const edge = alignmentEdges.find((v) => v === event.target.value);
                    if (edge) {
                      root.current
                        ?.querySelector<HTMLElement>('[data-testid="spatial-canvas"]')
                        ?.focus({ preventScroll: true });
                      void moveMany(
                        memberMoves(alignSelection(unitBoxes, edge)),
                        t('presentationCanvas.align'),
                      );
                    }
                  }}
                >
                  <option value="" disabled>
                    {t('presentationCanvas.align')}
                  </option>
                  {!grouped && units.size >= 3 && (
                    <>
                      <option value="horizontal">
                        {t('presentationCanvas.distributeHorizontal')}
                      </option>
                      <option value="vertical">{t('presentationCanvas.distributeVertical')}</option>
                    </>
                  )}
                  {alignmentEdges.map((edge) => (
                    <option key={edge} value={edge}>
                      {t(`presentationCanvas.align_${edge}`)}
                    </option>
                  ))}
                </select>
              )}
              {canMove && !multiple && selectedObject && source && (
                <>
                  {(['x', 'y'] as const).map((axis) => (
                    <label key={axis}>
                      {axis.toUpperCase()}
                      <InputNumber
                        controls={false}
                        disabled={positionSaving}
                        min={source[axis]}
                        precision={2}
                        size="small"
                        value={draft?.[axis] ?? selectedObject[axis]}
                        aria-label={t(
                          axis === 'x'
                            ? 'presentationCanvas.horizontal'
                            : 'presentationCanvas.vertical',
                        )}
                        max={
                          axis === 'x'
                            ? source.x + source.width - selectedObject.width
                            : source.y + source.height - selectedObject.height
                        }
                        onChange={(value) => {
                          if (value !== null)
                            move(
                              selectedObject.id,
                              axis === 'x' ? value : (draft?.x ?? selectedObject.x),
                              axis === 'y' ? value : (draft?.y ?? selectedObject.y),
                            );
                        }}
                      />
                    </label>
                  ))}
                </>
              )}
              {draft && (
                <>
                  <Button
                    disabled={invalidPosition || positionSaving || !canMove}
                    loading={positionSaving}
                    size="small"
                    type="primary"
                    onClick={() => void savePosition()}
                  >
                    {t('presentationCanvas.apply')}
                  </Button>
                  <Button
                    disabled={positionSaving}
                    size="small"
                    type="text"
                    onClick={() => {
                      setDraft(undefined);
                      setPositionFailed(false);
                    }}
                  >
                    {t('presentationCanvas.cancel')}
                  </Button>
                </>
              )}
              {(invalidPosition || positionFailed) && (
                <span role="alert">
                  {t(
                    positionFailed
                      ? 'presentationCanvas.saveFailed'
                      : 'presentationCanvas.positionError',
                  )}
                </span>
              )}
            </div>
          )}
        </div>

        {editing && onSendMessage && jobId && dataEditor && (
          <ChartDataEditor
            chart={editing}
            key={editing.id}
            onCancel={() => setDataEditor(undefined)}
            onSave={(series, requestId) =>
              onSendMessage(jobId, {
                chartDataPatch: {
                  blockId: editing.id,
                  expectedVersionId: dataEditor.versionId,
                  series,
                },
                content: t('presentationCanvas.editData'),
                requestId,
                target: { type: 'slide', slideNumber: dataEditor.page },
              })
            }
          />
        )}
        {editingTable && onSendMessage && jobId && dataEditor && (
          <TableDataEditor
            failureMessage={dataError}
            key={editingTable.id}
            table={editingTable}
            onCancel={() => setDataEditor(undefined)}
            onSave={(values, requestId) =>
              onSendMessage(jobId, {
                tableDataPatch: {
                  blockId: editingTable.id,
                  expectedVersionId: dataEditor.versionId,
                  ...values,
                },
                content: t('presentationCanvas.editTableData'),
                requestId,
                target: { type: 'slide', slideNumber: dataEditor.page },
              })
            }
          />
        )}
        {playback && (
          <DeckPlayback
            slides={playback.slides}
            startIndex={playback.startIndex}
            onExit={exitPlayback}
          />
        )}
        <nav
          aria-label="幻灯片舞台指挥条"
          className={styles.commandBar}
          data-testid="slide-command-bar"
        >
          <div
            data-page-navigation
            aria-label="幻灯片分页导航"
            className={`${glassSurface} ${styles.paginatorGroup}`}
          >
            <Tooltip title="上一页">
              <Button
                aria-label="上一页"
                className={styles.iconButton}
                disabled={currentIndex <= 0}
                icon={<Icon aria-hidden icon={ChevronLeft} size={22} />}
                type="text"
                onClick={onPrev}
              />
            </Tooltip>

            <span className={styles.pageCounter} data-testid="slide-page-counter">
              {pagePillText}
            </span>

            <Tooltip title="下一页">
              <Button
                aria-label="下一页"
                className={styles.iconButton}
                disabled={currentIndex >= totalSlides - 1}
                icon={<Icon aria-hidden icon={ChevronRight} size={22} />}
                type="text"
                onClick={onNext}
              />
            </Tooltip>
          </div>
          <CanvasZoomControl canvas={canvas} percent={zoom} />
        </nav>
      </section>
    );
  },
);

SlideFocusStage.displayName = 'SlideFocusStage';

export default SlideFocusStage;
