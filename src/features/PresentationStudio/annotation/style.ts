import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  overlay: css`
    position: absolute;
    z-index: 5;
    inset: 0;
    overflow: hidden;
    touch-action: none;
    cursor: crosshair;
    outline-offset: -2px;
    &:focus-visible {
      outline: 2px dashed ${cssVar.colorPrimary};
    }
  `,
  box: css`
    position: absolute;
    z-index: 2;
    min-width: 2px;
    min-height: 2px;
    &[data-preview='true'] {
      border-style: dashed;
      background: transparent;
    }
  `,
  region: css`
    position: absolute;
    box-sizing: border-box;
    pointer-events: none;
    border: 1px dashed ${cssVar.colorPrimary};
    background: color-mix(in srgb, ${cssVar.colorPrimary} 5%, transparent);
  `,
  dock: css`
    display: grid;
    gap: 6px;
    min-width: 0;
    margin: 0 8px 6px;
    padding: 8px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 16px;
    color: ${cssVar.colorText};
    font-size: 13px;
    button {
      flex: 0 0 auto;
      display: inline-grid;
      place-items: center;
      width: 32px;
      height: 32px;
      border: 0;
      border-radius: 50%;
      color: inherit;
      background: transparent;
      cursor: pointer;
      &:hover {
        background: ${cssVar.colorFillTertiary};
      }
      &:disabled {
        opacity: 0.45;
        cursor: default;
      }
    }
    button:focus-visible,
    input:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -2px;
    }
    [role='alert'] {
      color: ${cssVar.colorError};
    }
    @media (pointer: coarse) {
      button {
        min-width: 40px;
        min-height: 40px;
      }
    }
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    span:first-child {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  dataAction: css`
    && {
      width: auto;
      padding-inline: 12px;
      border-radius: 8px;
      color: ${cssVar.colorPrimaryText};
      background: ${cssVar.colorPrimaryBg};
    }
  `,
  input: css`
    flex: 1;
    min-width: 0;
    min-height: 36px;
    padding-inline: 9px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    font: inherit;
    color: ${cssVar.colorText};
    background: var(--qz-glass-surface, transparent);
  `,
}));
