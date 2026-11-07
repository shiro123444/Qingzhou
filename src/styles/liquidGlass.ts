import { createStaticStyles } from 'antd-style';

/** Shared material values only: safe to attach to a floating control or isolated preview. */
export const { liquidGlass, liquidGlassBackdrop, liquidGlassOverlays, glassSurface } =
  createStaticStyles(({ css, cssVar }) => ({
    liquidGlass: css`
      --qz-glass-surface: color-mix(in srgb, ${cssVar.colorBgElevated} 24%, transparent);
      --qz-glass-strong: color-mix(in srgb, ${cssVar.colorBgElevated} 66%, transparent);
      --qz-glass-border: color-mix(in srgb, ${cssVar.colorText} 12%, transparent);
      --qz-glass-highlight: rgb(255 255 255 / 42%);
      --qz-glass-filter: blur(24px) saturate(1.35);
      --qz-glass-tint: color-mix(in srgb, #4da9a4 72%, ${cssVar.colorText});
      --qz-glass-sheen: linear-gradient(
        135deg,
        rgb(255 255 255 / 14%),
        transparent 34%,
        transparent 70%,
        rgb(15 45 52 / 3%)
      );
      --qz-glass-shadow:
        inset 0 1px 0 var(--qz-glass-highlight), inset 0 -1px 0 rgb(15 45 52 / 5%),
        0 12px 32px rgb(16 42 49 / 8%);

      @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        --qz-glass-surface: ${cssVar.colorBgContainer};
        --qz-glass-strong: ${cssVar.colorBgElevated};
        --qz-glass-filter: none;
        --qz-glass-sheen: none;
      }

      @media (prefers-reduced-transparency: reduce) {
        --qz-glass-surface: ${cssVar.colorBgContainer};
        --qz-glass-strong: ${cssVar.colorBgElevated};
        --qz-glass-border: ${cssVar.colorBorder};
        --qz-glass-filter: none;
        --qz-glass-sheen: none;
        --qz-glass-shadow: none;
      }

      @media (prefers-contrast: more) {
        --qz-glass-surface: ${cssVar.colorBgContainer};
        --qz-glass-strong: ${cssVar.colorBgElevated};
        --qz-glass-border: ${cssVar.colorTextSecondary};
        --qz-glass-filter: none;
        --qz-glass-sheen: none;
      }
    `,
    liquidGlassOverlays: css`
      /* Base UI exposes placement on actual floating panels, not their full-screen portals. */
      [role='menu'][data-side],
      [role='dialog'][data-side],
      [role='dialog'][aria-modal='true'][data-open]:not([data-side]) > div:only-child {
        border-color: var(--qz-glass-border);
        background: var(--qz-glass-sheen), var(--qz-glass-strong);
        backdrop-filter: var(--qz-glass-filter);
        box-shadow: var(--qz-glass-shadow);
      }
    `,
    liquidGlassBackdrop: css`
      background:
        radial-gradient(
          ellipse at 4% 12%,
          color-mix(in srgb, #77c7bd 22%, transparent),
          transparent 48%
        ),
        radial-gradient(
          ellipse at 92% 25%,
          color-mix(in srgb, #85a8c4 18%, transparent),
          transparent 48%
        ),
        radial-gradient(
          ellipse at 55% 100%,
          color-mix(in srgb, #bbcab1 14%, transparent),
          transparent 52%
        ),
        ${cssVar.colorBgLayout};

      @media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
        background: ${cssVar.colorBgLayout};
      }
    `,
    // Filter the backplate, never the shell: a filtered ancestor would trap fixed overlays.
    glassSurface: css`
      isolation: isolate;
      position: relative;
      background: transparent;

      &::before {
        pointer-events: none;
        content: '';

        position: absolute;
        z-index: -1;
        inset: 0;

        border-radius: inherit;

        background:
          var(--qz-glass-sheen, linear-gradient(135deg, rgb(255 255 255 / 10%), transparent 45%)),
          var(--qz-glass-surface, ${cssVar.colorBgContainer});
        backdrop-filter: var(--qz-glass-filter, none);
        box-shadow: var(--qz-glass-shadow, none);
      }
    `,
  }));
