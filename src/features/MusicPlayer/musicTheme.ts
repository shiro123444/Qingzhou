import { createStaticStyles } from 'antd-style';

/** A restrained Qingzhou accent; the current album supplies the glass's ambient colors. */
export const { musicTheme } = createStaticStyles(({ css, cssVar }) => ({
  musicTheme: css`
    --music-accent: color-mix(in srgb, #729b97 58%, ${cssVar.colorText});
    --music-accent-soft: color-mix(in srgb, var(--music-accent) 9%, transparent);
    --music-cover-ink: var(--music-accent);
    --music-cover-bg:
      radial-gradient(ellipse at 0% 0%, rgb(255 255 255 / 45%), transparent 48%),
      radial-gradient(
        ellipse at 95% 100%,
        color-mix(in srgb, var(--music-accent) 12%, transparent),
        transparent 66%
      ),
      linear-gradient(
        150deg,
        color-mix(in srgb, var(--music-accent) 6%, transparent),
        var(--qz-glass-surface, ${cssVar.colorBgContainer})
      );
  `,
}));
