import { ConfigProvider } from 'antd';
import { createStaticStyles } from 'antd-style';
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { panelResizeTiming } from '@/features/GlassMotion/panelMotion';
import { liquidGlass } from '@/styles/liquidGlass';

const styles = createStaticStyles(({ css, cssVar }) => ({
  host: css`
    --qz-editor-backplate: color-mix(in srgb, ${cssVar.colorBgElevated} 91%, transparent);
    pointer-events: none;
    position: fixed;
    inset: 0;
    z-index: 2000;
    > * {
      pointer-events: auto;
      z-index: var(--qz-layer, 1) !important;
    }
    > .ant-modal-root,
    > .ant-drawer-root {
      position: relative;
    }
    .ant-popover-container,
    .ant-popover-inner,
    .ant-tooltip-container,
    .ant-tooltip-inner,
    .ant-dropdown-menu,
    .ant-select-dropdown,
    .ant-modal-container,
    .ant-modal-content,
    .ant-popconfirm-container {
      border: 1px solid var(--qz-glass-border);
      border-radius: var(--qz-glass-radius-panel);
      background: var(--qz-glass-sheen), var(--qz-editor-backplate);
      -webkit-backdrop-filter: var(--qz-glass-filter);
      backdrop-filter: var(--qz-glass-filter);
      box-shadow: var(--qz-glass-shadow);
    }
    .ant-tooltip-container,
    .ant-tooltip-inner {
      color: ${cssVar.colorText};
      border-radius: 12px;
    }
    .ant-modal-header,
    .ant-modal-footer {
      background: transparent;
    }
    .ant-input,
    .ant-select,
    .ant-btn,
    .ant-input-number {
      background-color: var(--qz-glass-surface);
    }
    .ant-btn-primary {
      color: ${cssVar.colorText};
      border-color: var(--qz-glass-tint);
    }
    .ant-dropdown-menu-item,
    .ant-select-item {
      border-radius: 10px;
    }
    .ant-dropdown-menu-item:hover,
    .ant-select-item-option-active {
      background: var(--qz-glass-selection) !important;
    }
    :is(.ant-popover, .ant-dropdown, .ant-select-dropdown, .ant-modal, .ant-tooltip):is(
      [class*='-appear-active'],
      [class*='-enter-active']
    ) {
      animation: qzStudioGlassIn ${panelResizeTiming} both;
    }
    :is(
      .ant-popover,
      .ant-dropdown,
      .ant-select-dropdown,
      .ant-modal,
      .ant-tooltip
    )[class*='-leave-active'] {
      animation: qzStudioGlassOut ${panelResizeTiming} both;
    }
    @keyframes qzStudioGlassOut {
      from {
        scale: 1;
        opacity: 1;
      }
      to {
        scale: 0.96;
        opacity: 0;
      }
    }
    @keyframes qzStudioGlassIn {
      from {
        scale: 0.96;
        opacity: 0.3;
      }
      to {
        scale: 1;
        opacity: 1;
      }
    }
    @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
      --qz-editor-backplate: ${cssVar.colorBgElevated};
    }
    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        animation-duration: 0s !important;
        transition-duration: 0s !important;
      }
    }
  `,
}));

/** A single themed portal above the workspace (including its focus-mode portal).
 * Give each opening a new stacking order, including reopened cached dropdowns.
 * Keep modal mask, focus trap and content together inside their original root. */
export function StudioGlass({ children }: { children: ReactNode }) {
  const host = useRef<HTMLDivElement | null>(null);
  const observer = useRef<MutationObserver | null>(null);
  const getContainer = useCallback((trigger?: HTMLElement) => {
    if (host.current?.isConnected) return host.current;
    const el = document.createElement('div');
    el.className = liquidGlass + ' ' + styles.host;
    el.dataset.studioLayers = '';
    (trigger?.closest('.ant-app') ?? document.querySelector('.ant-app') ?? document.body).append(
      el,
    );
    const shown = new WeakSet<Element>();
    let order = 0;
    const update = () => {
      for (const layer of Array.from(el.children)) {
        if (!(layer instanceof HTMLElement)) continue;
        const wrapper = layer.querySelector<HTMLElement>('.ant-modal-wrap');
        if (
          layer.hidden ||
          layer.style.display === 'none' ||
          wrapper?.style.display === 'none' ||
          /(?:^|\s)\S+-hidden(?:\s|$)/u.test(layer.className)
        ) {
          shown.delete(layer);
          continue;
        }
        if (!shown.has(layer)) {
          shown.add(layer);
          layer.style.setProperty('--qz-layer', String(++order));
        }
      }
    };
    observer.current?.disconnect();
    observer.current = new MutationObserver(update);
    observer.current.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
    host.current = el;
    return el;
  }, []);
  useEffect(
    () => () => {
      observer.current?.disconnect();
      host.current?.remove();
      host.current = null;
    },
    [],
  );
  return (
    <ConfigProvider button={{ autoInsertSpace: false }} getPopupContainer={getContainer}>
      {children}
    </ConfigProvider>
  );
}
