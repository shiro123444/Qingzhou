import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  container: css`
    display: flex;
    flex-direction: column;
    gap: 10px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorBgContainer};

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  empty: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: center;

    padding-block: 24px;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  deleteButton: css`
    && {
      flex: none;

      width: 32px;
      min-width: 32px;
      height: 32px;
      border-radius: 50%;

      color: ${cssVar.colorTextDescription};
    }

    &&:hover {
      color: ${cssVar.colorError};
      background: ${cssVar.colorErrorBg};
    }
  `,
  item: css`
    cursor: pointer;

    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;

    width: 100%;
    min-width: 0;
    padding-block: 10px;
    padding-inline: 12px;
    border: 1px solid transparent;
    border-radius: ${cssVar.borderRadiusSM};

    font: inherit;
    color: ${cssVar.colorText};
    text-align: start;

    background: transparent;
    outline: none;

    transition:
      background 0.15s ease,
      border-color 0.15s ease;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }

    &:focus-visible {
      border-color: ${cssVar.colorPrimary};
      outline: none;
    }

    &[data-selected='true'] {
      border-color: ${cssVar.colorBorder};
      background: ${cssVar.colorFillSecondary};
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none !important;
      animation: none !important;
    }
  `,
  itemId: css`
    font-family: monospace;
    font-size: 11px;
  `,
  itemRow: css`
    display: flex;
    gap: 4px;
    align-items: center;
  `,
  itemMeta: css`
    display: flex;
    gap: 10px;
    align-items: center;

    font-size: 11px;
    color: ${cssVar.colorTextDescription};
  `,
  itemTitle: css`
    font-size: 13px;
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: 6px;

    margin: 0;
    padding: 0;

    list-style: none;
  `,
  srOnly: css`
    position: absolute;

    overflow: hidden;

    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;

    white-space: nowrap;

    clip: rect(0, 0, 0, 0);
  `,
  title: css`
    font-size: 13px;
    font-weight: 600;
  `,
}));
