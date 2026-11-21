import { Popover } from 'antd';
import { createStaticStyles } from 'antd-style';
import { Check, ChevronDown, Minus, Plus } from 'lucide-react';
import { type RefObject, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CanvasControls } from '@/features/SpatialCanvas';
import { glassSurface } from '@/styles/liquidGlass';

const styles = createStaticStyles(({ css, cssVar }) => ({
  trigger: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 36px;
    margin-inline-start: auto;
    padding: 4px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 999px;
    color: ${cssVar.colorText};
    font: inherit;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }
  `,
  panel: css`
    display: grid;
    gap: 4px;
    width: 198px;
    color: ${cssVar.colorText};
    button {
      border: 0;
      border-radius: 6px;
      color: inherit;
      background: transparent;
      font: inherit;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      &:hover {
        background: ${cssVar.colorFillTertiary};
      }
    }
    button:focus-visible,
    input:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -1px;
    }
  `,
  entry: css`
    display: flex;
    gap: 4px;
    align-items: center;
    padding-block-end: 8px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
    button {
      display: grid;
      flex: 0 0 30px;
      place-items: center;
      height: 30px;
    }
    label {
      display: flex;
      flex: 1;
      align-items: center;
      min-width: 0;
      padding-inline: 4px 7px;
      border: 1px solid ${cssVar.colorBorder};
      border-radius: 6px;
      color: ${cssVar.colorTextSecondary};
    }
    input {
      width: 100%;
      min-width: 0;
      min-height: 30px;
      padding: 0 4px;
      border: 0;
      color: ${cssVar.colorText};
      background: transparent;
      font: inherit;
      font-variant-numeric: tabular-nums;
      appearance: textfield;
      &::-webkit-inner-spin-button {
        appearance: none;
      }
    }
  `,
  fit: css`
    padding: 6px 8px;
    text-align: start;
  `,
  presets: css`
    display: flex;
    gap: 4px;
    padding-block-start: 6px;
    border-top: 1px solid ${cssVar.colorBorderSecondary};
    button {
      flex: 1;
      min-height: 32px;
    }
    [aria-pressed='true'] {
      background: ${cssVar.colorFillTertiary};
    }
  `,
}));

export function CanvasZoomControl({
  canvas,
  percent,
}: {
  canvas: RefObject<CanvasControls | null>;
  percent?: number;
}) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [entry, setEntry] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const openedWithKeyboard = useRef(false);
  const id = useId();
  const changeOpen = (next: boolean) => {
    setEntry(undefined);
    setOpen(next);
  };
  const finish = (apply: () => void) => {
    apply();
    changeOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  const display = percent === undefined ? '—' : String(percent);
  const label = t('presentationCanvas.zoom');
  return (
    <Popover
      arrow={false}
      destroyOnHidden
      open={open}
      placement="topRight"
      trigger="click"
      afterOpenChange={(shown) => {
        if (shown && openedWithKeyboard.current) field.current?.focus();
      }}
      onOpenChange={changeOpen}
      content={
        <div
          id={id}
          role="dialog"
          aria-label={label}
          className={styles.panel}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              changeOpen(false);
              trigger.current?.focus({ preventScroll: true });
            }
          }}
        >
          <form
            className={styles.entry}
            onSubmit={(event) => {
              event.preventDefault();
              const value = Number(entry ?? percent);
              if (Number.isFinite(value) && value >= 0.5 && value <= 800)
                finish(() => canvas.current?.zoomTo(value / 100));
            }}
          >
            <button
              type="button"
              aria-label={t('presentationCanvas.zoomOut')}
              onClick={() => {
                setEntry(undefined);
                canvas.current?.zoomBy(0.8);
              }}
            >
              <Minus size={16} />
            </button>
            <label>
              <input
                aria-label={label}
                ref={field}
                type="number"
                min={0.5}
                max={800}
                step="any"
                required
                value={entry ?? percent ?? ''}
                onChange={(event) => setEntry(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
              />
              %
            </label>
            {entry !== undefined && (
              <button type="submit" aria-label={t('presentationCanvas.apply')}>
                <Check size={16} />
              </button>
            )}
            <button
              type="button"
              aria-label={t('presentationCanvas.zoomIn')}
              onClick={() => {
                setEntry(undefined);
                canvas.current?.zoomBy(1.25);
              }}
            >
              <Plus size={16} />
            </button>
          </form>
          <button
            className={styles.fit}
            type="button"
            onClick={() => finish(() => canvas.current?.fitPage())}
          >
            {t('presentationCanvas.fit')}
          </button>
          <button
            className={styles.fit}
            type="button"
            onClick={() => finish(() => canvas.current?.fitAll())}
          >
            {t('presentationCanvas.fitAll')}
          </button>
          <div className={styles.presets}>
            {[50, 100, 200].map((preset) => (
              <button
                aria-pressed={percent === preset}
                key={preset}
                type="button"
                onClick={() => finish(() => canvas.current?.zoomTo(preset / 100))}
              >
                {preset}%
              </button>
            ))}
          </div>
        </div>
      }
    >
      <button
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label} ${display}%`}
        className={`${glassSurface} ${styles.trigger}`}
        onClick={(event) => {
          openedWithKeyboard.current = event.detail === 0;
        }}
        onKeyDown={(event) => {
          if (open && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            changeOpen(false);
          }
        }}
        data-testid="canvas-zoom"
        disabled={percent === undefined}
        ref={trigger}
        type="button"
      >
        {display}% <ChevronDown aria-hidden size={13} />
      </button>
    </Popover>
  );
}
