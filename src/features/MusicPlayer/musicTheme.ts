import { createStaticStyles } from 'antd-style';

/** Qingzhou's water-green accent on the shared application surfaces, in either theme. */
export const { musicTheme } = createStaticStyles(({ css, cssVar }) => ({
  musicTheme: css`
    --music-accent: color-mix(in srgb, #4da9a4 70%, ${cssVar.colorText});
    --music-accent-soft: color-mix(in srgb, var(--music-accent) 12%, transparent);
    --music-cover-ink: var(--music-accent);
    --music-cover-bg:
      radial-gradient(ellipse at 0% 0%, rgb(255 255 255 / 45%), transparent 48%),
      radial-gradient(
        ellipse at 95% 100%,
        color-mix(in srgb, var(--music-accent) 34%, transparent),
        transparent 66%
      ),
      linear-gradient(
        150deg,
        color-mix(in srgb, var(--music-accent) 15%, transparent),
        var(--qz-glass-surface, ${cssVar.colorBgContainer})
      );
  `,
}));
