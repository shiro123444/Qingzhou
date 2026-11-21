import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  empty: css`
    padding-block: 24px;
    padding-inline: 16px;

    font-size: 13px;
    color: ${cssVar.colorTextDescription};
    text-align: center;
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-block: 4px;
    padding-inline: 12px 4px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    font-size: 12px;
    font-weight: 600;
    color: ${cssVar.colorTextDescription};
    text-transform: uppercase;
    letter-spacing: 0.5px;

    @media (width <= 768px) {
      padding-block: 8px;
      padding-inline: 12px;
    }
  `,
  item: css`
    cursor: pointer;

    padding-block: 10px;
    padding-inline: 14px;
    border: 1px solid transparent;
    border-radius: ${cssVar.borderRadius};

    outline: none;

    transition: background 0.15s ease;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 1px;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  itemActive: css`
    border-color: ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorFillSecondary};
  `,
  list: css`
    overflow-y: auto;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;

    padding: 8px;

    @media (width <= 768px) {
      max-height: 120px;
      padding: 4px;
    }
  `,
  runId: css`
    font-family: monospace;
    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  sidebar: css`
    position: relative;
    z-index: 1;

    display: flex;
    flex-direction: column;

    width: 260px;
    overflow: hidden;
    flex: none;
    min-width: 0;
    max-width: 320px;
    height: 100%;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgContainer};

    transition: width var(--qz-panel-resize);

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }

    @media (width <= 768px) {
      width: 100%;
      min-width: 0;
      max-width: 100%;
      height: auto;
      border-block-end: 1px solid ${cssVar.colorBorderSecondary};
      border-inline-end: none;
    }
  `,
  sidebarCollapsed: css`
    width: 52px !important;

    @media (width <= 768px) {
      width: 100% !important;
      min-width: 0 !important;
      max-width: 100% !important;
      height: 52px !important;
    }
  `,
  collapsedBar: css`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding-block: 4px;
  `,
  time: css`
    font-size: 11px;
    color: ${cssVar.colorTextDescription};
  `,
}));
