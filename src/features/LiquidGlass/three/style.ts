import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css }) => ({
  canvas: css`
    pointer-events: none;
    user-select: none;

    position: absolute;
    z-index: -1;
    inset: 0;

    display: block;

    width: 100%;
    height: 100%;
    border-radius: inherit;
  `,
  surface: css`
    isolation: isolate;

    &[data-qz-renderer='webgl2'] {
      background: transparent !important;
      backdrop-filter: none !important;

      &::before,
      &::after {
        opacity: 0 !important;
        backdrop-filter: none !important;
      }
    }
  `,
}));
