import { createStaticStyles } from 'antd-style';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { ArtifactSnapshot } from '../../../../packages/runtime-contracts/src/index';

const styles = createStaticStyles(({ css }) => ({
  stage: css`
    position: fixed;
    z-index: 10000;
    inset: 0;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    width: 100%;
    height: 100%;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
      env(safe-area-inset-left);
    box-sizing: border-box;
    overflow: hidden;
    color: #f6f7f7;
    background: #101213;
    outline: none;
  `,
  slide: css`
    display: grid;
    place-items: center;
    min-height: 0;
    touch-action: pan-y pinch-zoom;
    img {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 0;
      object-fit: contain;
      user-select: none;
    }
  `,
  controls: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: 4px;
    min-height: 48px;
    padding: 2px 8px;
    overflow: hidden;
    color-scheme: dark;
    button {
      display: grid;
      place-items: center;
      min-width: 44px;
      min-height: 44px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: inherit;
      cursor: pointer;
      &:disabled {
        opacity: 0.3;
        cursor: default;
      }
      &:enabled:hover {
        background: #ffffff24;
      }
      &:focus-visible {
        outline: 2px solid currentColor;
        outline-offset: -4px;
      }
    }
  `,
  pager: css`
    display: flex;
    grid-column: 2;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  `,
  exit: css`
    justify-self: end;
  `,
}));

export function DeckPlayback({
  slides,
  startIndex,
  onExit,
}: {
  slides: ArtifactSnapshot[];
  startIndex: number;
  onExit: () => void;
}) {
  const { t } = useTranslation('common');
  const [index, setIndex] = useState(startIndex);
  const stage = useRef<HTMLDivElement>(null);
  const touch = useRef<{ id: number; x: number; y: number }>(undefined);
  const last = slides.length - 1;
  const page = Math.max(0, Math.min(index, last));
  const slide = slides[page];
  const next = () => setIndex((value) => Math.min(value + 1, last));
  const previous = () => setIndex((value) => Math.max(value - 1, 0));

  useLayoutEffect(() => {
    const host = stage.current;
    if (!host) return;
    const previousFocus = document.activeElement;
    const siblings = [...document.body.children].filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node !== host && !node.inert,
    );
    siblings.forEach((node) => {
      node.inert = true;
    });
    host.focus({ preventScroll: true });
    let wasFullscreen = false;
    const changed = () => {
      if (document.fullscreenElement === host) wasFullscreen = true;
      else if (wasFullscreen) onExit();
    };
    document.addEventListener('fullscreenchange', changed);
    // Embedded editors and mobile browsers can deny native fullscreen. The
    // same portal already fills the app window and supports every control.
    if (!document.fullscreenElement && document.fullscreenEnabled) {
      void host.requestFullscreen?.().catch(() => {});
    }
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      if (document.fullscreenElement === host) void document.exitFullscreen?.().catch(() => {});
      siblings.forEach((node) => {
        node.inert = false;
      });
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, [onExit]);

  // Reaching the first/last slide can disable the focused navigation button.
  useLayoutEffect(() => {
    if (
      !stage.current?.contains(document.activeElement) ||
      document.activeElement?.matches(':disabled')
    )
      stage.current?.focus({ preventScroll: true });
  }, [page]);

  return createPortal(
    <div
      aria-label={t('presentationCanvas.present')}
      aria-modal="true"
      className={styles.stage}
      data-testid="deck-playback"
      ref={stage}
      role="dialog"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'Tab') {
          const buttons = [...event.currentTarget.querySelectorAll('button')].filter(
            (button) => !button.disabled,
          );
          const focus = document.activeElement;
          if (event.shiftKey && (focus === event.currentTarget || focus === buttons[0])) {
            event.preventDefault();
            buttons.at(-1)?.focus();
          } else if (!event.shiftKey && focus === buttons.at(-1)) {
            event.preventDefault();
            buttons[0]?.focus();
          }
          return;
        }
        switch (event.key) {
          case 'Escape':
            onExit();
            break;
          case 'Home':
            setIndex(0);
            break;
          case 'End':
            setIndex(last);
            break;
          case 'ArrowRight':
          case 'PageDown':
            next();
            break;
          case 'ArrowLeft':
          case 'PageUp':
            previous();
            break;
          case ' ':
            if (event.target !== event.currentTarget) return;
            next();
            break;
          default:
            return;
        }
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div
        className={styles.slide}
        onPointerDown={(event) => {
          if (event.pointerType !== 'touch') return;
          if (!event.isPrimary) {
            touch.current = undefined;
            return;
          }
          touch.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        }}
        onPointerCancel={() => {
          touch.current = undefined;
        }}
        onPointerUp={(event) => {
          const start = touch.current;
          touch.current = undefined;
          if (start?.id !== event.pointerId || !start) return;
          const dx = event.clientX - start.x,
            dy = event.clientY - start.y;
          if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? next : previous)();
        }}
      >
        {slide?.uri ? (
          <img
            alt={String(slide.metadata?.title ?? slide.name ?? '')}
            draggable={false}
            src={slide.uri}
          />
        ) : (
          <span>{t('presentationCanvas.playbackUnavailable')}</span>
        )}
      </div>
      <nav aria-label={t('presentationCanvas.present')} className={styles.controls}>
        <div className={styles.pager}>
          <button
            aria-label={t('presentationCanvas.previous')}
            disabled={page <= 0}
            onClick={previous}
            type="button"
          >
            <ChevronLeft aria-hidden size={20} />
          </button>
          <span aria-live="polite" aria-atomic="true">
            {page + 1} / {slides.length}
          </span>
          <button
            aria-label={t('presentationCanvas.next')}
            disabled={page >= last}
            onClick={next}
            type="button"
          >
            <ChevronRight aria-hidden size={20} />
          </button>
        </div>
        <button
          aria-label={t('presentationCanvas.exitPlayback')}
          className={styles.exit}
          onClick={onExit}
          title={t('presentationCanvas.exitPlayback')}
          type="button"
        >
          <X aria-hidden size={20} />
        </button>
      </nav>
    </div>,
    document.body,
  );
}
