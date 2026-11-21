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

    /* The shader owns the silhouette; a second canvas clip darkens curved edges. */
    border-radius: 0;
  `,
  surface: css`
    isolation: isolate;

    &[data-qz-renderer='webgl2'] {
      /* Keep border widths for layout; the GL canvas covers the same border box. */
      border-color: transparent !important;
      background: transparent !important;
      backdrop-filter: none !important;
      box-shadow: none !important;

      &::before,
      &::after {
        opacity: 0 !important;
        backdrop-filter: none !important;
      }

      &:focus-visible {
        outline: 2px solid var(--qz-glass-tint, currentColor);
        outline-offset: 2px;
      }

      &[data-qz-glass='composer']:focus-within {
        outline: 1px solid color-mix(in srgb, var(--qz-glass-tint, currentColor) 30%, transparent);
        outline-offset: -1px;
      }
    }
  `,
}));
