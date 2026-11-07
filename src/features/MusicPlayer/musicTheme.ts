import { createStaticStyles } from 'antd-style';

/** Qingzhou's water-green accent on the shared application surfaces, in either theme. */
export const { musicTheme } = createStaticStyles(({ css, cssVar }) => ({
  musicTheme: css`
    --music-accent: color-mix(in srgb, #4da9a4 70%, ${cssVar.colorText});
    --music-accent-soft: color-mix(in srgb, var(--music-accent) 10%, ${cssVar.colorBgContainer});
    --music-cover-ink: var(--music-accent);
    --music-cover-bg: linear-gradient(
      145deg,
      color-mix(in srgb, #4da9a4 18%, ${cssVar.colorBgContainer}),
      color-mix(in srgb, #78a8b8 9%, ${cssVar.colorBgContainer}) 65%,
      color-mix(in srgb, #aabca1 18%, ${cssVar.colorBgContainer})
    );
  `,
}));
