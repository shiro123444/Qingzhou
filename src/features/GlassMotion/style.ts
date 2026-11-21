import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  cord: css`
    touch-action: none;
    cursor: grab;

    position: relative;

    width: 42px;
    height: 90px;
    padding: 0;
    border: 0;

    color: ${cssVar.colorTextSecondary};

    background: transparent;

    &:active {
      cursor: grabbing;
    }

    &:focus-visible {
      border-radius: 20px;
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 3px;
    }

    svg {
      overflow: visible;
      width: 42px;
      height: 90px;
    }
  `,
  toolbar: css`
    position: relative;

    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    justify-content: center;

    width: fit-content;
    max-width: 100%;
    margin-block: 8px;
    margin-inline: auto;
    padding: 6px;
    border-radius: 22px;
  `,
  tool: css`
    cursor: pointer;

    position: relative;

    display: grid;
    place-items: center;

    width: 40px;
    height: 40px;
    padding: 0;
    border: 0;
    border-radius: 16px;

    color: ${cssVar.colorTextSecondary};

    background: transparent;

    &:hover,
    &[aria-pressed='true'] {
      color: ${cssVar.colorText};
    }

    &:disabled {
      cursor: default;
      opacity: 0.35;
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }

    svg {
      position: relative;
      z-index: 1;
    }
  `,
  plate: css`
    position: absolute;
    inset: 0;

    border-radius: inherit;

    border: 1px solid var(--qz-glass-border, ${cssVar.colorBorderSecondary});
    background: var(--qz-glass-selection, ${cssVar.colorFillSecondary});
    backdrop-filter: var(--qz-glass-filter);
    box-shadow: inset 0 1px 0 color-mix(in srgb, ${cssVar.colorBgElevated} 70%, transparent);
  `,
  tooltip: css`
    pointer-events: none;

    position: absolute;
    z-index: 4;
    inset-block-end: calc(100% + 12px);

    overflow: hidden;

    height: 34px;
    border-radius: 13px;

    color: ${cssVar.colorText};

    background: color-mix(in srgb, ${cssVar.colorBgElevated} 92%, transparent);
    box-shadow:
      0 5px 24px #0002,
      inset 0 1px 0 #ffffff60;

    span {
      display: grid;
      place-items: center;

      height: 100%;
      padding-inline: 12px;

      font-size: 12px;
      white-space: nowrap;
    }
  `,
  lens: css`
    pointer-events: none;

    position: absolute;
    z-index: 2;
    inset-block-start: 0;
    inset-inline-start: 0;

    overflow: hidden;

    width: 150px;
    height: 150px;
    border-radius: 50%;

    box-shadow:
      inset 0 1px 2px #ffffffb0,
      inset 0 -2px 6px #31595450,
      0 6px 24px #0002;

    &::after {
      content: '';

      position: absolute;
      inset: 0;

      border-radius: inherit;

      background: linear-gradient(135deg, #ffffff40, transparent 45%, #9bbab91a);
    }
  `,
  lensImage: css`
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;

    width: 100%;
    height: 100%;

    background-repeat: no-repeat;
  `,
  streaming: css`
    overflow-anchor: none;
    min-width: 0;

    [data-qz-stream-word] {
      display: inline-block;
      white-space: pre-wrap;
    }

    @media (prefers-reduced-motion: reduce) {
      [data-qz-stream-word] {
        transform: none !important;
        opacity: 1 !important;
        filter: none !important;
      }
    }
  `,
}));
